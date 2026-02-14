import { EvenBetterSdk } from '@jappyjan/even-better-sdk'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

type RuntimeMode = 'bridge' | 'mock'

export type EvenClient = {
  mode: RuntimeMode
  renderStartupScreen: () => Promise<void>
  sendDemoAction: () => Promise<void>
}

export type EvenInitOptions = {
  pageId?: string
  title?: string
  subtitle?: string
  inputPrompt?: string
  actionLabel?: string
}

const DEFAULT_OPTIONS: Required<EvenInitOptions> = {
  pageId: 'hub-simulator-demo',
  title: 'Even Hub Simulator Demo',
  subtitle: 'Running without a real device',
  inputPrompt: 'Use Hub buttons to send events',
  actionLabel: 'Action sent',
}

function normalizeOptions(options?: EvenInitOptions): Required<EvenInitOptions> {
  return {
    pageId: options?.pageId ?? DEFAULT_OPTIONS.pageId,
    title: options?.title ?? DEFAULT_OPTIONS.title,
    subtitle: options?.subtitle ?? DEFAULT_OPTIONS.subtitle,
    inputPrompt: options?.inputPrompt ?? DEFAULT_OPTIONS.inputPrompt,
    actionLabel: options?.actionLabel ?? DEFAULT_OPTIONS.actionLabel,
  }
}

const bridgeClients = new Map<string, EvenClient>()

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

function getMockClient(): EvenClient {
  return {
    mode: 'mock',
    async renderStartupScreen() {
      console.log('[mock] Startup screen render skipped (no Even bridge)')
    },
    async sendDemoAction() {
      console.log('[mock] Demo action invoked')
    },
  }
}

function getBridgeClient(options?: EvenInitOptions): EvenClient {
  const resolvedOptions = normalizeOptions(options)
  const sdk = new EvenBetterSdk()
  const page = sdk.createPage(resolvedOptions.pageId)

  const title = page.addTextElement(resolvedOptions.title)
  title
    .setPosition((position) => position.setX(8).setY(16))
    .setSize((size) => size.setWidth(280).setHeight(44))

  const subtitle = page.addTextElement(resolvedOptions.subtitle)
  subtitle
    .setPosition((position) => position.setX(8).setY(64))
    .setSize((size) => size.setWidth(280).setHeight(44))

  const lastInput = page.addTextElement('Last input: waiting...')
  lastInput
    .setPosition((position) => position.setX(8).setY(112))
    .setSize((size) => size.setWidth(280).setHeight(44))

  const inputTarget = page.addListElement([
    resolvedOptions.inputPrompt,
    'Up',
    'Down',
    'Click',
    'DoubleClick',
  ])
  inputTarget
    .setPosition((position) => position.setX(8).setY(164))
    .setSize((size) => size.setWidth(280).setHeight(44))
    .markAsEventCaptureElement()
  inputTarget.setIsItemSelectBorderEn(true)

  const getRawEventType = (event: EvenHubEvent): unknown => {
    const raw = (event.jsonData ?? {}) as Record<string, unknown>

    return (
      event.listEvent?.eventType ??
      event.textEvent?.eventType ??
      event.sysEvent?.eventType ??
      raw.eventType ??
      raw.event_type ??
      raw.Event_Type ??
      raw.type
    )
  }

  const normalizeEventType = (rawEventType: unknown): OsEventTypeList | undefined => {
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

  const eventLabel = (eventType: OsEventTypeList | undefined): string => {
    switch (eventType) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        return 'Up'
      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        return 'Down'
      case OsEventTypeList.CLICK_EVENT:
        return 'Click'
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        return 'DoubleClick'
      default:
        return 'Unknown'
    }
  }

  const handleInputEvent = async (event: EvenHubEvent): Promise<void> => {
    const rawEventType = getRawEventType(event)
    const eventType = normalizeEventType(rawEventType)
    const label = eventLabel(eventType)

    console.log('[even] input event', {
      label,
      rawEventType,
      event,
    })

    const suffix = label === 'Unknown' ? ` (${String(rawEventType ?? 'n/a')})` : ''
    lastInput.setContent(`Last input: ${label}${suffix}`)
    await page.render()
  }

  // Use SDK event listener for both simulator and device bridge events.
  sdk.addEventListener((event) => {
    void handleInputEvent(event)
  })

  return {
    mode: 'bridge',
    async renderStartupScreen() {
      await page.render()
    },
    async sendDemoAction() {
      subtitle.setContent(`${resolvedOptions.actionLabel}: ${new Date().toLocaleTimeString()}`)
      await page.render()
    },
  }
}

export async function initEven(
  timeoutMs = 4000,
  options?: EvenInitOptions,
): Promise<{ even: EvenClient }> {
  try {
    await withTimeout(EvenBetterSdk.getRawBridge(), timeoutMs)
    const clientKey = JSON.stringify(normalizeOptions(options))

    if (!bridgeClients.has(clientKey)) {
      bridgeClients.set(clientKey, getBridgeClient(options))
    }

    return { even: bridgeClients.get(clientKey)! }
  } catch {
    return { even: getMockClient() }
  }
}
