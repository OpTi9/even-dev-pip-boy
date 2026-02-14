import { createDemoActions } from './main'
import type { AppModule } from '../_shared/app-types'

export const app: AppModule = {
  id: 'demo',
  name: 'Demo',
  pageTitle: 'Even Hub Demo',
  connectLabel: 'Connect',
  actionLabel: 'Send Demo Action',
  initialStatus: 'Waiting...',
  createActions: createDemoActions,
}

export default app
