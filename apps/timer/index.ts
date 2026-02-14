import { createTimerActions } from './main'
import type { AppModule } from '../_shared/app-types'

export const app: AppModule = {
  id: 'timer',
  name: 'Timer',
  pageTitle: 'Even Hub Timer App',
  connectLabel: 'Connect Timer',
  actionLabel: 'Start Timer',
  initialStatus: 'Timer app ready',
  createActions: createTimerActions,
}

export default app
