import type { AppModule } from '../_shared/app-types'
import { createTransitActions } from './main'

export const app: AppModule = {
  id: 'transit',
  name: 'Transit',
  pageTitle: 'Even Hub Transit',
  connectLabel: 'Connect Transit',
  actionLabel: 'Refresh Departures',
  initialStatus: 'Transit app ready',
  createActions: createTransitActions,
}

export default app
