import { createClockActions } from './main'
import type { AppModule } from '../_shared/app-types'

export const app: AppModule = {
  id: 'clock',
  name: 'Clock',
  pageTitle: 'Even Hub Clock App',
  connectLabel: 'Connect Clock',
  actionLabel: 'Pause / Resume Clock',
  initialStatus: 'Clock app ready',
  createActions: createClockActions,
}

export default app
