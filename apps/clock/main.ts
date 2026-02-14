import { EvenBetterSdk } from '@jappyjan/even-better-sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'

type ClockClient = {
  mode: 'bridge' | 'mock'
  start: () => Promise<void>
  toggleTicking: () => Promise<void>
}

let clockClient: ClockClient | null = null

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Even bridge not detected within ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(timer))
  })
}

function getMockClockClient(): ClockClient {
  return {
    mode: 'mock',
    async start() {
      console.log('[clock] mock start')
    },
    async toggleTicking() {
      console.log('[clock] mock toggle ticking')
    },
  }
}

function getBridgeClockClient(): ClockClient {
  const sdk = new EvenBetterSdk()
  const page = sdk.createPage('hub-clock-page')

  const title = page.addTextElement('Clock Page')
  title
    .setPosition((position) => position.setX(8).setY(16))
    .setSize((size) => size.setWidth(280).setHeight(44))

  const timeText = page.addTextElement('--:--:--')
  timeText
    .setPosition((position) => position.setX(8).setY(76))
    .setSize((size) => size.setWidth(280).setHeight(56))

  const stateText = page.addTextElement('State: running')
  stateText
    .setPosition((position) => position.setX(8).setY(140))
    .setSize((size) => size.setWidth(280).setHeight(40))

  let isTicking = true
  let intervalId: number | null = null

  const renderNow = () => {
    const now = new Date()
    timeText.setContent(now.toLocaleTimeString([], { hour12: false }))
    void page.render().catch((error) => {
      console.error('[clock] failed to render tick', error)
    })
  }

  const stopTicking = () => {
    if (intervalId !== null) {
      window.clearInterval(intervalId)
      intervalId = null
    }
  }

  const startTicking = () => {
    stopTicking()
    intervalId = window.setInterval(() => {
      if (!isTicking) {
        return
      }
      renderNow()
    }, 1000)
  }

  return {
    mode: 'bridge',
    async start() {
      isTicking = true
      stateText.setContent('State: running')
      renderNow()
      startTicking()
    },
    async toggleTicking() {
      isTicking = !isTicking

      if (isTicking) {
        stateText.setContent('State: running')
        renderNow()
        startTicking()
      } else {
        stateText.setContent('State: paused')
        stopTicking()
        await page.render()
      }
    },
  }
}

async function initClock(timeoutMs = 4000): Promise<{ clock: ClockClient }> {
  try {
    await withTimeout(EvenBetterSdk.getRawBridge(), timeoutMs)

    if (!clockClient || clockClient.mode !== 'bridge') {
      clockClient = getBridgeClockClient()
    }

    return { clock: clockClient }
  } catch {
    return { clock: getMockClockClient() }
  }
}

export function createClockActions(setStatus: SetStatus): AppActions {
  return {
    async connect() {
      setStatus('Clock: connecting to Even bridge...')

      try {
        const { clock } = await initClock()
        clockClient = clock

        await clock.start()

        if (clock.mode === 'bridge') {
          setStatus('Clock: connected and ticking in simulator.')
        } else {
          setStatus('Clock: bridge not found. Running mock mode.')
        }
      } catch (err) {
        console.error(err)
        setStatus('Clock: connection failed')
      }
    },
    async action() {
      if (!clockClient) {
        setStatus('Clock: not connected')
        return
      }

      setStatus('Clock: toggling ticking...')
      await clockClient.toggleTicking()
      setStatus('Clock: toggle applied')
    },
  }
}
