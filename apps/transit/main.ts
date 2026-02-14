import {
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { Itinerary } from '@motis-project/motis-client'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'
import { DEFAULT_CONNECTIONS, STORAGE_KEY, type SavedConnection } from './config'
import { fetchConnections } from './motis'
import { renderDetails } from './pages/details'
import { renderHome } from './pages/home'
import { renderResults } from './pages/results'

type PageState = 'HOME' | 'RESULTS' | 'DETAILS'

const state: {
  bridge: EvenAppBridge | null
  pageState: PageState
  lastSearchResults: Itinerary[]
  savedConnections: SavedConnection[]
  startupRendered: boolean
  eventLoopRegistered: boolean
} = {
  bridge: null,
  pageState: 'HOME',
  lastSearchResults: [],
  savedConnections: [],
  startupRendered: false,
  eventLoopRegistered: false,
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(timer))
  })
}

async function loadSavedConnections(bridge: EvenAppBridge): Promise<SavedConnection[]> {
  try {
    const json = await bridge.getLocalStorage(STORAGE_KEY)
    if (!json) {
      return []
    }

    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed as SavedConnection[]
  } catch (error) {
    console.warn('[transit] could not load saved connections', error)
    return []
  }
}

async function saveConnections(bridge: EvenAppBridge, connections: SavedConnection[]): Promise<void> {
  try {
    await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(connections))
  } catch (error) {
    console.warn('[transit] could not persist saved connections', error)
  }
}

async function showHomePage(bridge: EvenAppBridge): Promise<void> {
  state.savedConnections = await loadSavedConnections(bridge)
  if (state.savedConnections.length === 0) {
    state.savedConnections = DEFAULT_CONNECTIONS
    await saveConnections(bridge, state.savedConnections)
  }

  await renderHome(bridge, !state.startupRendered, state.savedConnections)
  state.startupRendered = true
  state.pageState = 'HOME'
}

async function runSearchForConnection(bridge: EvenAppBridge, connection: SavedConnection): Promise<void> {
  const results = await fetchConnections(connection.from, connection.to)
  state.lastSearchResults = results
  state.pageState = 'RESULTS'
  await renderResults(bridge, results)
}

function getSelectedIndex(event: EvenHubEvent): number {
  const index = event.listEvent?.currentSelectItemIndex
  return typeof index === 'number' ? index : 0
}

function registerEventLoop(bridge: EvenAppBridge, setStatus: SetStatus): void {
  if (state.eventLoopRegistered) {
    return
  }

  bridge.onEvenHubEvent(async (event) => {
    if (event.sysEvent?.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (state.pageState === 'RESULTS') {
        await showHomePage(bridge)
        setStatus('Transit: back to saved routes')
      } else if (state.pageState === 'DETAILS') {
        state.pageState = 'RESULTS'
        await renderResults(bridge, state.lastSearchResults)
        setStatus('Transit: back to connections')
      }
      return
    }

    if (!event.listEvent) {
      return
    }

    const selectedIndex = getSelectedIndex(event)
    if (state.pageState === 'HOME') {
      state.savedConnections = await loadSavedConnections(bridge)
      const selected = state.savedConnections[selectedIndex]
      if (!selected) {
        setStatus('Transit: no saved route at this slot')
        return
      }

      appendEventLog(`Transit: fetching ${selected.from.name} -> ${selected.to.name}`)
      setStatus('Transit: searching connections...')
      await runSearchForConnection(bridge, selected)
      setStatus('Transit: showing connections')
      return
    }

    if (state.pageState === 'RESULTS') {
      const itinerary = state.lastSearchResults[selectedIndex]
      if (!itinerary) {
        setStatus('Transit: no trip details for this selection')
        return
      }

      state.pageState = 'DETAILS'
      await renderDetails(bridge, itinerary)
      setStatus('Transit: showing trip details')
    }
  })

  state.eventLoopRegistered = true
}

export function createTransitActions(setStatus: SetStatus): AppActions {
  return {
    async connect() {
      setStatus('Transit: connecting to Even bridge...')
      appendEventLog('Transit: connect requested')

      try {
        if (!state.bridge) {
          state.bridge = await withTimeout(waitForEvenAppBridge(), 6000, 'waitForEvenAppBridge')
        }

        registerEventLoop(state.bridge, setStatus)
        await showHomePage(state.bridge)

        setStatus('Transit: connected. Use list clicks on glasses to pick routes.')
        appendEventLog('Transit: connected and rendered home')
      } catch (error) {
        console.error('[transit] connect failed', error)
        setStatus('Transit: bridge unavailable')
        appendEventLog('Transit: bridge unavailable')
      }
    },

    async action() {
      if (!state.bridge) {
        setStatus('Transit: not connected')
        appendEventLog('Transit: refresh blocked (not connected)')
        return
      }

      const [firstConnection] = state.savedConnections
      if (!firstConnection) {
        setStatus('Transit: no saved routes')
        appendEventLog('Transit: refresh blocked (no routes)')
        return
      }

      setStatus('Transit: refreshing first saved route...')
      appendEventLog(`Transit: refreshing ${firstConnection.from.name} -> ${firstConnection.to.name}`)

      await runSearchForConnection(state.bridge, firstConnection)

      setStatus('Transit: refreshed departures')
      appendEventLog('Transit: departures refreshed')
    },
  }
}
