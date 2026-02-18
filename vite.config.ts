// vite.config.ts
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv } from 'vite'

const CHESS_STOCKFISH_BASE_URL = '/stockfish/'
const CHESS_STOCKFISH_DIR = new URL('./apps/chess/public/stockfish/', import.meta.url)
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
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    req.on('end', () => resolve(Buffer.concat(chunks)))
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
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\r/g, '')
    .trim()
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? process.env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  return {
    plugins: [{
    name: 'restapi-proxy',
    async generateBundle() {
      const stockfishFiles = [
        ['stockfish.wasm.js', 'application/javascript'],
        ['stockfish.wasm', 'application/wasm'],
      ] as const

      for (const [filename] of stockfishFiles) {
        try {
          const source = await readFile(new URL(filename, CHESS_STOCKFISH_DIR))
          this.emitFile({
            type: 'asset',
            fileName: `stockfish/${filename}`,
            source,
          })
        } catch {
          // Chess submodule may be absent; skip emitting assets in that case.
        }
      }
    },
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

      const openExternalUrl = async (target: string): Promise<void> => {
        const openCommand = process.platform === 'darwin'
          ? ['open', target]
          : process.platform === 'win32'
            ? ['cmd', '/c', 'start', '', target]
            : ['xdg-open', target]

        await new Promise<void>((resolve, reject) => {
          execFile(openCommand[0], openCommand.slice(1), (error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
      }

      const isEditorUrlReachable = async (target: string): Promise<boolean> => {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 900)
          const response = await fetch(target, { method: 'GET', signal: controller.signal })
          clearTimeout(timer)

          if (!response.ok) {
            return false
          }

          const contentType = response.headers.get('content-type') ?? ''
          if (!contentType.includes('text/html')) {
            return false
          }

          const body = await response.text()
          return body.includes('Smart Glasses UI Builder')
        } catch {
          return false
        }
      }

      server.middlewares.use('/__g2_session', async (req, res) => {
        if (req.method !== 'POST') {
          sendText(res, 405, 'Method Not Allowed')
          return
        }

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
          }

          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          const sessionToken = typeof payload.sessionToken === 'string'
            ? payload.sessionToken.trim()
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

      server.middlewares.use(CHESS_STOCKFISH_BASE_URL, async (req, res, next) => {
        if (req.method !== 'GET') {
          next()
          return
        }

        const reqUrl = req.url ?? '/'
        const stockfishPath = reqUrl.split('?')[0] ?? '/'
        if (stockfishPath.includes('..')) {
          res.statusCode = 400
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Invalid stockfish asset path')
          return
        }

        const cleanName = stockfishPath.replace(/^\/+/, '')
        try {
          const source = await readFile(new URL(cleanName, CHESS_STOCKFISH_DIR))
          const contentType = cleanName.endsWith('.wasm')
            ? 'application/wasm'
            : 'application/javascript; charset=utf-8'
          res.statusCode = 200
          res.setHeader('content-type', contentType)
          res.end(source)
        } catch {
          next()
        }
      })

      server.middlewares.use('/__open_editor', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Method Not Allowed')
          return
        }

        try {
          const explicitUrl = new URL(req.url ?? '', 'http://localhost').searchParams.get('url')?.trim() ?? ''
          const candidates = [
            explicitUrl,
            'http://localhost:5174/even-ui-builder/',
            'http://127.0.0.1:5174/even-ui-builder/',
            'http://localhost:5173/even-ui-builder/',
            'http://127.0.0.1:5173/even-ui-builder/',
          ].filter(Boolean)

          let openedUrl: string | null = null
          for (const candidate of candidates) {
            if (await isEditorUrlReachable(candidate)) {
              await openExternalUrl(candidate)
              openedUrl = candidate
              break
            }
          }

          if (!openedUrl) {
            res.statusCode = 404
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: 'Editor dev server not reachable.' }))
            return
          }

          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, url: openedUrl }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          const message = error instanceof Error ? error.message : String(error)
          res.end(`Failed to open editor URL: ${message}`)
        }
      })

      server.middlewares.use('/__restapi_proxy', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Method Not Allowed')
          return
        }

        try {
          const parsed = new URL(req.url ?? '', 'http://localhost')
          const target = parsed.searchParams.get('url')?.trim() ?? ''
          if (!target || (!target.startsWith('http://') && !target.startsWith('https://'))) {
            res.statusCode = 400
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('Missing or invalid "url" query parameter')
            return
          }

          const upstream = await fetch(target, { method: 'GET' })
          const body = await upstream.text()
          const contentType = upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8'

          res.statusCode = upstream.status
          res.setHeader('content-type', contentType)
          res.end(body)
        } catch (error) {
          res.statusCode = 502
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          const message = error instanceof Error ? error.message : String(error)
          res.end(`Proxy request failed: ${message}`)
        }
      })

      server.middlewares.use('/__reddit_proxy', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Method Not Allowed')
          return
        }

        try {
          const parsed = new URL(req.url ?? '', 'http://localhost')
          const path = parsed.searchParams.get('path')?.trim() ?? ''
          if (!path.startsWith('/')) {
            res.statusCode = 400
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('Missing or invalid "path" query parameter')
            return
          }

          const upstreamUrl = new URL(path, 'https://old.reddit.com')
          const upstream = await fetch(upstreamUrl, {
            headers: {
              'User-Agent': 'even-dev-simulator/1.0',
              Accept: 'application/json',
            },
          })
          const body = await upstream.text()
          const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'

          res.statusCode = upstream.status
          res.setHeader('content-type', contentType)
          res.end(body)
        } catch (error) {
          res.statusCode = 502
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          const message = error instanceof Error ? error.message : String(error)
          res.end(`Reddit proxy request failed: ${message}`)
        }
      })

      server.middlewares.use('/__open_external', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Method Not Allowed')
          return
        }

        try {
          const parsed = new URL(req.url ?? '', 'http://localhost')
          const target = parsed.searchParams.get('url')?.trim() ?? ''
          if (!target || (!target.startsWith('http://') && !target.startsWith('https://'))) {
            res.statusCode = 400
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('Missing or invalid "url" query parameter')
            return
          }

          await openExternalUrl(target)

          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          const message = error instanceof Error ? error.message : String(error)
          res.end(`Failed to open external URL: ${message}`)
        }
      })

      // Compatibility route for the upstream reddit submodule client.
      // It expects requests like /reddit-api/r/... to proxy to old.reddit.com.
      server.middlewares.use('/reddit-api', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Method Not Allowed')
          return
        }

        try {
          const upstreamUrl = `https://old.reddit.com${req.url ?? ''}`
          const upstream = await fetch(upstreamUrl, {
            headers: {
              'User-Agent': 'even-dev-simulator/1.0',
              Accept: 'application/json',
            },
          })
          const body = await upstream.text()
          const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'

          res.statusCode = upstream.status
          res.setHeader('content-type', contentType)
          res.end(body)
        } catch (error) {
          res.statusCode = 502
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          const message = error instanceof Error ? error.message : String(error)
          res.end(`Reddit proxy request failed: ${message}`)
        }
      })
    },
    }],
    server: {
      host: env.VITE_HOST || process.env.VITE_HOST || '127.0.0.1',
      port: 5173,
      allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    },
  }
})
