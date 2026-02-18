import type { AppActions, AppModule, SetStatus } from '../apps/_shared/app-types'

type WeatherAppModule = {
  app?: AppModule
  default?: AppModule
}

function createWeatherActions(setStatus: SetStatus): AppActions {
  let delegateActions: AppActions | null = null

  async function ensureDelegate(): Promise<AppActions> {
    if (delegateActions) {
      return delegateActions
    }

    const weatherModule = (await import('../apps/weather/g2/index')) as WeatherAppModule
    const weatherApp = weatherModule.app ?? weatherModule.default

    if (!weatherApp || typeof weatherApp.createActions !== 'function') {
      throw new Error('Weather submodule app is invalid')
    }

    delegateActions = await weatherApp.createActions(setStatus)
    return delegateActions
  }

  return {
    async connect() {
      const actions = await ensureDelegate()
      await actions.connect()
    },
    async action() {
      const actions = await ensureDelegate()
      await actions.action()
    },
  }
}

export const app: AppModule = {
  id: 'weather',
  name: 'Weather',
  pageTitle: 'Even Hub Weather',
  connectLabel: 'Connect Weather',
  actionLabel: 'Refresh Weather',
  initialStatus: 'Weather app ready',
  createActions: createWeatherActions,
}

export default app
