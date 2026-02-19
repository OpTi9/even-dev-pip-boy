// vite.config.ts
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv } from 'vite'
import type { Alias, Plugin } from 'vite'
import { loadAppPlugins } from './vite-plugins'

const G2_SESSION_TTL_MS = 15 * 60 * 1000
const G2_SESSION_MAX_RESPONSES = 20

type G2SessionRecord = {
  token: string
  lastSeenAt: number
  responses: string[]
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(message)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise<Buffer>((resolveBody, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function getBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return ''
  }

  return header.slice(7).trim()
}

function secureCompare(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value)
  const expectedBytes = Buffer.from(expected)
  if (valueBytes.length !== expectedBytes.length) {
    return false
  }

  return timingSafeEqual(valueBytes, expectedBytes)
}

function normalizeG2Text(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r/g, '')
    .trim()
}

function g2BridgePlugin(env: Record<string, string>): Plugin {
  return {
    name: 'g2-bridge',
    configureServer(server) {
      const g2Sessions = new Map<string, G2SessionRecord>()

      const cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - G2_SESSION_TTL_MS
        for (const [sessionId, record] of g2Sessions.entries()) {
          if (record.lastSeenAt < cutoff) {
            g2Sessions.delete(sessionId)
          }
        }
      }, 60_000)
      cleanupTimer.unref()

      server.middlewares.use('/__g2_session', async (req, res) => {
        if (req.method !== 'POST') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

        const defaultWorkingDirectory = (
          env.G2_DEFAULT_WORKING_DIRECTORY?.trim() ||
          process.env.G2_DEFAULT_WORKING_DIRECTORY?.trim() ||
          '/home/aza/Desktop'
        )
        const sessionId = randomUUID()
        const sessionToken = randomBytes(24).toString('hex')
        g2Sessions.set(sessionId, {
          token: sessionToken,
          lastSeenAt: Date.now(),
          responses: [],
        })

        sendJson(res, 200, {
          sessionId,
          sessionToken,
          defaultWorkingDirectory,
        })
      })

      server.middlewares.use('/__groq_transcribe', async (req, res) => {
        if (req.method !== 'POST') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

        const groqApiKey = env.GROQ_API_KEY?.trim() || process.env.GROQ_API_KEY?.trim() || ''
        if (!groqApiKey) {
          sendText(res, 500, 'GROQ_API_KEY is not configured')
          return
        }

        const contentType = typeof req.headers['content-type'] === 'string'
          ? req.headers['content-type']
          : ''

        if (!contentType) {
          sendText(res, 400, 'Missing Content-Type')
          return
        }

        try {
          const body = await readRequestBody(req)
          const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${groqApiKey}`,
              'content-type': contentType,
            },
            body,
          })

          const upstreamBody = await upstream.text()
          res.statusCode = upstream.status
          res.setHeader(
            'content-type',
            upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          )
          res.end(upstreamBody)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendText(res, 502, `Groq transcription request failed: ${message}`)
        }
      })

      server.middlewares.use('/__g2_send', async (req, res) => {
        if (req.method !== 'POST') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

        const webhookSecret = env.WEBHOOK_API_SECRET?.trim() || process.env.WEBHOOK_API_SECRET?.trim() || ''
        if (!webhookSecret) {
          sendText(res, 500, 'WEBHOOK_API_SECRET is not configured')
          return
        }

        try {
          const rawBody = await readRequestBody(req)
          const payload = JSON.parse(rawBody.toString('utf-8')) as {
            text?: unknown
            sessionId?: unknown
            sessionToken?: unknown
            workingDirectory?: unknown
          }

          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          const sessionToken = typeof payload.sessionToken === 'string'
            ? payload.sessionToken.trim()
            : ''
          const workingDirectory = typeof payload.workingDirectory === 'string'
            ? payload.workingDirectory.trim()
            : ''

          if (!text || !sessionId || !sessionToken) {
            sendText(res, 400, 'Missing required fields: text, sessionId, sessionToken')
            return
          }

          const session = g2Sessions.get(sessionId)
          if (!session || !secureCompare(sessionToken, session.token)) {
            sendText(res, 401, 'Invalid session credentials')
            return
          }
          session.lastSeenAt = Date.now()

          const botPort = env.G2_BOT_PORT?.trim() || process.env.G2_BOT_PORT?.trim() || '8080'
          const upstream = await fetch(`http://localhost:${botPort}/webhooks/even-g2`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${webhookSecret}`,
              'content-type': 'application/json',
              'x-event-type': 'voice_prompt',
            },
            body: JSON.stringify({
              text,
              session_id: sessionId,
              source: 'even-g2',
              ...(workingDirectory ? { working_directory: workingDirectory } : {}),
            }),
          })

          const upstreamBody = await upstream.text()
          if (!upstream.ok) {
            sendText(
              res,
              upstream.status,
              upstreamBody || `Webhook rejected request (${upstream.status})`,
            )
            return
          }

          sendJson(res, 200, { ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendText(res, 502, `Failed to forward request to bot: ${message}`)
        }
      })

      server.middlewares.use('/__g2_receive', async (req, res) => {
        if (req.method !== 'POST') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

        const bridgeSecret = env.EVEN_G2_BRIDGE_SECRET?.trim() || process.env.EVEN_G2_BRIDGE_SECRET?.trim() || ''
        if (!bridgeSecret) {
          sendText(res, 500, 'EVEN_G2_BRIDGE_SECRET is not configured')
          return
        }

        const token = getBearerToken(req)
        if (!token || !secureCompare(token, bridgeSecret)) {
          sendText(res, 401, 'Invalid authorization token')
          return
        }

        try {
          const rawBody = await readRequestBody(req)
          const payload = JSON.parse(rawBody.toString('utf-8')) as {
            sessionId?: unknown
            text?: unknown
          }

          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          const text = typeof payload.text === 'string' ? normalizeG2Text(payload.text) : ''
          if (!sessionId || !text) {
            sendText(res, 400, 'Missing required fields: sessionId, text')
            return
          }

          const session = g2Sessions.get(sessionId)
          if (!session) {
            sendText(res, 404, 'Unknown session')
            return
          }

          session.responses.push(text)
          if (session.responses.length > G2_SESSION_MAX_RESPONSES) {
            session.responses.splice(0, session.responses.length - G2_SESSION_MAX_RESPONSES)
          }
          session.lastSeenAt = Date.now()

          sendJson(res, 200, { ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendText(res, 400, `Invalid JSON payload: ${message}`)
        }
      })

      server.middlewares.use('/__g2_poll', (req, res) => {
        if (req.method !== 'GET') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

        const parsed = new URL(req.url ?? '', 'http://localhost')
        const sessionId = parsed.searchParams.get('sessionId')?.trim() ?? ''
        if (!sessionId) {
          sendText(res, 400, 'Missing sessionId query parameter')
          return
        }

        const session = g2Sessions.get(sessionId)
        if (!session) {
          sendText(res, 404, 'Unknown session')
          return
        }

        const sessionToken = typeof req.headers['x-g2-session-token'] === 'string'
          ? req.headers['x-g2-session-token'].trim()
          : ''

        if (!sessionToken || !secureCompare(sessionToken, session.token)) {
          sendText(res, 401, 'Invalid session token')
          return
        }

        session.lastSeenAt = Date.now()
        const text = session.responses.shift() ?? null
        sendJson(res, 200, { text })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// External app registry (apps.json + APP_PATH env override)
// ---------------------------------------------------------------------------

const APPS_CACHE_DIR = resolve('.apps-cache')

function isGitUrl(value: string): boolean {
  const base = value.split('#')[0] ?? ''
  return base.startsWith('https://') || base.startsWith('git@')
}

function resolveGitEntry(name: string, value: string): string {
  const [, subpath] = value.split('#')
  const base = resolve(APPS_CACHE_DIR, name)
  return subpath ? resolve(base, subpath) : base
}

function loadExternalApps(): Record<string, string> {
  const apps: Record<string, string> = {}

  if (existsSync('apps.json')) {
    const raw = JSON.parse(readFileSync('apps.json', 'utf8')) as Record<string, string>
    for (const [name, value] of Object.entries(raw)) {
      apps[name] = isGitUrl(value) ? resolveGitEntry(name, value) : resolve(value)
    }
  }

  const appName = process.env.APP_NAME ?? process.env.VITE_APP_NAME ?? ''
  const appPath = process.env.APP_PATH ?? ''
  if (appName && appPath) {
    apps[appName] = resolve(appPath)
  }

  return apps
}

const externalApps = loadExternalApps()

// ---------------------------------------------------------------------------
// External app HTML plugin: serve the external app's own index.html
// ---------------------------------------------------------------------------

function externalAppHtmlPlugin(): Plugin | null {
  const selectedApp = process.env.VITE_APP_NAME ?? process.env.APP_NAME ?? ''
  const appDir = externalApps[selectedApp]
  if (!appDir) return null

  const absAppDir = resolve(appDir)
  const htmlPath = resolve(absAppDir, 'index.html')
  if (!existsSync(htmlPath)) return null

  return {
    name: 'external-app-html',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (url !== '/' && url !== '/index.html') {
          next()
          return
        }

        try {
          let html = readFileSync(htmlPath, 'utf-8')
          // Rewrite local absolute paths to /@fs/ so Vite resolves them
          // from the external app's directory instead of even-dev's root.
          html = html.replace(
            /(src|href)=(['"])\/(?!\/|@|http)/g,
            `$1=$2/@fs/${absAppDir}/`,
          )
          html = await server.transformIndexHtml(url, html)
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html')
          res.end(html)
        } catch (error) {
          next(error)
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Vite aliases + fs.allow from external apps
// ---------------------------------------------------------------------------

function buildAliases(): Alias[] {
  return Object.entries(externalApps).map(([name, absPath]) => ({
    find: `apps/${name}`,
    replacement: absPath,
  }))
}

function buildFsAllow(): string[] {
  const dirs = new Set<string>()
  for (const absPath of Object.values(externalApps)) {
    dirs.add(absPath)
    dirs.add(resolve(absPath, '..'))
  }
  return [...dirs]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? process.env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  return {
    plugins: [
      externalAppHtmlPlugin(),
      g2BridgePlugin(env),
      ...loadAppPlugins({ externalApps }),
    ].filter((p): p is Plugin => p !== null),
    resolve: {
      alias: buildAliases(),
    },
    server: {
      host: env.VITE_HOST || process.env.VITE_HOST || true,
      port: 5173,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
      fs: {
        allow: ['.', ...buildFsAllow()],
      },
    },
  }
})
