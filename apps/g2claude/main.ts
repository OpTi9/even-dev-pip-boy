import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerUpgrade,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'

type ViewState = 'idle' | 'recording' | 'transcribing' | 'waiting' | 'streaming' | 'displaying' | 'error'

type G2ClaudeClient = {
  mode: 'bridge' | 'mock'
  start: () => Promise<void>
  clear: () => Promise<void>
}

type ConversationTurn = {
  prompt: string
  response: string
}

const MAX_WRAP_CHARS = 45
// Epub app pattern: text containers are most reliable at ~9 visible lines.
const DISPLAY_WINDOW_LINES = 9
const SCROLL_COOLDOWN_MS = 80
const SCROLL_LINES_PER_EVENT = 4
const POLL_INTERVAL_MS = 2000
const WAIT_TIMEOUT_MS = 45_000
const PCM_SAMPLE_RATE = 16_000
const MIN_PCM_AUDIO_BYTES = 200
const MAX_HISTORY_TURNS = 10
const THINKING_VERBS = [
  'Thinking',
  'Analyzing',
  'Reasoning',
  'Processing',
  'Considering',
  'Reflecting',
  'Evaluating',
  'Pondering',
]
const THINKING_VERB_INTERVAL_MS = 3500
const THINKING_DOT_INTERVAL_MS = 350
const THINKING_DOTS_MAX = 3
const STREAM_INTERVAL_MS = 120
const STREAM_CHARS_PER_TICK = 8
const SECTION_YOU = '── You ──'
const SECTION_CLAUDE = '── Claude ──'
const SCROLL_TRACK_CHAR = '·'
const SCROLL_THUMB_CHAR = '•'
const WORKDIR_INPUT_ID = 'g2-workdir-input'
const WORKDIR_CONTAINER_ID = 'g2-workdir-controls'
const FALLBACK_WORKING_DIRECTORY = '/home/aza/Desktop'
const TITLE_CONTAINER_ID = 1
const BODY_CONTAINER_ID = 2
const SCROLL_CONTAINER_ID = 3
const TITLE_CONTAINER_NAME = 'g2-title'
const BODY_CONTAINER_NAME = 'g2-body'
const SCROLL_CONTAINER_NAME = 'g2-scroll'

class HttpStatusError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

class StaleOperationError extends Error {
  constructor() {
    super('Stale operation')
    this.name = 'StaleOperationError'
  }
}

const state: {
  bridge: EvenAppBridge | null
  startupRendered: boolean
  eventLoopRegistered: boolean
  viewState: ViewState
  statusLine: string
  errorDetail: string
  sessionId: string | null
  sessionToken: string | null
  defaultWorkingDirectory: string
  workingDirectory: string
  scrollOffset: number
  micOpen: boolean
  pcmAudioChunks: Uint8Array[]
  pcmAudioBytes: number
  pollIntervalId: number | null
  pollTimeoutId: number | null
  pollRequestInFlight: boolean
  runVersion: number
  activeRequestId: string | null
  pendingPrompt: string | null
  conversationHistory: ConversationTurn[]
  currentPrompt: string
  currentResponse: string
  streamingText: string
  streamCharsIndex: number
  streamIntervalId: number | null
  thinkingVerbIndex: number
  thinkingDots: number
  thinkingDotTickCount: number
  thinkingIntervalId: number | null
  lastScrollTime: number
  renderInFlight: boolean
  renderPending: boolean
  renderedTitle: string
  renderedBody: string
  renderedScrollbar: string
  busy: boolean
} = {
  bridge: null,
  startupRendered: false,
  eventLoopRegistered: false,
  viewState: 'idle',
  statusLine: 'Double-tap to start',
  errorDetail: '',
  sessionId: null,
  sessionToken: null,
  defaultWorkingDirectory: FALLBACK_WORKING_DIRECTORY,
  workingDirectory: FALLBACK_WORKING_DIRECTORY,
  scrollOffset: 0,
  micOpen: false,
  pcmAudioChunks: [],
  pcmAudioBytes: 0,
  pollIntervalId: null,
  pollTimeoutId: null,
  pollRequestInFlight: false,
  runVersion: 0,
  activeRequestId: null,
  pendingPrompt: null,
  conversationHistory: [],
  currentPrompt: '',
  currentResponse: '',
  streamingText: '',
  streamCharsIndex: 0,
  streamIntervalId: null,
  thinkingVerbIndex: 0,
  thinkingDots: 1,
  thinkingDotTickCount: 0,
  thinkingIntervalId: null,
  lastScrollTime: 0,
  renderInFlight: false,
  renderPending: false,
  renderedTitle: '',
  renderedBody: '',
  renderedScrollbar: '',
  busy: false,
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
  label.textContent = 'Claude working directory'

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

function stopPolling(): void {
  if (state.pollIntervalId !== null) {
    window.clearInterval(state.pollIntervalId)
    state.pollIntervalId = null
  }
  if (state.pollTimeoutId !== null) {
    window.clearTimeout(state.pollTimeoutId)
    state.pollTimeoutId = null
  }
  state.pollRequestInFlight = false
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
    // ignore close errors and continue local reset
  }

  state.micOpen = false
  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0
}

function isCurrentRun(runVersion: number): boolean {
  return runVersion === state.runVersion
}

function ensureCurrentRun(runVersion: number): void {
  if (!isCurrentRun(runVersion)) {
    throw new StaleOperationError()
  }
}

function isSessionInvalidStatus(status: number): boolean {
  return status === 401 || status === 404
}

function createRequestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function invalidateCurrentRun(): number {
  state.runVersion += 1
  state.activeRequestId = null
  state.pendingPrompt = null
  return state.runVersion
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

function stopStreamingAnimation(): void {
  if (state.streamIntervalId !== null) {
    window.clearInterval(state.streamIntervalId)
    state.streamIntervalId = null
  }
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

function stateToStatusLine(): string {
  switch (state.viewState) {
    case 'idle':
      return state.conversationHistory.length > 0 ? 'Double-tap for new prompt' : 'Double-tap to start'
    case 'recording':
      return 'Listening... double-tap to stop'
    case 'transcribing':
      return 'Transcribing...'
    case 'waiting':
      return `Claude: ${THINKING_VERBS[state.thinkingVerbIndex % THINKING_VERBS.length]}${'.'.repeat(state.thinkingDots)}`
    case 'streaming': {
      const pct = state.currentResponse.length > 0
        ? Math.round((state.streamCharsIndex / state.currentResponse.length) * 100)
        : 0
      return `Receiving... ${pct}%`
    }
    case 'displaying':
      return 'Double-tap for new prompt'
    case 'error':
      return 'Error. Tap to retry'
    default:
      return 'Ready'
  }
}

function wrapLine(rawLine: string): string[] {
  // Keep Unicode text (e.g., Cyrillic) but strip ANSI/control characters.
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

function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\r/g, '')
    .trim()
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

function buildConversationLines(): string[] {
  const lines: string[] = []

  for (const turn of state.conversationHistory) {
    lines.push(SECTION_YOU, ...wrapText(turn.prompt))
    lines.push(SECTION_CLAUDE, ...wrapText(turn.response), '')
  }

  switch (state.viewState) {
    case 'recording':
      lines.push(SECTION_YOU, '(listening...)')
      break
    case 'transcribing':
      lines.push(SECTION_YOU, '(transcribing...)')
      break
    case 'waiting': {
      if (state.currentPrompt) {
        lines.push(SECTION_YOU, ...wrapText(state.currentPrompt))
      }
      lines.push(SECTION_CLAUDE)
      lines.push(`${THINKING_VERBS[state.thinkingVerbIndex % THINKING_VERBS.length]}${'.'.repeat(state.thinkingDots)}`)
      break
    }
    case 'streaming':
      if (state.currentPrompt) {
        lines.push(SECTION_YOU, ...wrapText(state.currentPrompt))
      }
      lines.push(SECTION_CLAUDE)
      if (state.streamingText) {
        lines.push(...wrapText(state.streamingText))
      } else {
        lines.push('...')
      }
      break
    case 'error':
      lines.push('Error:', state.errorDetail)
      break
    case 'idle':
      if (lines.length === 0) {
        lines.push('Double-tap to start')
      }
      break
    default:
      break
  }

  return lines
}

function buildScrollbarLines(totalLines: number): string[] {
  const rows = Array.from({ length: DISPLAY_WINDOW_LINES }, () => SCROLL_TRACK_CHAR)
  const visible = DISPLAY_WINDOW_LINES
  const total = Math.max(visible, totalLines)
  const maxOffset = Math.max(0, total - visible)

  // Scale thumb size by viewport ratio so position feels meaningful.
  const thumbSize = Math.max(1, Math.min(
    visible,
    Math.round((visible * visible) / total),
  ))
  const maxThumbTop = Math.max(0, visible - thumbSize)
  const thumbTop = maxOffset > 0
    ? Math.round((state.scrollOffset / maxOffset) * maxThumbTop)
    : 0

  for (let i = 0; i < thumbSize; i += 1) {
    rows[thumbTop + i] = SCROLL_THUMB_CHAR
  }
  return rows
}

function buildRenderText(): { titleText: string, bodyText: string, scrollbarText: string } {
  state.statusLine = stateToStatusLine()

  const all = buildConversationLines()
  if (all.length === 0) {
    all.push('Ready')
  }

  const maxOffset = Math.max(0, all.length - DISPLAY_WINDOW_LINES)
  if (state.viewState === 'streaming') {
    state.scrollOffset = maxOffset
  } else {
    state.scrollOffset = Math.min(maxOffset, Math.max(0, state.scrollOffset))
  }

  const page = all.slice(
    state.scrollOffset,
    state.scrollOffset + DISPLAY_WINDOW_LINES,
  )
  while (page.length < DISPLAY_WINDOW_LINES) {
    page.push(' ')
  }

  return {
    titleText: state.statusLine,
    bodyText: page.join('\n'),
    scrollbarText: buildScrollbarLines(all.length).join('\n'),
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

function buildTextConfig(titleText: string, bodyText: string, scrollbarText: string): {
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
    isEventCapture: 1,
    content: bodyText,
    xPosition: 8,
    yPosition: 40,
    width: 548,
    height: 248,
  })

  const scrollbar = new TextContainerProperty({
    containerID: SCROLL_CONTAINER_ID,
    containerName: SCROLL_CONTAINER_NAME,
    content: scrollbarText,
    xPosition: 562,
    yPosition: 40,
    width: 10,
    height: 248,
    isEventCapture: 0,
  })

  return {
    containerTotalNum: 3,
    textObject: [title, body, scrollbar],
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
      const { titleText, bodyText, scrollbarText } = buildRenderText()
      const config = buildTextConfig(titleText, bodyText, scrollbarText)

      if (!state.startupRendered) {
        await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
        state.startupRendered = true
        state.renderedTitle = titleText
        state.renderedBody = bodyText
        state.renderedScrollbar = scrollbarText
        continue
      }

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
        await upgradeTextContainer(
          bridge,
          SCROLL_CONTAINER_ID,
          SCROLL_CONTAINER_NAME,
          state.renderedScrollbar,
          scrollbarText,
        )
      } catch {
        await bridge.rebuildPageContainer(new RebuildPageContainer(config))
      }

      state.renderedTitle = titleText
      state.renderedBody = bodyText
      state.renderedScrollbar = scrollbarText
    }
  } finally {
    state.renderInFlight = false
  }
}

function setViewState(next: ViewState, statusOverride?: string): void {
  state.viewState = next
  if (next === 'error') {
    state.errorDetail = typeof statusOverride === 'string' ? statusOverride : 'Unknown error'
    return
  }

  state.errorDetail = ''
}

function startThinkingAnimation(bridge: EvenAppBridge, runVersion: number): void {
  stopThinkingAnimation()
  state.thinkingVerbIndex = 0
  state.thinkingDots = 1
  state.thinkingDotTickCount = 0
  const ticksPerVerb = Math.max(1, Math.round(THINKING_VERB_INTERVAL_MS / THINKING_DOT_INTERVAL_MS))
  state.thinkingIntervalId = window.setInterval(() => {
    if (!isCurrentRun(runVersion) || state.viewState !== 'waiting') {
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

function startStreamingAnimation(
  bridge: EvenAppBridge,
  setStatus: SetStatus,
  runVersion: number,
  fullText: string,
): void {
  if (!isCurrentRun(runVersion)) {
    return
  }

  stopStreamingAnimation()
  state.currentResponse = fullText
  state.streamingText = ''
  state.streamCharsIndex = 0
  setViewState('streaming')
  scrollToBottom(buildConversationLines())
  void renderPage(bridge)

  state.streamIntervalId = window.setInterval(() => {
    if (!isCurrentRun(runVersion) || state.viewState !== 'streaming') {
      stopStreamingAnimation()
      return
    }

    const next = Math.min(state.currentResponse.length, state.streamCharsIndex + STREAM_CHARS_PER_TICK)
    state.streamCharsIndex = next
    state.streamingText = state.currentResponse.slice(0, next)
    scrollToBottom(buildConversationLines())
    void renderPage(bridge)

    if (next >= state.currentResponse.length) {
      stopStreamingAnimation()
      appendConversationTurn(state.currentPrompt, state.currentResponse)
      state.pendingPrompt = null
      state.currentPrompt = ''
      state.currentResponse = ''
      state.streamingText = ''
      state.streamCharsIndex = 0
      setViewState('displaying')
      scrollToBottom(buildConversationLines())
      void renderPage(bridge)
      setStatus('G2 Claude: response received')
      appendEventLog('G2 Claude: response received and rendered')
    }
  }, STREAM_INTERVAL_MS)
}

async function createSession(): Promise<void> {
  const response = await fetch('/__g2_session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new HttpStatusError(message || `Session init failed (${response.status})`, response.status)
  }

  const data = (await response.json()) as {
    sessionId?: unknown
    sessionToken?: unknown
    defaultWorkingDirectory?: unknown
  }
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
  const sessionToken = typeof data.sessionToken === 'string' ? data.sessionToken : ''

  if (!sessionId || !sessionToken) {
    throw new Error('Session init returned invalid credentials')
  }

  const previousDefault = state.defaultWorkingDirectory
  const configuredDefault = typeof data.defaultWorkingDirectory === 'string'
    ? normalizeWorkingDirectoryWithFallback(data.defaultWorkingDirectory, previousDefault)
    : previousDefault
  const isUsingPreviousDefault = !state.workingDirectory || state.workingDirectory === previousDefault

  state.defaultWorkingDirectory = configuredDefault
  if (isUsingPreviousDefault) {
    state.workingDirectory = configuredDefault
  } else {
    state.workingDirectory = normalizeWorkingDirectory(state.workingDirectory)
  }
  syncWorkingDirectoryInput()

  state.sessionId = sessionId
  state.sessionToken = sessionToken
}

async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', audioBlob, 'g2-input.wav')
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

async function sendPrompt(text: string): Promise<void> {
  if (!state.sessionId || !state.sessionToken) {
    throw new Error('No active G2 session')
  }

  updateWorkingDirectoryFromInput()

  const response = await fetch('/__g2_send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      sessionId: state.sessionId,
      sessionToken: state.sessionToken,
      workingDirectory: state.workingDirectory,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new HttpStatusError(message || `Send failed (${response.status})`, response.status)
  }
}

async function recoverAfterSessionInvalid(
  bridge: EvenAppBridge,
  setStatus: SetStatus,
  runVersion: number,
  statusCode: number,
): Promise<void> {
  if (!isCurrentRun(runVersion) || state.viewState !== 'waiting') {
    return
  }

  stopPolling()
  stopThinkingAnimation()
  state.activeRequestId = null

  try {
    await createSession()
  } catch {
    // best-effort rebootstrap for next attempt
  }

  if (!isCurrentRun(runVersion)) {
    return
  }

  state.pendingPrompt = null
  setViewState('error', `Session expired (${statusCode}). Tap retry`)
  appendEventLog(`G2 Claude: session invalid while waiting (${statusCode})`)
  await renderPage(bridge)
  setStatus('G2 Claude: session expired. Tap to retry.')
}

async function sendPromptWithRecovery(
  prompt: string,
  runVersion: number,
  bridge: EvenAppBridge,
  setStatus: SetStatus,
): Promise<void> {
  try {
    await sendPrompt(prompt)
    return
  } catch (error) {
    if (!(error instanceof HttpStatusError) || !isSessionInvalidStatus(error.status)) {
      throw error
    }
  }

  if (!isCurrentRun(runVersion)) {
    throw new StaleOperationError()
  }

  setStatus('G2 Claude: refreshing session...')
  appendEventLog('G2 Claude: session rejected send, refreshing session')
  await createSession()
  ensureCurrentRun(runVersion)
  await renderPage(bridge)
  await sendPrompt(prompt)
}

async function handleWaitingTimeout(
  bridge: EvenAppBridge,
  setStatus: SetStatus,
  runVersion: number,
  requestId: string,
): Promise<void> {
  if (!isCurrentRun(runVersion) || state.activeRequestId !== requestId || state.viewState !== 'waiting') {
    return
  }

  stopPolling()
  stopThinkingAnimation()
  state.activeRequestId = null
  state.pendingPrompt = null
  setViewState('error', 'No response. Tap retry')
  appendEventLog('G2 Claude: timed out waiting for response')
  await renderPage(bridge)
  setStatus('G2 Claude: timeout waiting for response')

  try {
    await createSession()
  } catch {
    // best effort session refresh for next attempt
  }
}

function startPolling(
  bridge: EvenAppBridge,
  setStatus: SetStatus,
  runVersion: number,
  sessionId: string,
  sessionToken: string,
  requestId: string,
): void {
  stopPolling()

  state.pollIntervalId = window.setInterval(() => {
    void (async () => {
      if (!isCurrentRun(runVersion) || state.viewState !== 'waiting') {
        return
      }

      if (state.activeRequestId !== requestId) {
        return
      }

      if (state.pollRequestInFlight) {
        return
      }
      state.pollRequestInFlight = true

      try {
        const response = await fetch(`/__g2_poll?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'GET',
          headers: {
            'x-g2-session-token': sessionToken,
          },
        })

        if (!isCurrentRun(runVersion) || state.activeRequestId !== requestId || state.viewState !== 'waiting') {
          return
        }

        if (!response.ok) {
          if (isSessionInvalidStatus(response.status)) {
            await recoverAfterSessionInvalid(bridge, setStatus, runVersion, response.status)
          }
          return
        }

        const body = (await response.json()) as { text?: unknown }
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return
        }

        const safeText = sanitizeDisplayText(body.text)
        if (!safeText) {
          return
        }

        if (!isCurrentRun(runVersion) || state.activeRequestId !== requestId) {
          return
        }

        stopPolling()
        stopThinkingAnimation()
        state.activeRequestId = null
        state.pendingPrompt = null
        startStreamingAnimation(bridge, setStatus, runVersion, safeText)
        appendEventLog('G2 Claude: streaming response to display')
      } catch {
        // polling should be resilient to temporary failures
      } finally {
        state.pollRequestInFlight = false
      }
    })()
  }, POLL_INTERVAL_MS)

  state.pollTimeoutId = window.setTimeout(() => {
    void handleWaitingTimeout(bridge, setStatus, runVersion, requestId)
  }, WAIT_TIMEOUT_MS)
}

async function startRecording(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  await stopActiveMic(bridge)
  stopThinkingAnimation()
  stopStreamingAnimation()

  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0
  state.currentPrompt = ''
  state.currentResponse = ''
  state.streamingText = ''
  state.streamCharsIndex = 0
  state.pendingPrompt = null

  const opened = await bridge.audioControl(true)
  if (!opened) {
    throw new Error('G2 microphone could not be opened')
  }

  state.micOpen = true
  setViewState('recording')
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('G2 Claude: listening on glasses mic... double-tap again to stop')
  appendEventLog('G2 Claude: glasses mic opened')
}

async function stopRecordingToBlob(bridge: EvenAppBridge): Promise<Blob> {
  if (!state.micOpen) {
    throw new Error('Glasses microphone is not active')
  }

  try {
    await bridge.audioControl(false)
  } catch {
    // keep buffered data; fail only if no audio was captured
  }

  state.micOpen = false
  appendEventLog(`G2 Claude: captured ${state.pcmAudioBytes} bytes from glasses mic`)

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

async function stopRecordingAndSend(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  const runVersion = state.runVersion
  setViewState('transcribing')
  await renderPage(bridge)
  setStatus('G2 Claude: transcribing audio...')

  const audio = await stopRecordingToBlob(bridge)
  ensureCurrentRun(runVersion)
  const prompt = await transcribeAudio(audio)
  ensureCurrentRun(runVersion)
  state.currentPrompt = prompt
  state.pendingPrompt = prompt
  appendEventLog(`G2 Claude: transcript "${prompt.slice(0, 120)}"`)

  setViewState('waiting')
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  ensureCurrentRun(runVersion)
  setStatus('G2 Claude: sending to Claude...')
  await createSession()
  ensureCurrentRun(runVersion)
  const requestId = createRequestId()
  state.activeRequestId = requestId
  await sendPromptWithRecovery(prompt, runVersion, bridge, setStatus)
  ensureCurrentRun(runVersion)

  setStatus('G2 Claude: waiting for response...')
  appendEventLog('G2 Claude: prompt sent, waiting for response')
  startThinkingAnimation(bridge, runVersion)
  if (!state.sessionId || !state.sessionToken) {
    throw new Error('Session not ready for polling')
  }
  startPolling(
    bridge,
    setStatus,
    runVersion,
    state.sessionId,
    state.sessionToken,
    requestId,
  )
}

async function resetToIdle(
  bridge: EvenAppBridge,
  setStatus: SetStatus,
  options: { clearHistory?: boolean } = {},
): Promise<void> {
  invalidateCurrentRun()
  stopPolling()
  stopThinkingAnimation()
  stopStreamingAnimation()
  await stopActiveMic(bridge)
  // Allow immediate user actions after reset even while stale async operations unwind.
  state.busy = false
  if (options.clearHistory) {
    state.conversationHistory = []
  }
  state.currentPrompt = ''
  state.currentResponse = ''
  state.streamingText = ''
  state.streamCharsIndex = 0
  state.pendingPrompt = null
  setViewState('idle')
  scrollToBottom(buildConversationLines())
  await renderPage(bridge)
  setStatus('G2 Claude: ready (double-tap to listen)')
}

function moveScroll(bridge: EvenAppBridge, delta: number): void {
  const all = buildConversationLines()
  if (state.viewState === 'idle' && state.conversationHistory.length === 0) {
    return
  }

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

function registerEventLoop(bridge: EvenAppBridge, setStatus: SetStatus): void {
  if (state.eventLoopRegistered) {
    return
  }

  bridge.onEvenHubEvent(async (event) => {
    if (event.audioEvent && state.viewState === 'recording') {
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

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (!scrollThrottleOk()) {
        return
      }
      moveScroll(bridge, -1)
      return
    }

    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (!scrollThrottleOk()) {
        return
      }
      moveScroll(bridge, 1)
      return
    }

    if (
      eventType !== OsEventTypeList.CLICK_EVENT &&
      eventType !== OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      return
    }

    if (state.busy) {
      return
    }

    state.busy = true

    try {
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
        if (state.viewState === 'idle' || state.viewState === 'displaying') {
          appendEventLog('G2 Claude: double click start recording')
          await startRecording(bridge, setStatus)
          return
        }

        if (state.viewState === 'recording') {
          appendEventLog('G2 Claude: double click stop recording')
          await stopRecordingAndSend(bridge, setStatus)
          return
        }

        return
      }

      if (state.viewState === 'error') {
        appendEventLog('G2 Claude: click retry from error')
        await resetToIdle(bridge, setStatus)
        return
      }

      // Ignore single tap while idle/recording/transcribing/waiting/streaming/displaying.
    } catch (error) {
      if (error instanceof StaleOperationError) {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      stopPolling()
      stopThinkingAnimation()
      stopStreamingAnimation()
      await stopActiveMic(bridge)
      state.activeRequestId = null
      state.pendingPrompt = null
      state.currentPrompt = ''
      state.currentResponse = ''
      state.streamingText = ''
      state.streamCharsIndex = 0
      setViewState('error', message)
      await renderPage(bridge)
      setStatus(`G2 Claude: error - ${message}`)
      appendEventLog(`G2 Claude: error - ${message}`)
    } finally {
      state.busy = false
    }
  })

  state.eventLoopRegistered = true
}

function getMockClient(): G2ClaudeClient {
  return {
    mode: 'mock',
    async start() {
      appendEventLog('G2 Claude: running in mock mode')
    },
    async clear() {
      appendEventLog('G2 Claude: mock clear')
    },
  }
}

async function initClient(setStatus: SetStatus, timeoutMs = 6000): Promise<G2ClaudeClient> {
  try {
    if (!state.bridge) {
      state.bridge = await withTimeout(waitForEvenAppBridge(), timeoutMs)
    }

    registerEventLoop(state.bridge, setStatus)
    await createSession()
    await resetToIdle(state.bridge, setStatus, { clearHistory: true })

    return {
      mode: 'bridge',
      async start() {
        await resetToIdle(state.bridge!, setStatus, { clearHistory: true })
      },
      async clear() {
        await resetToIdle(state.bridge!, setStatus, { clearHistory: true })
      },
    }
  } catch {
    return getMockClient()
  }
}

let g2Client: G2ClaudeClient | null = null

export function createG2ClaudeActions(setStatus: SetStatus): AppActions {
  ensureWorkingDirectoryControls()

  return {
    async connect() {
      setStatus('G2 Claude: connecting to Even bridge...')
      appendEventLog('G2 Claude: connect requested')
      ensureWorkingDirectoryControls()
      updateWorkingDirectoryFromInput()

      try {
        g2Client = await initClient(setStatus)
        await g2Client.start()

        if (g2Client.mode === 'bridge') {
          setStatus('G2 Claude: connected. Double-tap to start/stop recording.')
          appendEventLog('G2 Claude: connected to bridge')
        } else {
          setStatus('G2 Claude: bridge not found. Running mock mode.')
          appendEventLog('G2 Claude: running in mock mode (bridge unavailable)')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`G2 Claude: connection failed - ${message}`)
        appendEventLog(`G2 Claude: connection failed - ${message}`)
      }
    },
    async action() {
      if (!g2Client) {
        setStatus('G2 Claude: not connected')
        appendEventLog('G2 Claude: clear blocked (not connected)')
        return
      }

      await g2Client.clear()
      setStatus('G2 Claude: cleared')
      appendEventLog('G2 Claude: cleared to idle')
    },
  }
}
