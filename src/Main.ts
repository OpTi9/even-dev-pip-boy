import type { AppModule } from '../apps/_shared/app-types'

type AppModuleShape = {
  app?: AppModule
  default?: AppModule
}

const appEntryModules = import.meta.glob('../apps/*/index.ts')

type SubmoduleAdapter = {
  id: string
  marker: Record<string, () => Promise<unknown>>
  load: () => Promise<AppModuleShape>
}

const submoduleAdapters: SubmoduleAdapter[] = [
  {
    id: 'reddit',
    marker: import.meta.glob('../apps/reddit/src/even-client.ts'),
    load: () => import('./reddit-submodule-adapter') as Promise<AppModuleShape>,
  },
  {
    id: 'stars',
    marker: import.meta.glob('../apps/stars/src/main.ts'),
    load: () => import('./stars-submodule-adapter') as Promise<AppModuleShape>,
  },
  {
    id: 'epub',
    marker: import.meta.glob('../apps/epub/src/main.ts'),
    load: () => import('./epub-submodule-adapter') as Promise<AppModuleShape>,
  },
  {
    id: 'transit',
    marker: import.meta.glob('../apps/transit/package.json'),
    load: () => import('./transit-submodule-adapter') as Promise<AppModuleShape>,
  },
  {
    id: 'chess',
    marker: import.meta.glob('../apps/chess/package.json'),
    load: () => import('./chess-submodule-adapter') as Promise<AppModuleShape>,
  },
  {
    id: 'weather',
    marker: import.meta.glob('../apps/weather/package.json'),
    load: () => import('./weather-submodule-adapter') as Promise<AppModuleShape>,
  },
]

function extractAppName(modulePath: string): string {
  const match = modulePath.match(/\.\.\/apps\/([^/]+)\/index\.ts$/)
  return match?.[1] ?? ''
}

function discoveredApps(): string[] {
  const names = Object.keys(appEntryModules)
    .map(extractAppName)
    .filter(Boolean)

  for (const adapter of submoduleAdapters) {
    if (Object.keys(adapter.marker).length > 0) {
      names.push(adapter.id)
    }
  }

  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

function getSubmoduleAdapter(appId: string): SubmoduleAdapter | undefined {
  return submoduleAdapters.find((adapter) => (
    adapter.id === appId && Object.keys(adapter.marker).length > 0
  ))
}

function resolveSelectedApp(appNames: string[]): string {
  const envApp = String(import.meta.env.VITE_APP_NAME ?? '')

  if (envApp && appNames.includes(envApp)) {
    return envApp
  }

  if (appNames.includes('demo')) {
    return 'demo'
  }

  return appNames[0] ?? ''
}

function updateStatus(text: string) {
  console.log(`[ui] ${text}`)
  const el = document.getElementById('status')
  if (el) {
    el.textContent = text
  }
}

async function boot() {
  const appNames = discoveredApps()

  if (appNames.length === 0) {
    updateStatus('No apps found in /apps')
    throw new Error('No app modules found. Add apps/<name>/index.ts')
  }

  const selectedAppName = resolveSelectedApp(appNames)
  const modulePath = `../apps/${selectedAppName}/index.ts`
  const importer = appEntryModules[modulePath]
  const adapter = getSubmoduleAdapter(selectedAppName)
  const module = importer
    ? ((await importer()) as AppModuleShape)
    : adapter
      ? await adapter.load()
      : null

  if (!module) {
    updateStatus(`App not found: ${selectedAppName}`)
    throw new Error(`Missing app module: ${modulePath}`)
  }

  const loadedApp = module.app ?? module.default

  if (!loadedApp || typeof loadedApp.createActions !== 'function') {
    updateStatus(`Invalid app module: ${selectedAppName}`)
    throw new Error(`App module ${modulePath} must export 'app' or default with createActions()`)
  }

  const heading = document.querySelector('#app h1')
  const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null
  const actionBtn = document.getElementById('actionBtn') as HTMLButtonElement | null

  if (heading) {
    heading.textContent = loadedApp.pageTitle ?? `Even Hub ${loadedApp.name} App`
  }

  if (connectBtn) {
    connectBtn.textContent = loadedApp.connectLabel ?? `Connect ${loadedApp.name}`
  }

  if (actionBtn) {
    actionBtn.textContent = loadedApp.actionLabel ?? `${loadedApp.name} Action`
  }

  document.title = `Even Demo - ${loadedApp.name}`
  console.log('[app-loader] Selected app', {
    selectedAppName,
    appNames,
  })

  updateStatus(loadedApp.initialStatus ?? `${loadedApp.name} app ready`)
  const actions = await loadedApp.createActions(updateStatus)
  let isConnecting = false
  let isRunningAction = false

  connectBtn?.addEventListener('click', async () => {
    if (isConnecting) {
      return
    }

    isConnecting = true
    if (connectBtn) {
      connectBtn.disabled = true
    }

    try {
      await actions.connect()
    } catch (error) {
      console.error('[app-loader] connect action failed', error)
      updateStatus('Connect action failed')
    } finally {
      isConnecting = false
      if (connectBtn) {
        connectBtn.disabled = false
      }
    }
  })

  actionBtn?.addEventListener('click', async () => {
    if (isRunningAction) {
      return
    }

    isRunningAction = true
    if (actionBtn) {
      actionBtn.disabled = true
    }

    try {
      await actions.action()
    } catch (error) {
      console.error('[app-loader] secondary action failed', error)
      updateStatus('Action failed')
    } finally {
      isRunningAction = false
      if (actionBtn) {
        actionBtn.disabled = false
      }
    }
  })
}

void boot().catch((error) => {
  console.error('[app-loader] boot failed', error)
  updateStatus('App boot failed')
})
