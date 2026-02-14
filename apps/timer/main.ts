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

type TimerClient = {
  mode: 'bridge' | 'mock'
  start: () => Promise<void>
  startCountdownFromSelection: () => Promise<number>
}

const TIMER_OPTIONS_MINUTES = [1, 5, 15, 60, 120] as const

const state: {
  bridge: EvenAppBridge | null
  startupRendered: boolean
  eventLoopRegistered: boolean
  selectedIndex: number
  isRunning: boolean
  isDone: boolean
  remainingSeconds: number
  intervalId: number | null
  clockIntervalId: number | null
} = {
  bridge: null,
  startupRendered: false,
  eventLoopRegistered: false,
  selectedIndex: 0,
  isRunning: false,
  isDone: false,
  remainingSeconds: TIMER_OPTIONS_MINUTES[0] * 60,
  intervalId: null,
  clockIntervalId: null,
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

function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const seconds = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatCurrentTime(): string {
  const now = new Date()
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
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

function stopCountdown() {
  state.isRunning = false
  if (state.intervalId !== null) {
    window.clearInterval(state.intervalId)
    state.intervalId = null
  }
}

function startClockTicker() {
  if (state.clockIntervalId !== null) {
    return
  }

  state.clockIntervalId = window.setInterval(() => {
    if (!state.bridge || !state.startupRendered || state.isRunning) {
      return
    }

    void updateClockText(state.bridge)
  }, 1000)
}

async function updateClockText(bridge: EvenAppBridge): Promise<void> {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 3,
    containerName: 'timer-now',
    contentOffset: 0,
    contentLength: 16,
    content: formatCurrentTime(),
  }))
}

async function renderPage(bridge: EvenAppBridge): Promise<void> {
  const timerText = state.isRunning
    ? `${formatClock(state.remainingSeconds)} | Dbl Stop`
    : state.isDone
      ? `*** TIME UP *** | Click Start`
      : `${formatClock(state.remainingSeconds)} | Click Start`
  const currentTimeText = formatCurrentTime()

  const titleText = new TextContainerProperty({
    containerID: 1,
    containerName: 'timer-title',
    content: timerText,
    xPosition: 8,
    yPosition: 0,
    width: 300,
    height: 32,
    isEventCapture: 0,
  })

  const nowText = new TextContainerProperty({
    containerID: 3,
    containerName: 'timer-now',
    content: currentTimeText,
    xPosition: 500,
    yPosition: 0,
    width: 72,
    height: 32,
    isEventCapture: 0,
  })

  const config = state.isRunning
    ? {
      containerTotalNum: 3,
      textObject: [titleText, nowText],
      // Keep a tiny active capture container so DoubleClick events still arrive while list is hidden.
      listObject: [new ListContainerProperty({
        containerID: 2,
        containerName: 'timer-hidden-capture',
        itemContainer: new ListItemContainerProperty({
          itemCount: 1,
          itemWidth: 1,
          isItemSelectBorderEn: 0,
          itemName: [' '],
        }),
        isEventCapture: 1,
        xPosition: 0,
        yPosition: 0,
        width: 1,
        height: 1,
      })],
    }
    : {
      containerTotalNum: 3,
      textObject: [titleText, nowText],
      listObject: [new ListContainerProperty({
        containerID: 2,
        containerName: 'timer-list',
        itemContainer: new ListItemContainerProperty({
          itemCount: TIMER_OPTIONS_MINUTES.length,
          itemWidth: 566,
          isItemSelectBorderEn: 1,
          itemName: TIMER_OPTIONS_MINUTES.map((minutes) => `${minutes} min`),
        }),
        isEventCapture: 1,
        xPosition: 4,
        yPosition: 40,
        width: 572,
        height: 248,
      })],
    }

  if (!state.startupRendered) {
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    state.startupRendered = true
    return
  }

  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}

async function startCountdownFromSelection(bridge: EvenAppBridge): Promise<number> {
  const selectedMinutes = TIMER_OPTIONS_MINUTES[state.selectedIndex]
  state.remainingSeconds = selectedMinutes * 60
  state.isRunning = true
  state.isDone = false
  await renderPage(bridge)

  if (state.intervalId !== null) {
    window.clearInterval(state.intervalId)
  }

  state.intervalId = window.setInterval(() => {
    if (!state.isRunning || !state.bridge) {
      return
    }

    state.remainingSeconds = Math.max(0, state.remainingSeconds - 1)
    void renderPage(state.bridge)

    if (state.remainingSeconds === 0) {
      stopCountdown()
      state.isDone = true
      appendEventLog('Timer: completed')
      if (state.bridge) {
        void renderPage(state.bridge)
      }
    }
  }, 1000)

  appendEventLog(`Timer: started ${selectedMinutes} min`)
  return selectedMinutes
}

function registerEventLoop(bridge: EvenAppBridge): void {
  if (state.eventLoopRegistered) {
    return
  }

  bridge.onEvenHubEvent(async (event) => {
    const rawEventType = getRawEventType(event)
    let eventType = normalizeEventType(rawEventType)
    const incomingIndexRaw = event.listEvent?.currentSelectItemIndex
    const incomingName = event.listEvent?.currentSelectItemName
    const incomingMinutesByName = typeof incomingName === 'string'
      ? Number.parseInt(incomingName, 10)
      : Number.NaN
    const incomingIndexByName = Number.isFinite(incomingMinutesByName)
      ? TIMER_OPTIONS_MINUTES.indexOf(incomingMinutesByName as (typeof TIMER_OPTIONS_MINUTES)[number])
      : -1
    const parsedIncomingIndex = typeof incomingIndexRaw === 'number'
      ? incomingIndexRaw
      : typeof incomingIndexRaw === 'string'
        ? Number.parseInt(incomingIndexRaw, 10)
        : incomingIndexByName
    // Some simulator list click events omit index/name for first row; treat as index 0.
    const incomingIndex = event.listEvent && (Number.isNaN(parsedIncomingIndex) || parsedIncomingIndex < 0)
      ? 0
      : parsedIncomingIndex
    const hasIncomingIndex = incomingIndex >= 0 && incomingIndex < TIMER_OPTIONS_MINUTES.length

    // Only infer scroll/click from index delta when bridge does not provide an explicit event type.
    if (eventType === undefined && event.listEvent) {
      if (hasIncomingIndex && incomingIndex > state.selectedIndex) {
        eventType = OsEventTypeList.SCROLL_BOTTOM_EVENT
      } else if (hasIncomingIndex && incomingIndex < state.selectedIndex) {
        eventType = OsEventTypeList.SCROLL_TOP_EVENT
      } else {
        eventType = OsEventTypeList.CLICK_EVENT
      }
    }

    console.log('[timer] input event', {
      rawEventType,
      eventType,
      incomingIndex,
      selectedIndex: state.selectedIndex,
      isRunning: state.isRunning,
      event,
    })

    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      console.log('[timer] double click detected')
      stopCountdown()
      state.isDone = false
      await renderPage(bridge)
      appendEventLog('Timer: stopped')
      return
    }

    if (!event.listEvent) {
      return
    }

    if (
      !hasIncomingIndex &&
      !state.isRunning &&
      (eventType === OsEventTypeList.SCROLL_TOP_EVENT || eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT)
    ) {
      const delta = eventType === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1
      const nextIndex = Math.min(TIMER_OPTIONS_MINUTES.length - 1, Math.max(0, state.selectedIndex + delta))
      if (nextIndex !== state.selectedIndex) {
        state.selectedIndex = nextIndex
        state.remainingSeconds = TIMER_OPTIONS_MINUTES[state.selectedIndex] * 60
        console.log('[timer] start detected via delta fallback selection')
        await startCountdownFromSelection(bridge)
      }
      return
    }

    // Selecting a different row should always start immediately from that value.
    if (hasIncomingIndex && incomingIndex !== state.selectedIndex && !state.isRunning) {
      state.selectedIndex = incomingIndex
      state.remainingSeconds = TIMER_OPTIONS_MINUTES[state.selectedIndex] * 60
      console.log('[timer] start detected on new selection')
      await startCountdownFromSelection(bridge)
      return
    }

    if (!state.isRunning && eventType === OsEventTypeList.CLICK_EVENT) {
      console.log('[timer] click detected')
      await startCountdownFromSelection(bridge)
    }
  })

  state.eventLoopRegistered = true
  console.log('[timer] event listener registered')
}

function getMockTimerClient(): TimerClient {
  return {
    mode: 'mock',
    async start() {
      console.log('[timer] mock start')
    },
    async startCountdownFromSelection() {
      const selected = TIMER_OPTIONS_MINUTES[state.selectedIndex]
      console.log(`[timer] mock start countdown: ${selected}m`)
      return selected
    },
  }
}

async function initTimer(timeoutMs = 6000): Promise<TimerClient> {
  try {
    if (!state.bridge) {
      state.bridge = await withTimeout(waitForEvenAppBridge(), timeoutMs)
    }

    registerEventLoop(state.bridge)

    return {
      mode: 'bridge',
      async start() {
        stopCountdown()
        state.isDone = false
        state.remainingSeconds = TIMER_OPTIONS_MINUTES[state.selectedIndex] * 60
        await renderPage(state.bridge!)
        startClockTicker()
      },
      async startCountdownFromSelection() {
        return startCountdownFromSelection(state.bridge!)
      },
    }
  } catch {
    return getMockTimerClient()
  }
}

let timerClient: TimerClient | null = null

export function createTimerActions(setStatus: SetStatus): AppActions {
  return {
    async connect() {
      setStatus('Timer: connecting to Even bridge...')
      appendEventLog('Timer: connect requested')

      try {
        timerClient = await initTimer()
        await timerClient.start()

        if (timerClient.mode === 'bridge') {
          setStatus('Timer: connected. Up/Down select, Click start, DoubleClick stop.')
          appendEventLog('Timer: connected to bridge')
        } else {
          setStatus('Timer: bridge not found. Running mock mode.')
          appendEventLog('Timer: running in mock mode (bridge unavailable)')
        }
      } catch (error) {
        console.error('[timer] connect failed', error)
        setStatus('Timer: connection failed')
        appendEventLog('Timer: connection failed')
      }
    },
    async action() {
      if (!timerClient) {
        setStatus('Timer: not connected')
        appendEventLog('Timer: start blocked (not connected)')
        return
      }

      const selectedMinutes = await timerClient.startCountdownFromSelection()
      setStatus(`Timer: started ${selectedMinutes} minute countdown`)
    },
  }
}
