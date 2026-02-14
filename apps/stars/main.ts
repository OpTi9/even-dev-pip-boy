import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'

type StarsWindowApi = Window & {
  switchMenuFocus?: () => void
  appState?: {
    isConnected?: boolean
  }
}

export function createStarsActions(setStatus: SetStatus): AppActions {
  let initialized = false

  return {
    async connect() {
      if (!initialized) {
        setStatus('Stars: initializing...')
        appendEventLog('Stars: connect requested')

        try {
          await import('./runtime')
          initialized = true
          appendEventLog('Stars: runtime initialized')
        } catch (error) {
          console.error('[stars] failed to initialize', error)
          appendEventLog('Stars: initialization failed')
          setStatus('Stars: failed to initialize')
          return
        }
      }

      const w = window as StarsWindowApi
      if (w.appState?.isConnected) {
        setStatus('Stars: connected and rendering to simulator')
        appendEventLog('Stars: bridge connected')
      } else {
        setStatus('Stars: running browser mode (bridge unavailable)')
        appendEventLog('Stars: running without bridge')
      }
    },

    async action() {
      const w = window as StarsWindowApi
      if (typeof w.switchMenuFocus !== 'function') {
        setStatus('Stars: not initialized')
        appendEventLog('Stars: switch menu blocked (not initialized)')
        return
      }

      w.switchMenuFocus()
      setStatus('Stars: switched active menu')
      appendEventLog('Stars: switched menu focus')
    },
  }
}
