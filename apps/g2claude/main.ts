import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'

type ViewState = 'idle' | 'recording' | 'transcribing' | 'waiting' | 'displaying' | 'error'

type G2ClaudeClient = {
  mode: 'bridge' | 'mock'
  start: () => Promise<void>
  clear: () => Promise<void>
}

const MAX_WRAP_CHARS = 45
const MAX_ITEM_CHARS = 64
const MAX_LIST_ITEMS = 20
const DISPLAY_WINDOW_LINES = 10
const POLL_INTERVAL_MS = 2000
const WAIT_TIMEOUT_MS = 45_000
const PCM_SAMPLE_RATE = 16_000
const MIN_PCM_AUDIO_BYTES = 200

const state: {
  bridge: EvenAppBridge | null
  startupRendered: boolean
  eventLoopRegistered: boolean
  viewState: ViewState
  statusLine: string
  sessionId: string | null
  sessionToken: string | null
  responseText: string
  wrappedLines: string[]
  scrollOffset: number
  micOpen: boolean
  pcmAudioChunks: Uint8Array[]
  pcmAudioBytes: number
  pollIntervalId: number | null
  pollTimeoutId: number | null
  busy: boolean
} = {
  bridge: null,
  startupRendered: false,
  eventLoopRegistered: false,
  viewState: 'idle',
  statusLine: 'Tap to listen',
  sessionId: null,
  sessionToken: null,
  responseText: '',
  wrappedLines: [],
  scrollOffset: 0,
  micOpen: false,
  pcmAudioChunks: [],
  pcmAudioBytes: 0,
  pollIntervalId: null,
  pollTimeoutId: null,
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

function stopPolling(): void {
  if (state.pollIntervalId !== null) {
    window.clearInterval(state.pollIntervalId)
    state.pollIntervalId = null
  }
  if (state.pollTimeoutId !== null) {
    window.clearTimeout(state.pollTimeoutId)
    state.pollTimeoutId = null
  }
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

function stateToStatusLine(): string {
  switch (state.viewState) {
    case 'idle':
      return 'Tap: Mic | Dbl: Reset'
    case 'recording':
      return 'Glasses mic... Tap stop'
    case 'transcribing':
      return 'Transcribing...'
    case 'waiting':
      return 'Waiting for Claude...'
    case 'displaying': {
      const start = state.scrollOffset + 1
      const end = Math.min(state.wrappedLines.length, state.scrollOffset + DISPLAY_WINDOW_LINES)
      return `Resp ${start}-${Math.max(start, end)}/${state.wrappedLines.length}`
    }
    case 'error':
      return 'Error. Tap retry'
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

function getVisibleLines(): string[] {
  if (state.viewState !== 'displaying') {
    return [state.statusLine || 'Tap to record']
  }

  const maxOffset = Math.max(0, state.wrappedLines.length - DISPLAY_WINDOW_LINES)
  state.scrollOffset = Math.min(maxOffset, Math.max(0, state.scrollOffset))

  const page = state.wrappedLines.slice(
    state.scrollOffset,
    state.scrollOffset + DISPLAY_WINDOW_LINES,
  )

  if (page.length === 0) {
    return ['(no response)']
  }

  return page
    .slice(0, MAX_LIST_ITEMS)
    .map((line) => {
      const safe = line.trim().slice(0, MAX_ITEM_CHARS)
      return safe || '-'
    })
}

async function renderPage(bridge: EvenAppBridge): Promise<void> {
  state.statusLine = stateToStatusLine()

  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'g2-title',
    content: state.statusLine,
    xPosition: 8,
    yPosition: 0,
    width: 560,
    height: 36,
    isEventCapture: 0,
  })

  const lines = getVisibleLines()

  const list = new ListContainerProperty({
    containerID: 2,
    containerName: 'g2-list',
    itemContainer: new ListItemContainerProperty({
      itemCount: Math.max(1, Math.min(lines.length, MAX_LIST_ITEMS)),
      itemWidth: 566,
      isItemSelectBorderEn: 0,
      itemName: lines,
    }),
    isEventCapture: 1,
    xPosition: 4,
    yPosition: 40,
    width: 572,
    height: 248,
  })

  const config = {
    containerTotalNum: 2,
    textObject: [title],
    listObject: [list],
  }

  if (!state.startupRendered) {
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    state.startupRendered = true
    return
  }

  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}

function setViewState(next: ViewState, statusOverride?: string): void {
  state.viewState = next
  if (typeof statusOverride === 'string') {
    state.statusLine = statusOverride
  }
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
    throw new Error(message || `Session init failed (${response.status})`)
  }

  const data = (await response.json()) as { sessionId?: unknown, sessionToken?: unknown }
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
  const sessionToken = typeof data.sessionToken === 'string' ? data.sessionToken : ''

  if (!sessionId || !sessionToken) {
    throw new Error('Session init returned invalid credentials')
  }

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

  const response = await fetch('/__g2_send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      sessionId: state.sessionId,
      sessionToken: state.sessionToken,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Send failed (${response.status})`)
  }
}

async function handleWaitingTimeout(bridge: EvenAppBridge): Promise<void> {
  stopPolling()
  setViewState('error', 'No response timeout')
  appendEventLog('G2 Claude: timed out waiting for response')
  await renderPage(bridge)
}

function startPolling(bridge: EvenAppBridge, setStatus: SetStatus): void {
  stopPolling()

  state.pollIntervalId = window.setInterval(() => {
    void (async () => {
      if (state.viewState !== 'waiting') {
        return
      }

      if (!state.sessionId || !state.sessionToken) {
        return
      }

      try {
        const response = await fetch(`/__g2_poll?sessionId=${encodeURIComponent(state.sessionId)}`, {
          method: 'GET',
          headers: {
            'x-g2-session-token': state.sessionToken,
          },
        })

        if (!response.ok) {
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

        stopPolling()
        state.responseText = safeText
        state.wrappedLines = wrapText(safeText)
        state.scrollOffset = 0
        setViewState('displaying')

        await renderPage(bridge)
        setStatus('G2 Claude: response received')
        appendEventLog('G2 Claude: response received and rendered')
      } catch {
        // polling should be resilient to temporary failures
      }
    })()
  }, POLL_INTERVAL_MS)

  state.pollTimeoutId = window.setTimeout(() => {
    void handleWaitingTimeout(bridge)
    setStatus('G2 Claude: timeout waiting for response')
  }, WAIT_TIMEOUT_MS)
}

async function startRecording(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  await stopActiveMic(bridge)

  state.pcmAudioChunks = []
  state.pcmAudioBytes = 0

  const opened = await bridge.audioControl(true)
  if (!opened) {
    throw new Error('G2 microphone could not be opened')
  }

  state.micOpen = true
  setViewState('recording')
  await renderPage(bridge)
  setStatus('G2 Claude: listening on glasses mic... tap again to stop')
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
  setViewState('transcribing')
  await renderPage(bridge)
  setStatus('G2 Claude: transcribing audio...')

  const audio = await stopRecordingToBlob(bridge)
  const prompt = await transcribeAudio(audio)
  appendEventLog(`G2 Claude: transcript "${prompt.slice(0, 120)}"`)

  setViewState('waiting')
  await renderPage(bridge)
  setStatus('G2 Claude: sending to Claude...')
  await sendPrompt(prompt)

  setStatus('G2 Claude: waiting for response...')
  appendEventLog('G2 Claude: prompt sent, waiting for response')
  startPolling(bridge, setStatus)
}

async function resetToIdle(bridge: EvenAppBridge, setStatus: SetStatus): Promise<void> {
  stopPolling()
  await stopActiveMic(bridge)
  state.responseText = ''
  state.wrappedLines = []
  state.scrollOffset = 0
  setViewState('idle')
  await renderPage(bridge)
  setStatus('G2 Claude: ready (tap to listen)')
}

async function moveScroll(bridge: EvenAppBridge, delta: number): Promise<void> {
  if (state.viewState !== 'displaying') {
    return
  }

  const maxOffset = Math.max(0, state.wrappedLines.length - DISPLAY_WINDOW_LINES)
  const next = Math.min(maxOffset, Math.max(0, state.scrollOffset + delta))
  if (next === state.scrollOffset) {
    return
  }

  state.scrollOffset = next
  await renderPage(bridge)
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

    if (eventType === undefined && event.listEvent) {
      eventType = OsEventTypeList.CLICK_EVENT
    }

    if (eventType === undefined) {
      return
    }

    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      appendEventLog('G2 Claude: double click reset')
      await resetToIdle(bridge, setStatus)
      return
    }

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      await moveScroll(bridge, -1)
      return
    }

    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      await moveScroll(bridge, 1)
      return
    }

    if (eventType !== OsEventTypeList.CLICK_EVENT || state.busy) {
      return
    }

    state.busy = true

    try {
      if (state.viewState === 'idle') {
        await startRecording(bridge, setStatus)
        return
      }

      if (state.viewState === 'recording') {
        await stopRecordingAndSend(bridge, setStatus)
        return
      }

      if (state.viewState === 'displaying' || state.viewState === 'error') {
        await resetToIdle(bridge, setStatus)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stopPolling()
      await stopActiveMic(bridge)
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
    await resetToIdle(state.bridge, setStatus)

    return {
      mode: 'bridge',
      async start() {
        await resetToIdle(state.bridge!, setStatus)
      },
      async clear() {
        await resetToIdle(state.bridge!, setStatus)
      },
    }
  } catch {
    return getMockClient()
  }
}

let g2Client: G2ClaudeClient | null = null

export function createG2ClaudeActions(setStatus: SetStatus): AppActions {
  return {
    async connect() {
      setStatus('G2 Claude: connecting to Even bridge...')
      appendEventLog('G2 Claude: connect requested')

      try {
        g2Client = await initClient(setStatus)
        await g2Client.start()

        if (g2Client.mode === 'bridge') {
          setStatus('G2 Claude: connected. Tap to use glasses mic, tap again to stop.')
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
