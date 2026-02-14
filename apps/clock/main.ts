import { EvenBetterSdk } from '@jappyjan/even-better-sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'

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
  const timeFormatter = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

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
  let renderInFlight = false

  const renderNow = async () => {
    if (renderInFlight) {
      return
    }

    renderInFlight = true
    const now = new Date()
    timeText.setContent(timeFormatter.format(now))

    try {
      const updated = await timeText.updateWithEvenHubSdk()
      if (!updated) {
        await page.render()
      }
    } catch (error) {
      console.error('[clock] failed to render tick', error)
    } finally {
      renderInFlight = false
    }
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
      void renderNow()
    }, 1000)
  }

  return {
    mode: 'bridge',
    async start() {
      isTicking = true
      stateText.setContent('State: running')
      await page.render()
      await renderNow()
      startTicking()
    },
    async toggleTicking() {
      isTicking = !isTicking

      if (isTicking) {
        stateText.setContent('State: running')
        await page.render()
        await renderNow()
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
      appendEventLog('Clock: connect requested')

      try {
        const { clock } = await initClock()
        clockClient = clock

        await clock.start()

        if (clock.mode === 'bridge') {
          setStatus('Clock: connected and ticking in simulator.')
          appendEventLog('Clock: connected to bridge')
        } else {
          setStatus('Clock: bridge not found. Running mock mode.')
          appendEventLog('Clock: running in mock mode (bridge unavailable)')
        }
      } catch (err) {
        console.error(err)
        setStatus('Clock: connection failed')
        appendEventLog('Clock: connection failed')
      }
    },
    async action() {
      if (!clockClient) {
        setStatus('Clock: not connected')
        appendEventLog('Clock: toggle blocked (not connected)')
        return
      }

      setStatus('Clock: toggling ticking...')
      appendEventLog('Clock: toggling ticking')
      await clockClient.toggleTicking()
      setStatus('Clock: toggle applied')
      appendEventLog('Clock: toggle applied')
    },
  }
}
