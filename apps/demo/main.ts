import { initEven } from './even'
import type { AppActions, SetStatus } from '../_shared/app-types'

type EvenInstance = Awaited<ReturnType<typeof initEven>>['even']

export function createDemoActions(setStatus: SetStatus): AppActions {
  let evenInstance: EvenInstance | null = null

  return {
    async connect() {
      setStatus('Connecting to Even bridge...')

      try {
        const { even } = await initEven()
        evenInstance = even

        await even.renderStartupScreen()

        if (even.mode === 'bridge') {
          setStatus('Connected. Demo page rendered in Even Hub Simulator.')
        } else {
          setStatus('Bridge not found. Running browser-only mock mode.')
        }
      } catch (err) {
        console.error(err)
        setStatus('Connection failed')
      }
    },
    async action() {
      if (!evenInstance) {
        setStatus('Not connected')
        return
      }

      setStatus('Sending demo action...')

      await evenInstance.sendDemoAction()

      setStatus('Done')
    },
  }
}
