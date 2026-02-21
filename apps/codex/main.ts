import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'

type ViewState =
  | 'connecting'
  | 'list'
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'waiting'
  | 'streaming'
  | 'displaying'
  | 'error'

type UiScreen = 'list' | 'root'

type ThreadSummary = {
  id: string
  preview: string
  updatedAt: number
  cwd: string
  raw: Record<string, unknown>
}

type ConversationTurn = {
  prompt: string
  response: string
}

type RpcRequestId = number | string

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeoutId: number
}

class JsonRpcError extends Error {
  code: number
  data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
    this.data = data
  }
}

class CodexWsClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private closedByClient = false
  private notificationHandler: ((method: string, params: unknown) => void) | null = null
  private serverRequestHandler: ((method: string, id: RpcRequestId, params: unknown) => void) | null = null
  private closeHandler: ((unexpected: boolean) => void) | null = null

  async connect(url: string): Promise<void> {
    this.close()
    this.closedByClient = false

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url)
      const onOpen = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        resolve(socket)
      }
      const onError = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        reject(new Error(`Failed to connect websocket: ${url}`))
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })

    this.ws = ws
    ws.addEventListener('message', (event) => {
      this.handleIncoming(event.data)
    })
    ws.addEventListener('close', () => {
      const unexpected = !this.closedByClient
      this.failAllPending(new Error('WebSocket connection closed'))
      this.ws = null
      if (this.closeHandler) {
        this.closeHandler(unexpected)
      }
    })

    const initResult = await this.requestWithId<{ userAgent?: string }>(0, 'initialize', {
      clientInfo: {
        name: 'codex-g2',
        title: 'Codex on G2',
        version: '0.0.1',
      },
    })
    void initResult
    this.sendRaw({ method: 'initialized' })
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const maxAttempts = 3
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const id = this.nextId
        this.nextId += 1
        return await this.requestWithId<T>(id, method, params)
      } catch (error) {
        if (!(error instanceof JsonRpcError) || error.code !== OVERLOADED_ERROR_CODE || attempt >= maxAttempts - 1) {
          throw error
        }
        await sleep(computeBackoffMs(attempt))
      }
    }

    throw new Error(`request failed: ${method}`)
  }

  respond(id: RpcRequestId, result: unknown): void {
    this.sendRaw({ id, result })
  }

  respondError(id: RpcRequestId, code: number, message: string, data?: unknown): void {
    this.sendRaw({ id, error: { code, message, data } })
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandler = cb
  }

  onServerRequest(cb: (method: string, id: RpcRequestId, params: unknown) => void): void {
    this.serverRequestHandler = cb
  }

  onClose(cb: (unexpected: boolean) => void): void {
    this.closeHandler = cb
  }

  close(): void {
    this.closedByClient = true
    this.failAllPending(new Error('WebSocket closed by client'))
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore close errors.
      }
      this.ws = null
    }
  }

  private async requestWithId<T>(id: RpcRequestId, method: string, params?: unknown): Promise<T> {
    const key = this.requestKey(id)

    return await new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`JSON-RPC timeout: ${method}`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(key, {
        resolve: (value: unknown) => {
          resolve(value as T)
        },
        reject,
        timeoutId,
      })

      try {
        this.sendRaw({ id, method, params })
      } catch (error) {
        const pending = this.pending.get(key)
        if (pending) {
          window.clearTimeout(pending.timeoutId)
          this.pending.delete(key)
        }
        reject(error)
      }
    })
  }

  private handleIncoming(raw: unknown): void {
    let parsed: unknown

    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
    } else {
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      return
    }

    const msg = parsed as Record<string, unknown>
    const hasMethod = typeof msg.method === 'string'
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(msg, 'error')

    if (hasResult || hasError) {
      if (!hasId) {
        return
      }

      const key = this.requestKey(msg.id as RpcRequestId)
      const pending = this.pending.get(key)
      if (!pending) {
        return
      }

      this.pending.delete(key)
      window.clearTimeout(pending.timeoutId)

      if (hasError) {
        const errorObj = msg.error
        if (errorObj && typeof errorObj === 'object') {
          const errorRecord = errorObj as Record<string, unknown>
          const code = typeof errorRecord.code === 'number' ? errorRecord.code : -32000
          const message = typeof errorRecord.message === 'string' ? errorRecord.message : 'JSON-RPC error'
          pending.reject(new JsonRpcError(code, message, errorRecord.data))
          return
        }
        pending.reject(new JsonRpcError(-32000, 'JSON-RPC error'))
        return
      }

      pending.resolve(msg.result)
      return
    }

    if (!hasMethod) {
      return
    }

    const method = msg.method as string
    const params = msg.params

    if (hasId) {
      if (this.serverRequestHandler) {
        this.serverRequestHandler(method, msg.id as RpcRequestId, params)
      }
      return
    }

    if (this.notificationHandler) {
      this.notificationHandler(method, params)
    }
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }

    this.ws.send(JSON.stringify(payload))
  }

  private failAllPending(reason: Error): void {
    for (const [, pending] of this.pending) {
      window.clearTimeout(pending.timeoutId)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  private requestKey(id: RpcRequestId): string {
    return `${typeof id}:${String(id)}`
  }
}

type CodexRuntimeClient = {
  mode: 'bridge' | 'mock'
  connect: () => Promise<void>
  action: () => Promise<void>
}

const MAX_WRAP_CHARS = 45
const DISPLAY_WINDOW_LINES = 9
const SCROLL_COOLDOWN_MS = 80
const SCROLL_LINES_PER_EVENT = 4
const STREAM_INTERVAL_MS = 120
const STREAM_CHARS_PER_TICK = 8
const PCM_SAMPLE_RATE = 16_000
const MIN_PCM_AUDIO_BYTES = 200
const MAX_HISTORY_TURNS = 10
const MAX_THREAD_LIST_COUNT = 19
const OVERLOADED_ERROR_CODE = -32001
const REQUEST_TIMEOUT_MS = 45_000
const BASE_BACKOFF_MS = 1_000
const STREAM_STALL_TIMEOUT_MS = 20_000
const DEFAULT_CODEX_APPROVAL_POLICY = 'never'
const DEFAULT_CODEX_SANDBOX_MODE = 'danger-full-access'

const THINKING_VERBS = [
  'Thinking',
  'Analyzing',
  'Reasoning',
  'Processing',
  'Considering',
  'Evaluating',
]

const THINKING_DOT_INTERVAL_MS = 350
const THINKING_VERB_INTERVAL_MS = 3500
const THINKING_DOTS_MAX = 3

const SECTION_YOU = '── You ──'
const SECTION_CODEX = '── Codex ──'
const SCROLL_TRACK_CHAR = '.'
const SCROLL_THUMB_CHAR = '#'

const WORKDIR_INPUT_ID = 'codex-workdir-input'
const WORKDIR_CONTAINER_ID = 'codex-workdir-controls'
const FALLBACK_WORKING_DIRECTORY = '/home/aza/Desktop'

const TITLE_CONTAINER_ID = 1
const BODY_CONTAINER_ID = 2
const AUX_CONTAINER_ID = 3

const TITLE_CONTAINER_NAME = 'codex-title'
const BODY_CONTAINER_NAME = 'codex-body'
const STATUS_CONTAINER_NAME = 'codex-status'
const LIST_CONTAINER_NAME = 'codex-list'

const state: {
  bridge: EvenAppBridge | null
  startupRendered: boolean
  eventLoopRegistered: boolean
  screen: UiScreen
  viewState: ViewState
  statusLine: string
  errorDetail: string
  client: CodexWsClient | null
  activeThreadId: string | null
  activeTurnId: string | null
  threadList: ThreadSummary[]
  listSelectedIndex: number
  workingDirectory: string
  defaultWorkingDirectory: string
  conversationHistory: ConversationTurn[]
  currentPrompt: string
  currentResponse: string
  streamingText: string
  pendingDelta: string
  lastAgentMessageSnapshot: string
  turnCompletedPending: boolean
  thinkingVerbIndex: number
  thinkingDots: number
  thinkingDotTickCount: number
  thinkingIntervalId: number | null
  streamIntervalId: number | null
  micOpen: boolean
  pcmAudioChunks: Uint8Array[]
  pcmAudioBytes: number
  scrollOffset: number
  lastScrollTime: number
  renderInFlight: boolean
  renderPending: boolean
  renderLayout: 'list' | 'text' | null
  renderedTitle: string
  renderedBody: string
  renderedAux: string
  busy: boolean
  lastStreamEventAt: number
} = {
  bridge: null,
  startupRendered: false,
  eventLoopRegistered: false,
  screen: 'list',
  viewState: 'connecting',
  statusLine: 'Connect to Codex',
  errorDetail: '',
  client: null,
  activeThreadId: null,
  activeTurnId: null,
  threadList: [],
  listSelectedIndex: 0,
  workingDirectory: FALLBACK_WORKING_DIRECTORY,
  defaultWorkingDirectory: FALLBACK_WORKING_DIRECTORY,
  conversationHistory: [],
  currentPrompt: '',
  currentResponse: '',
  streamingText: '',
  pendingDelta: '',
  lastAgentMessageSnapshot: '',
  turnCompletedPending: false,
  thinkingVerbIndex: 0,
  thinkingDots: 1,
  thinkingDotTickCount: 0,
  thinkingIntervalId: null,
  streamIntervalId: null,
  micOpen: false,
  pcmAudioChunks: [],
  pcmAudioBytes: 0,
  scrollOffset: 0,
  lastScrollTime: 0,
  renderInFlight: false,
  renderPending: false,
  renderLayout: null,
  renderedTitle: '',
  renderedBody: '',
  renderedAux: '',
  busy: false,
  lastStreamEventAt: 0,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function computeBackoffMs(attempt: number): number {
  const exponential = BASE_BACKOFF_MS * (2 ** attempt)
  const jitterFactor = 1 + (Math.random() * 0.4 - 0.2)
  return Math.max(100, Math.round(exponential * jitterFactor))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(timer))
  })
}

function normalizeWorkingDirectoryWithFallback(raw: string, fallback: string): string {
  const value = raw.trim()
  return value || fallback || FALLBACK_WORKING_DIRECTORY
}

function normalizeWorkingDirectory(raw: string): string {
  return normalizeWorkingDirectoryWithFallback(raw, state.defaultWorkingDirectory)
}

function getWorkingDirectoryInput(): HTMLInputElement | null {
  return document.getElementById(WORKDIR_INPUT_ID) as HTMLInputElement | null
}

function syncWorkingDirectoryInput(): void {
  const input = getWorkingDirectoryInput()
  if (!input) {
    return
  }

  if (input.value !== state.workingDirectory) {
    input.value = state.workingDirectory
  }
}

function updateWorkingDirectoryFromInput(): void {
  const input = getWorkingDirectoryInput()
  if (!input) {
    return
  }

  state.workingDirectory = normalizeWorkingDirectory(input.value)
  input.value = state.workingDirectory
}

function ensureWorkingDirectoryControls(): void {
  const app = document.getElementById('app')
  if (!app) {
    return
  }

  const existing = document.getElementById(WORKDIR_CONTAINER_ID)
  if (existing) {
    syncWorkingDirectoryInput()
    return
  }

  const wrapper = document.createElement('div')
  wrapper.id = WORKDIR_CONTAINER_ID

  const label = document.createElement('label')
  label.htmlFor = WORKDIR_INPUT_ID
  label.textContent = 'Codex working directory'

  const input = document.createElement('input')
  input.id = WORKDIR_INPUT_ID
  input.type = 'text'
  input.placeholder = FALLBACK_WORKING_DIRECTORY
  input.value = state.workingDirectory
  input.autocomplete = 'off'
  input.spellcheck = false
  input.addEventListener('change', updateWorkingDirectoryFromInput)
  input.addEventListener('blur', updateWorkingDirectoryFromInput)

  wrapper.append(label, input)

  const status = document.getElementById('status')
  if (status?.parentElement === app) {
    app.insertBefore(wrapper, status)
  } else {
    app.appendChild(wrapper)
  }
}

function resolveWsUrls(): string[] {
  const configuredUrl = String(import.meta.env.VITE_CODEX_WS_URL ?? '').trim()
  if (configuredUrl) {
    return [configuredUrl]
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const proxyUrl = `${proto}//${window.location.host}/codex-ws`

  const configuredPort = String(import.meta.env.VITE_CODEX_WS_PORT ?? '').trim()
  if (configuredPort) {
    const directUrl = `${proto}//${window.location.hostname}:${configuredPort}`
    return [directUrl, proxyUrl]
  }

  return [proxyUrl]
}

function resolveApprovalPolicy(): string {
  const configured = String(import.meta.env.VITE_CODEX_APPROVAL_POLICY ?? '').trim()
  if (!configured) {
    return DEFAULT_CODEX_APPROVAL_POLICY
  }
  return configured
}

function resolveSandboxMode(): string {
  const configured = String(import.meta.env.VITE_CODEX_SANDBOX_MODE ?? '').trim()
  if (!configured) {
    return DEFAULT_CODEX_SANDBOX_MODE
  }
  return configured
}

function resolveTurnSandboxPolicy(): Record<string, unknown> | null {
  const mode = resolveSandboxMode()
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' }
  }
  return null
}

function getRawEventType(event: EvenHubEvent): unknown {
  const raw = (event.jsonData ?? {}) as Record<string, unknown>
  return (
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    (event as Record<string, unknown>).eventType ??
    raw.eventType ??
    raw.event_type ??
    raw.Event_Type ??
    raw.type
  )
}

function normalizeEventType(rawEventType: unknown): OsEventTypeList | undefined {
  if (typeof rawEventType === 'number') {
    switch (rawEventType) {
      case 0:
        return OsEventTypeList.CLICK_EVENT
      case 1:
        return OsEventTypeList.SCROLL_TOP_EVENT
      case 2:
        return OsEventTypeList.SCROLL_BOTTOM_EVENT
      case 3:
        return OsEventTypeList.DOUBLE_CLICK_EVENT
      default:
        return undefined
    }
  }

  if (typeof rawEventType === 'string') {
    const value = rawEventType.toUpperCase()
    if (value.includes('DOUBLE')) return OsEventTypeList.DOUBLE_CLICK_EVENT
    if (value.includes('CLICK')) return OsEventTypeList.CLICK_EVENT
    if (value.includes('SCROLL_TOP') || value.includes('UP')) return OsEventTypeList.SCROLL_TOP_EVENT
    if (value.includes('SCROLL_BOTTOM') || value.includes('DOWN')) return OsEventTypeList.SCROLL_BOTTOM_EVENT
  }

  return undefined
}

function scrollThrottleOk(): boolean {
  const now = Date.now()
  if (now - state.lastScrollTime < SCROLL_COOLDOWN_MS) {
    return false
  }
  state.lastScrollTime = now
  return true
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0
  }
  return Math.max(0, Math.min(length - 1, index))
}

function isRebuildSuccess(result: unknown): boolean {
  if (result === true || result === 0 || result === '0') {
    return true
  }

  if (typeof result === 'string') {
    const normalized = result.trim().toUpperCase()
    if (normalized.includes('SUCCESS')) {
      return true
    }
  }

  return false
}

function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r/g, '')
    .trim()
}

function wrapLine(rawLine: string): string[] {
  const normalized = rawLine
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')

  if (!normalized.trim()) {
    return []
  }

  const words = normalized.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (!current) {
      if (word.length <= MAX_WRAP_CHARS) {
        current = word
        continue
      }

      for (let i = 0; i < word.length; i += MAX_WRAP_CHARS) {
        lines.push(word.slice(i, i + MAX_WRAP_CHARS))
      }
      current = ''
      continue
    }

    const candidate = `${current} ${word}`
    if (candidate.length <= MAX_WRAP_CHARS) {
      current = candidate
      continue
    }

    lines.push(current)

    if (word.length <= MAX_WRAP_CHARS) {
      current = word
      continue
    }

    for (let i = 0; i < word.length; i += MAX_WRAP_CHARS) {
      lines.push(word.slice(i, i + MAX_WRAP_CHARS))
    }
    current = ''
  }

  if (current) {
    lines.push(current)
  }

  return lines
}

function wrapText(text: string): string[] {
  const source = sanitizeDisplayText(text)
  const rows = source.split('\n')
  const wrapped: string[] = []

  for (const row of rows) {
    wrapped.push(...wrapLine(row))
  }

  if (wrapped.length === 0) {
    return ['(empty)']
  }

  return wrapped
}

function appendConversationTurn(prompt: string, response: string): void {
  const safePrompt = sanitizeDisplayText(prompt)
  const safeResponse = sanitizeDisplayText(response)
  if (!safePrompt || !safeResponse) {
    return
  }

  state.conversationHistory.push({
    prompt: safePrompt,
    response: safeResponse,
  })

  if (state.conversationHistory.length > MAX_HISTORY_TURNS) {
    state.conversationHistory.splice(0, state.conversationHistory.length - MAX_HISTORY_TURNS)
  }
}

function scrollToBottom(lines: string[]): void {
  const maxOffset = Math.max(0, lines.length - DISPLAY_WINDOW_LINES)
  state.scrollOffset = maxOffset
}

function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, now - Math.floor(unixSeconds || 0))

  if (diff < 10) return 'just now'
  if (diff < 60) return `${diff}s ago`

  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

function toThreadLabel(thread: ThreadSummary): string {
  const age = relativeTime(thread.updatedAt)
  const base = `${thread.preview || '(empty)'} · ${age}`
  if (base.length <= 62) {
    return base
  }
  return `${base.slice(0, 59)}...`
}

function parsePath(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.path === 'string') {
      return record.path
    }
  }

  return ''
}

function parseThreadSummary(raw: unknown): ThreadSummary | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) {
    return null
  }

  const previewRaw = typeof record.preview === 'string' ? record.preview : ''
  const preview = sanitizeDisplayText(previewRaw) || '(empty)'
  const updatedAt = typeof record.updatedAt === 'number'
    ? record.updatedAt
    : typeof record.updated_at === 'number'
      ? record.updated_at
      : 0
  const cwd = parsePath(record.cwd)

  return {
    id,
    preview,
    updatedAt,
    cwd,
    raw: record,
  }
}

function extractUserTextFromContent(contentRaw: unknown): string {
  if (!Array.isArray(contentRaw)) {
    return ''
  }

  const parts: string[] = []
  for (const entry of contentRaw) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const content = entry as Record<string, unknown>
    if (content.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
      parts.push(content.text.trim())
    }
  }

  return sanitizeDisplayText(parts.join('\n'))
}

function extractConversationHistoryFromThread(threadRaw: unknown): ConversationTurn[] {
  if (!threadRaw || typeof threadRaw !== 'object') {
    return []
  }

  const thread = threadRaw as Record<string, unknown>
  if (!Array.isArray(thread.turns)) {
    return []
  }

  const history: ConversationTurn[] = []

  for (const turnRaw of thread.turns) {
    if (!turnRaw || typeof turnRaw !== 'object') {
      continue
    }

    const turn = turnRaw as Record<string, unknown>
    if (!Array.isArray(turn.items)) {
      continue
    }

    let prompt = ''
    let response = ''

    for (const itemRaw of turn.items) {
      if (!itemRaw || typeof itemRaw !== 'object') {
        continue
      }

      const item = itemRaw as Record<string, unknown>
      const type = typeof item.type === 'string' ? item.type : ''

      if (type === 'userMessage') {
        const parsedPrompt = extractUserTextFromContent(item.content)
        if (parsedPrompt) {
          prompt = parsedPrompt
        }
        continue
      }

      if (type === 'agentMessage' && typeof item.text === 'string') {
        const text = sanitizeDisplayText(item.text)
        if (!text) {
          continue
        }
        response = response ? `${response}\n${text}` : text
      }
    }

    if (prompt && response) {
      history.push({ prompt, response })
    }
  }

  if (history.length > MAX_HISTORY_TURNS) {
    return history.slice(history.length - MAX_HISTORY_TURNS)
  }

  return history
}

function stateToStatusLine(): string {
  if (state.screen === 'list') {
    return state.threadList.length > 0
      ? `Threads (${state.threadList.length})`
      : 'Threads (tap to create)'
  }

  switch (state.viewState) {
    case 'connecting':
      return 'Connecting...'
    case 'idle':
      return state.conversationHistory.length > 0 ? 'Double-tap for new prompt' : 'Double-tap to start'
    case 'recording':
      return 'Listening... double-tap to stop'
    case 'transcribing':
      return 'Transcribing...'
    case 'waiting':
      return `Codex: ${THINKING_VERBS[state.thinkingVerbIndex % THINKING_VERBS.length]}${'.'.repeat(state.thinkingDots)}`
    case 'streaming':
      return 'Receiving...'
    case 'displaying':
      return 'Tap for threads'
    case 'error':
      return 'Error. Tap to reconnect'
    case 'list':
      return 'Threads'
    default:
      return 'Ready'
  }
}

function buildConversationLines(): string[] {
  const lines: string[] = []

  for (const turn of state.conversationHistory) {
    lines.push(SECTION_YOU, ...wrapText(turn.prompt))
    lines.push(SECTION_CODEX, ...wrapText(turn.response), '')
  }

  switch (state.viewState) {
    case 'recording':
      lines.push(SECTION_YOU, '(listening...)')
      break
    case 'transcribing':
      lines.push(SECTION_YOU, '(transcribing...)')
      break
    case 'waiting':
      if (state.currentPrompt) {
        lines.push(SECTION_YOU, ...wrapText(state.currentPrompt))
      }
      lines.push(SECTION_CODEX)
      lines.push(`${THINKING_VERBS[state.thinkingVerbIndex % THINKING_VERBS.length]}${'.'.repeat(state.thinkingDots)}`)
      break
    case 'streaming':
      if (state.currentPrompt) {
        lines.push(SECTION_YOU, ...wrapText(state.currentPrompt))
      }
      lines.push(SECTION_CODEX)
      if (state.streamingText) {
        lines.push(...wrapText(state.streamingText))
      } else {
        lines.push('...')
      }
      break
    case 'error':
      lines.push('Error:', state.errorDetail || 'Unknown error')
      break
    case 'idle':
    case 'displaying':
      if (lines.length === 0) {
        lines.push('Tap to choose thread', 'Double-tap to speak')
      }
      break
    default:
      break
  }

  return lines
}

function buildScrollbarLines(totalLines: number, scrollOffset: number, visible: number): string[] {
  const rows = Array.from({ length: DISPLAY_WINDOW_LINES }, () => SCROLL_TRACK_CHAR)
  const total = Math.max(visible, totalLines)
  const maxOffset = Math.max(0, total - visible)

  const thumbSize = Math.max(1, Math.min(
    visible,
    Math.round((visible * visible) / total),
  ))
  const maxThumbTop = Math.max(0, visible - thumbSize)
  const thumbTop = maxOffset > 0
    ? Math.round((scrollOffset / maxOffset) * maxThumbTop)
    : 0

  for (let i = 0; i < thumbSize; i += 1) {
    rows[thumbTop + i] = SCROLL_THUMB_CHAR
  }

  return rows
}

function buildListLines(): string[] {
  const entries = buildListEntries()
  state.listSelectedIndex = clampIndex(state.listSelectedIndex, entries.length)

  return entries.map((entry, index) => {
    const marker = index === state.listSelectedIndex ? '> ' : '  '
    return `${marker}${entry.label}`
  })
}

function buildTextRender(): { titleText: string, bodyText: string } {
  state.statusLine = stateToStatusLine()

  const all = state.screen === 'list'
    ? buildListLines()
    : buildConversationLines()

  if (all.length === 0) {
    all.push('Ready')
  }

  const maxOffset = Math.max(0, all.length - DISPLAY_WINDOW_LINES)
  if (state.screen === 'list') {
    const preferred = Math.max(0, state.listSelectedIndex - 1)
    state.scrollOffset = Math.min(maxOffset, preferred)
  } else if (state.viewState === 'streaming') {
    state.scrollOffset = maxOffset
  } else {
    state.scrollOffset = Math.min(maxOffset, Math.max(0, state.scrollOffset))
  }

  const page = all.slice(state.scrollOffset, state.scrollOffset + DISPLAY_WINDOW_LINES)
  while (page.length < DISPLAY_WINDOW_LINES) {
    page.push(' ')
  }

  return {
    titleText: state.statusLine,
    bodyText: page.join('\n'),
  }
}

function buildTextConfig(titleText: string, bodyText: string): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
} {
  const title = new TextContainerProperty({
    containerID: TITLE_CONTAINER_ID,
    containerName: TITLE_CONTAINER_NAME,
    content: titleText,
    xPosition: 8,
    yPosition: 0,
    width: 560,
    height: 36,
    isEventCapture: 0,
  })

  const body = new TextContainerProperty({
    containerID: BODY_CONTAINER_ID,
    containerName: BODY_CONTAINER_NAME,
    content: bodyText,
    xPosition: 8,
    yPosition: 40,
    width: 560,
    height: 248,
    isEventCapture: 1,
  })

  return {
    containerTotalNum: 2,
    textObject: [title, body],
  }
}

function buildListEntries(): Array<{ type: 'thread' | 'new', thread?: ThreadSummary, label: string }> {
  const entries = state.threadList.map((thread) => ({
    type: 'thread' as const,
    thread,
    label: toThreadLabel(thread),
  }))

  entries.push({
    type: 'new',
    label: '[ + New Thread ]',
  })

  return entries
}

function buildListConfig(): {
  containerTotalNum: number
  textObject: TextContainerProperty[]
  listObject: ListContainerProperty[]
  currentSelectedItem: number
} {
  const entries = buildListEntries()
  state.listSelectedIndex = clampIndex(state.listSelectedIndex, entries.length)

  const title = new TextContainerProperty({
    containerID: TITLE_CONTAINER_ID,
    containerName: TITLE_CONTAINER_NAME,
    content: 'Codex Threads (scroll + tap)',
    xPosition: 8,
    yPosition: 0,
    width: 560,
    height: 32,
    isEventCapture: 0,
  })

  const status = new TextContainerProperty({
    containerID: BODY_CONTAINER_ID,
    containerName: STATUS_CONTAINER_NAME,
    content: state.viewState === 'connecting'
      ? 'Connecting to app-server...'
      : state.threadList.length > 0
        ? `${state.threadList.length} threads loaded`
        : 'No threads found. Tap new thread.',
    xPosition: 8,
    yPosition: 34,
    width: 560,
    height: 64,
    isEventCapture: 0,
  })

  const listContainer = new ListContainerProperty({
    containerID: AUX_CONTAINER_ID,
    containerName: LIST_CONTAINER_NAME,
    itemContainer: new ListItemContainerProperty({
      itemCount: entries.length,
      itemWidth: 566,
      isItemSelectBorderEn: 1,
      itemName: entries.map((entry) => entry.label),
    }),
    isEventCapture: 1,
    xPosition: 4,
    yPosition: 102,
    width: 572,
    height: 186,
  })

  return {
    containerTotalNum: 3,
    textObject: [title, status],
    listObject: [listContainer],
    currentSelectedItem: state.listSelectedIndex,
  }
}

async function upgradeTextContainer(
  bridge: EvenAppBridge,
  containerID: number,
  containerName: string,
  prevContent: string,
  nextContent: string,
): Promise<void> {
  if (prevContent === nextContent) {
    return
  }

  const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID,
    containerName,
    contentOffset: 0,
    contentLength: Math.max(1, prevContent.length, nextContent.length),
    content: nextContent,
  }))

  if (!ok) {
    throw new Error(`textContainerUpgrade failed for ${containerName}`)
  }
}

async function renderPage(bridge: EvenAppBridge): Promise<void> {
  state.renderPending = true
  if (state.renderInFlight) {
    return
  }

  state.renderInFlight = true
  try {
    while (state.renderPending) {
      state.renderPending = false

      const { titleText, bodyText } = buildTextRender()
      const config = buildTextConfig(titleText, bodyText)

      if (!state.startupRendered) {
        const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
        if (result !== 0) {
          appendEventLog(`Codex: startup create failed for text screen (${String(result)}), trying rebuild`)
          const rebuildResult = await bridge.rebuildPageContainer(new RebuildPageContainer(config))
          if (!isRebuildSuccess(rebuildResult)) {
            throw new Error(`createStartUpPageContainer failed (${String(result)}); rebuild fallback failed (${String(rebuildResult)})`)
          }
        }
        state.startupRendered = true
      } else if (state.renderLayout !== 'text') {
        const result = await bridge.rebuildPageContainer(new RebuildPageContainer(config))
        if (!isRebuildSuccess(result)) {
          throw new Error(`rebuildPageContainer failed for text screen (${String(result)})`)
        }
      } else {
        try {
          await upgradeTextContainer(
            bridge,
            TITLE_CONTAINER_ID,
            TITLE_CONTAINER_NAME,
            state.renderedTitle,
            titleText,
          )
          await upgradeTextContainer(
            bridge,
            BODY_CONTAINER_ID,
            BODY_CONTAINER_NAME,
            state.renderedBody,
            bodyText,
          )
        } catch {
          const result = await bridge.rebuildPageContainer(new RebuildPageContainer(config))
          if (!isRebuildSuccess(result)) {
            appendEventLog(`Codex: text rebuild fallback failed (${String(result)})`)
            state.renderLayout = null
            state.startupRendered = false
            break
          }
        }
      }

      state.renderLayout = 'text'
      state.renderedTitle = titleText
      state.renderedBody = bodyText
      state.renderedAux = ''
    }
  } finally {
    state.renderInFlight = false
  }
}

function setViewState(next: ViewState, detail?: string): void {
  state.viewState = next
  if (next === 'error') {
    state.errorDetail = detail ?? 'Unknown error'
  } else {
    state.errorDetail = ''
  }
}

function stopThinkingAnimation(): void {
  if (state.thinkingIntervalId !== null) {
    window.clearInterval(state.thinkingIntervalId)
    state.thinkingIntervalId = null
  }
  state.thinkingVerbIndex = 0
  state.thinkingDots = 1
  state.thinkingDotTickCount = 0
}

function startThinkingAnimation(bridge: EvenAppBridge): void {
  stopThinkingAnimation()
  const ticksPerVerb = Math.max(1, Math.round(THINKING_VERB_INTERVAL_MS / THINKING_DOT_INTERVAL_MS))
  state.thinkingIntervalId = window.setInterval(() => {
    if (state.viewState !== 'waiting') {
      stopThinkingAnimation()
      return
    }

    state.thinkingDots = (state.thinkingDots % THINKING_DOTS_MAX) + 1
    state.thinkingDotTickCount += 1
    if (state.thinkingDotTickCount >= ticksPerVerb) {
      state.thinkingDotTickCount = 0
      state.thinkingVerbIndex = (state.thinkingVerbIndex + 1) % THINKING_VERBS.length
    }

    void renderPage(bridge)
  }, THINKING_DOT_INTERVAL_MS)
}

function stopStreamingDrain(): void {
  if (state.streamIntervalId !== null) {
    window.clearInterval(state.streamIntervalId)
    state.streamIntervalId = null
  }
}

async function finalizeCompletedTurn(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  const response = sanitizeDisplayText(
    state.streamingText || state.currentResponse || state.lastAgentMessageSnapshot || '(No response)',
  )

  if (state.currentPrompt && response) {
    appendConversationTurn(state.currentPrompt, response)
  }

  stopStreamingDrain()
  stopThinkingAnimation()

  state.currentPrompt = ''
  state.currentResponse = ''
  state.streamingText = ''
  state.pendingDelta = ''
  state.lastAgentMessageSnapshot = ''
  state.turnCompletedPending = false
  state.activeTurnId = null
  setViewState('displaying')
  scrollToBottom(buildConversationLines())

  await renderPage(bridge)
  setStatus('Codex: response received')

  try {
    await refreshThreadList()
  } catch {
    // Best effort thread list refresh.
  }
}

function ensureStreamingDrainLoop(bridge: EvenAppBridge, setStatus: SetStatus): void {
  if (state.streamIntervalId !== null) {
    return
  }

  state.streamIntervalId = window.setInterval(() => {
    if (state.viewState === 'waiting' || state.viewState === 'streaming') {
      const stalled = state.lastStreamEventAt > 0
        && (Date.now() - state.lastStreamEventAt) > STREAM_STALL_TIMEOUT_MS
      if (stalled) {
        appendEventLog('Codex: stream stalled, forcing recovery')
        stopThinkingAnimation()
        state.lastStreamEventAt = 0

        const partial = sanitizeDisplayText(
          state.pendingDelta
          || state.streamingText
          || state.currentResponse
          || state.lastAgentMessageSnapshot
          || '',
        )

        if (partial) {
          state.turnCompletedPending = true
          setStatus('Codex: stream stalled. Finalizing partial response...')
          if (!state.pendingDelta && !state.streamingText) {
            void finalizeCompletedTurn(bridge, setStatus)
          }
          return
        }

        resetTransientTurnState()
        setViewState('error', 'Response stalled. Tap to reconnect.')
        state.screen = 'root'
        void renderPage(bridge)
        setStatus('Codex: response stalled. Tap to reconnect.')
        return
      }
    }

    if (state.pendingDelta.length > 0) {
      stopThinkingAnimation()
      if (state.viewState === 'waiting') {
        setViewState('streaming')
      }

      const chunk = state.pendingDelta.slice(0, STREAM_CHARS_PER_TICK)
      state.pendingDelta = state.pendingDelta.slice(STREAM_CHARS_PER_TICK)
      state.streamingText += chunk
      state.currentResponse = state.streamingText
      scrollToBottom(buildConversationLines())
      void renderPage(bridge)
      return
    }

    if (state.turnCompletedPending) {
      void finalizeCompletedTurn(bridge, setStatus)
      return
    }

    if (state.viewState !== 'streaming' && state.viewState !== 'waiting') {
      stopStreamingDrain()
    }
  }, STREAM_INTERVAL_MS)
}

async function stopActiveMic(bridge: EvenAppBridge): Promise<void> {
  if (!state.micOpen) {
    state.pcmAudioChunks = []
    state.pcmAudioBytes = 0
    return
  }

  try {
    await bridge.audioControl(false)
  } catch {
    // Ignore microphone close errors.
  }

  state.micOpen = false
  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0
}

async function startRecording(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  await stopActiveMic(bridge)
  stopThinkingAnimation()
  stopStreamingDrain()

  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0
  state.currentPrompt = ''
  state.currentResponse = ''
  state.streamingText = ''
  state.pendingDelta = ''
  state.lastAgentMessageSnapshot = ''
  state.turnCompletedPending = false

  const opened = await bridge.audioControl(true)
  if (!opened) {
    throw new Error('G2 microphone could not be opened')
  }

  state.micOpen = true
  state.screen = 'root'
  setViewState('recording')
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('Codex: listening... double-tap to stop')
  appendEventLog('Codex: microphone opened')
}

async function stopRecordingToBlob(bridge: EvenAppBridge): Promise<Blob> {
  if (!state.micOpen) {
    throw new Error('Glasses microphone is not active')
  }

  try {
    await bridge.audioControl(false)
  } catch {
    // Keep buffered data.
  }

  state.micOpen = false

  if (state.pcmAudioBytes < MIN_PCM_AUDIO_BYTES) {
    state.pcmAudioChunks = []
    state.pcmAudioBytes = 0
    throw new Error('No audio captured from glasses microphone')
  }

  const blob = buildWavBlob(state.pcmAudioChunks)
  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0

  if (blob.size === 0) {
    throw new Error('Captured glasses audio is empty')
  }

  return blob
}

async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', audioBlob, 'g2-codex-input.wav')
  form.append('model', 'whisper-large-v3-turbo')

  const response = await fetch('/__groq_transcribe', {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Transcription failed (${response.status})`)
  }

  const body = (await response.json()) as { text?: unknown }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) {
    throw new Error('Transcription returned empty text')
  }

  return text
}

function writeWavString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

function buildWavBlob(pcmChunks: Uint8Array[]): Blob {
  let totalBytes = 0
  for (const chunk of pcmChunks) {
    totalBytes += chunk.length
  }

  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  writeWavString(view, 0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeWavString(view, 8, 'WAVE')

  writeWavString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, PCM_SAMPLE_RATE, true)
  view.setUint32(28, PCM_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  writeWavString(view, 36, 'data')
  view.setUint32(40, totalBytes, true)

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of pcmChunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return new Blob([header, merged], { type: 'audio/wav' })
}

async function refreshThreadList(): Promise<void> {
  if (!state.client) {
    return
  }

  const previousSelectedThreadId = buildListEntries()[state.listSelectedIndex]?.thread?.id ?? null
  const result = await state.client.request<{ data?: unknown }>('thread/list', {
    limit: MAX_THREAD_LIST_COUNT,
    sortKey: 'updated_at',
  })

  const data = Array.isArray(result?.data) ? result.data : []
  const threads = data
    .map((raw) => parseThreadSummary(raw))
    .filter((thread): thread is ThreadSummary => thread !== null)

  state.threadList = threads.slice(0, MAX_THREAD_LIST_COUNT)

  if (previousSelectedThreadId) {
    const nextIndex = state.threadList.findIndex((thread) => thread.id === previousSelectedThreadId)
    if (nextIndex >= 0) {
      state.listSelectedIndex = nextIndex
      return
    }
  }

  state.listSelectedIndex = clampIndex(state.listSelectedIndex, buildListEntries().length)
}

function resetTransientTurnState(): void {
  stopThinkingAnimation()
  stopStreamingDrain()
  state.currentPrompt = ''
  state.currentResponse = ''
  state.streamingText = ''
  state.pendingDelta = ''
  state.lastAgentMessageSnapshot = ''
  state.turnCompletedPending = false
  state.activeTurnId = null
  state.lastStreamEventAt = 0
}

async function connectToCodex(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  updateWorkingDirectoryFromInput()
  resetTransientTurnState()

  if (state.client) {
    state.client.close()
    state.client = null
  }

  const client = new CodexWsClient()
  state.client = client

  client.onNotification((method, params) => {
    void handleNotification(method, params, bridge, setStatus)
  })
  client.onServerRequest((method, id, params) => {
    void handleServerRequest(method, id, params, bridge, setStatus)
  })
  client.onClose((unexpected) => {
    if (!unexpected) {
      return
    }

    state.activeTurnId = null
    resetTransientTurnState()
    setViewState('error', 'Disconnected. Tap to reconnect.')
    state.screen = 'root'
    appendEventLog('Codex: websocket disconnected unexpectedly')
    void renderPage(bridge)
    setStatus('Codex: disconnected. Tap to reconnect.')
  })

  setViewState('connecting')
  state.screen = 'list'
  await renderPage(bridge)
  const wsUrls = resolveWsUrls()
  setStatus('Codex: connecting to app-server...')
  let connectedWsUrl: string | null = null
  let lastConnectError: unknown = null

  for (const wsUrl of wsUrls) {
    appendEventLog(`Codex: opening websocket ${wsUrl}`)
    try {
      await client.connect(wsUrl)
      connectedWsUrl = wsUrl
      appendEventLog(`Codex: websocket open (${wsUrl})`)
      break
    } catch (error) {
      lastConnectError = error
      const message = error instanceof Error ? error.message : String(error)
      appendEventLog(`Codex: websocket failed (${wsUrl}) - ${message}`)
    }
  }

  if (!connectedWsUrl) {
    throw (lastConnectError instanceof Error ? lastConnectError : new Error(String(lastConnectError)))
  }

  let threadListError: string | null = null
  setStatus('Codex: websocket connected. Loading threads...')
  try {
    await refreshThreadList()
  } catch (error) {
    threadListError = error instanceof Error ? error.message : String(error)
    state.threadList = []
    state.listSelectedIndex = 0
    appendEventLog(`Codex: thread/list failed - ${threadListError}`)
  }

  state.screen = 'list'
  setViewState('list')
  await renderPage(bridge)
  if (threadListError) {
    setStatus('Codex: connected. Thread list unavailable; double-tap to start new thread.')
    appendEventLog('Codex: connected without thread list')
  } else {
    setStatus(`Codex: connected. ${state.threadList.length} threads available.`)
    appendEventLog('Codex: websocket connected and thread list loaded')
  }
}

async function startNewThread(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  if (!state.client) {
    throw new Error('Not connected to Codex app-server')
  }

  updateWorkingDirectoryFromInput()

  const result = await state.client.request<{ thread?: unknown, cwd?: unknown }>('thread/start', {
    cwd: state.workingDirectory,
    approvalPolicy: resolveApprovalPolicy(),
    sandbox: resolveSandboxMode(),
  })

  const thread = parseThreadSummary(result.thread)
  if (!thread) {
    throw new Error('Invalid thread/start response')
  }

  state.activeThreadId = thread.id
  const serverCwd = parsePath(result.cwd)
  if (serverCwd) {
    state.workingDirectory = normalizeWorkingDirectoryWithFallback(serverCwd, state.defaultWorkingDirectory)
    syncWorkingDirectoryInput()
  }

  state.conversationHistory = []
  resetTransientTurnState()

  state.screen = 'root'
  setViewState('idle')
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('Codex: new thread ready. Double-tap to speak.')
  appendEventLog(`Codex: started thread ${thread.id}`)

  void refreshThreadList()
}

async function resumeThread(thread: ThreadSummary, bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  if (!state.client) {
    throw new Error('Not connected to Codex app-server')
  }

  updateWorkingDirectoryFromInput()

  const result = await state.client.request<{ thread?: unknown, cwd?: unknown }>('thread/resume', {
    threadId: thread.id,
    cwd: state.workingDirectory || thread.cwd,
    approvalPolicy: resolveApprovalPolicy(),
    sandbox: resolveSandboxMode(),
  })

  const resumed = parseThreadSummary(result.thread)
  if (!resumed) {
    throw new Error('Invalid thread/resume response')
  }

  state.activeThreadId = resumed.id
  const serverCwd = parsePath(result.cwd)
  if (serverCwd) {
    state.workingDirectory = normalizeWorkingDirectoryWithFallback(serverCwd, thread.cwd || state.defaultWorkingDirectory)
  } else if (thread.cwd) {
    state.workingDirectory = normalizeWorkingDirectoryWithFallback(thread.cwd, state.defaultWorkingDirectory)
  }
  syncWorkingDirectoryInput()

  state.conversationHistory = extractConversationHistoryFromThread(result.thread)
  resetTransientTurnState()

  state.screen = 'root'
  if (state.conversationHistory.length > 0) {
    setViewState('displaying')
  } else {
    setViewState('idle')
  }
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('Codex: thread resumed. Double-tap to speak.')
  appendEventLog(`Codex: resumed thread ${resumed.id}`)
}

async function resumeSelectedThreadOrCreate(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  const entries = buildListEntries()
  const selected = entries[clampIndex(state.listSelectedIndex, entries.length)]

  if (!selected || selected.type === 'new' || !selected.thread) {
    await startNewThread(bridge, setStatus)
    return
  }

  await resumeThread(selected.thread, bridge, setStatus)
}

async function interruptActiveTurn(setStatus: SetStatus): Promise<void> {
  if (!state.client || !state.activeThreadId || !state.activeTurnId) {
    return
  }

  await state.client.request('turn/interrupt', {
    threadId: state.activeThreadId,
    turnId: state.activeTurnId,
  })

  setStatus('Codex: interrupt requested')
  appendEventLog('Codex: turn interrupt requested')
}

async function stopRecordingAndSendTurn(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  if (!state.client || !state.activeThreadId) {
    throw new Error('No active thread. Choose or create one first.')
  }

  setViewState('transcribing')
  await renderPage(bridge)
  setStatus('Codex: transcribing audio...')

  const audio = await stopRecordingToBlob(bridge)
  const prompt = await transcribeAudio(audio)

  state.currentPrompt = prompt
  state.currentResponse = ''
  state.streamingText = ''
  state.pendingDelta = ''
  state.lastAgentMessageSnapshot = ''
  state.turnCompletedPending = false

  setViewState('waiting')
  state.lastStreamEventAt = Date.now()
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('Codex: sending prompt...')

  const turnSandboxPolicy = resolveTurnSandboxPolicy()
  const response = await state.client.request<{ turn?: unknown }>('turn/start', {
    threadId: state.activeThreadId,
    input: [{ type: 'text', text: prompt }],
    approvalPolicy: resolveApprovalPolicy(),
    ...(turnSandboxPolicy ? { sandboxPolicy: turnSandboxPolicy } : {}),
  })

  const turn = response.turn as Record<string, unknown> | undefined
  state.activeTurnId = typeof turn?.id === 'string' ? turn.id : null

  setStatus('Codex: waiting for response...')
  startThinkingAnimation(bridge)
  ensureStreamingDrainLoop(bridge, setStatus)
}

function parseErrorMessage(params: unknown): string {
  if (!params || typeof params !== 'object') {
    return 'Unknown error'
  }
  const record = params as Record<string, unknown>

  if (record.error && typeof record.error === 'object') {
    const errorRecord = record.error as Record<string, unknown>
    if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) {
      return errorRecord.message
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message
  }

  return 'Unknown error'
}

async function handleNotification(
  method: string,
  params: unknown,
  bridge: EvenAppBridge,
  setStatus: SetStatus,
): Promise<void> {
  const p = (params && typeof params === 'object') ? params as Record<string, unknown> : {}

  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      if (delta) {
        state.lastStreamEventAt = Date.now()
        state.pendingDelta += delta
        ensureStreamingDrainLoop(bridge, setStatus)
      }
      break
    }
    case 'item/completed': {
      const item = p.item
      if (item && typeof item === 'object') {
        const itemRecord = item as Record<string, unknown>
        if (itemRecord.type === 'agentMessage' && typeof itemRecord.text === 'string') {
          state.lastAgentMessageSnapshot = itemRecord.text
        }
      }
      break
    }
    case 'turn/completed': {
      const turn = p.turn as Record<string, unknown> | undefined
      const status = typeof turn?.status === 'string' ? turn.status : ''

      if (status === 'completed') {
        state.lastStreamEventAt = Date.now()
        stopThinkingAnimation()

        if (!state.streamingText && !state.pendingDelta) {
          const fallback = sanitizeDisplayText(state.lastAgentMessageSnapshot)
          if (fallback) {
            state.pendingDelta += fallback
          }
        }

        state.turnCompletedPending = true
        if (!state.pendingDelta && !state.streamingText) {
          await finalizeCompletedTurn(bridge, setStatus)
        } else {
          ensureStreamingDrainLoop(bridge, setStatus)
        }
      } else {
        const errMessage = parseErrorMessage(turn?.error)
        resetTransientTurnState()
        setViewState('error', errMessage || `Turn ${status || 'failed'}`)
        await renderPage(bridge)
        setStatus(`Codex: ${errMessage || `turn ${status || 'failed'}`}`)
      }
      break
    }
    case 'error': {
      const errorMessage = parseErrorMessage(params)
      resetTransientTurnState()
      setViewState('error', errorMessage)
      await renderPage(bridge)
      setStatus(`Codex: ${errorMessage}`)
      break
    }
    default:
      break
  }
}

async function handleServerRequest(
  method: string,
  id: RpcRequestId,
  _params: unknown,
  bridge: EvenAppBridge,
  setStatus: SetStatus,
): Promise<void> {
  if (!state.client) {
    return
  }

  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    state.client.respond(id, { decision: 'decline' })
    resetTransientTurnState()
    setViewState('error', 'Approval required - interrupt turn or use another client')
    await renderPage(bridge)
    setStatus('Codex: approval required. Use another client or interrupt turn.')
    return
  }

  state.client.respondError(id, -32601, `Unsupported server method: ${method}`)
}

function moveConversationScroll(bridge: EvenAppBridge, delta: number): void {
  const all = buildConversationLines()
  if (all.length <= DISPLAY_WINDOW_LINES) {
    return
  }

  const step = delta < 0 ? -SCROLL_LINES_PER_EVENT : SCROLL_LINES_PER_EVENT
  const maxOffset = Math.max(0, all.length - DISPLAY_WINDOW_LINES)
  const next = Math.min(maxOffset, Math.max(0, state.scrollOffset + step))

  if (next === state.scrollOffset) {
    return
  }

  state.scrollOffset = next
  void renderPage(bridge)
}

function parseIncomingListIndex(event: EvenHubEvent): number {
  const entries = buildListEntries()
  if (entries.length === 0) {
    return -1
  }

  const incomingIndexRaw = event.listEvent?.currentSelectItemIndex
  const incomingName = event.listEvent?.currentSelectItemName
  const labels = entries.map((entry) => entry.label)
  const incomingByName = typeof incomingName === 'string' ? labels.indexOf(incomingName) : -1

  const parsedIndex = typeof incomingIndexRaw === 'number'
    ? incomingIndexRaw
    : typeof incomingIndexRaw === 'string'
      ? Number.parseInt(incomingIndexRaw, 10)
      : incomingByName

  if (Number.isNaN(parsedIndex) || parsedIndex < 0 || parsedIndex >= entries.length) {
    return -1
  }

  return parsedIndex
}

function moveListSelection(bridge: EvenAppBridge, event: EvenHubEvent, delta: number): void {
  const entries = buildListEntries()
  if (entries.length === 0) {
    return
  }

  const incoming = parseIncomingListIndex(event)
  const next = incoming >= 0
    ? clampIndex(incoming, entries.length)
    : clampIndex(state.listSelectedIndex + (delta < 0 ? -1 : 1), entries.length)

  if (next === state.listSelectedIndex) {
    return
  }

  state.listSelectedIndex = next
  void renderPage(bridge)
}

async function reconnectFromError(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  await connectToCodex(bridge, setStatus)
}

function registerEventLoop(bridge: EvenAppBridge, setStatus: SetStatus): void {
  if (state.eventLoopRegistered) {
    return
  }

  bridge.onEvenHubEvent(async (event) => {
    if (event.audioEvent && state.viewState === 'recording' && state.screen === 'root') {
      const rawPcm = event.audioEvent.audioPcm
      const pcm = rawPcm instanceof Uint8Array ? rawPcm : new Uint8Array(rawPcm)
      if (pcm.length > 0) {
        state.pcmAudioChunks.push(new Uint8Array(pcm))
        state.pcmAudioBytes += pcm.length
      }
      if (!event.listEvent && !event.textEvent && !event.sysEvent) {
        return
      }
    }

    const rawEventType = getRawEventType(event)
    let eventType = normalizeEventType(rawEventType)

    if (eventType === undefined && (event.listEvent || event.textEvent || event.sysEvent)) {
      eventType = OsEventTypeList.CLICK_EVENT
    }

    if (eventType === undefined) {
      return
    }

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (!scrollThrottleOk()) {
        return
      }

      const delta = eventType === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1
      if (state.screen === 'list') {
        moveListSelection(bridge, event, delta)
      } else {
        moveConversationScroll(bridge, delta)
      }
      return
    }

    if (eventType !== OsEventTypeList.CLICK_EVENT && eventType !== OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return
    }

    if (state.busy) {
      return
    }

    state.busy = true
    try {
      if (state.screen === 'list') {
        const incoming = parseIncomingListIndex(event)
        if (incoming >= 0) {
          state.listSelectedIndex = incoming
        }

        if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          await startNewThread(bridge, setStatus)
          return
        }

        await resumeSelectedThreadOrCreate(bridge, setStatus)
        return
      }

      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (state.viewState === 'idle' || state.viewState === 'displaying') {
          await startRecording(bridge, setStatus)
          return
        }

        if (state.viewState === 'recording') {
          await stopRecordingAndSendTurn(bridge, setStatus)
          return
        }

        if (state.viewState === 'waiting' || state.viewState === 'streaming') {
          await interruptActiveTurn(setStatus)
          return
        }

        return
      }

      if (state.viewState === 'error') {
        await reconnectFromError(bridge, setStatus)
        return
      }

      if (state.viewState === 'waiting' || state.viewState === 'streaming') {
        await interruptActiveTurn(setStatus)
        resetTransientTurnState()
        state.screen = 'list'
        setViewState('list')
        await renderPage(bridge)
        setStatus('Codex: turn stopped. Select thread or start new.')
        appendEventLog('Codex: user exited waiting/streaming state')
        return
      }

      if (state.viewState === 'idle' || state.viewState === 'displaying') {
        state.screen = 'list'
        setViewState('list')
        await renderPage(bridge)
        setStatus('Codex: select a thread or start new')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await stopActiveMic(bridge)
      resetTransientTurnState()
      setViewState('error', message)
      state.screen = 'root'
      await renderPage(bridge)
      setStatus(`Codex: ${message}`)
      appendEventLog(`Codex: event handler error - ${message}`)
    } finally {
      state.busy = false
    }
  })

  state.eventLoopRegistered = true
}

function getMockClient(): CodexRuntimeClient {
  return {
    mode: 'mock',
    async connect() {
      appendEventLog('Codex: running in mock mode (bridge unavailable)')
    },
    async action() {
      appendEventLog('Codex: mock action')
    },
  }
}

async function initClient(setStatus: SetStatus, timeoutMs = 6000): Promise<CodexRuntimeClient> {
  try {
    if (!state.bridge) {
      state.bridge = await withTimeout(waitForEvenAppBridge(), timeoutMs)
    }

    ensureWorkingDirectoryControls()
    registerEventLoop(state.bridge, setStatus)

    return {
      mode: 'bridge',
      async connect() {
        await connectToCodex(state.bridge!, setStatus)
      },
      async action() {
        if (!state.bridge) {
          throw new Error('Bridge unavailable')
        }

        if (state.viewState === 'waiting' || state.viewState === 'streaming') {
          await interruptActiveTurn(setStatus)
          return
        }

        await startNewThread(state.bridge, setStatus)
      },
    }
  } catch {
    return getMockClient()
  }
}

let runtimeClient: CodexRuntimeClient | null = null

export function createCodexActions(setStatus: SetStatus): AppActions {
  ensureWorkingDirectoryControls()

  return {
    async connect() {
      setStatus('Codex: connecting...')
      appendEventLog('Codex: connect requested')
      ensureWorkingDirectoryControls()
      updateWorkingDirectoryFromInput()

      try {
        if (!runtimeClient) {
          runtimeClient = await initClient(setStatus)
        }

        await runtimeClient.connect()

        if (runtimeClient.mode === 'bridge') {
          setStatus('Codex: connected. Tap thread to resume or create new.')
          appendEventLog('Codex: bridge connected')
        } else {
          setStatus('Codex: bridge not found. Running mock mode.')
          appendEventLog('Codex: mock mode')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Codex: connection failed - ${message}`)
        appendEventLog(`Codex: connection failed - ${message}`)
      }
    },

    async action() {
      if (!runtimeClient) {
        setStatus('Codex: not connected')
        appendEventLog('Codex: action blocked (not connected)')
        return
      }

      try {
        await runtimeClient.action()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Codex: action failed - ${message}`)
        appendEventLog(`Codex: action failed - ${message}`)
      }
    },
  }
}
