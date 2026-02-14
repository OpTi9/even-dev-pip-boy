import type { AppModule } from '../_shared/app-types'
import { createStarsActions } from './main'

export const app: AppModule = {
  id: 'stars',
  name: 'Stars',
  pageTitle: 'Even Hub Stars',
  connectLabel: 'Connect Stars',
  actionLabel: 'Switch Menu Focus',
  initialStatus: 'Stars app ready',
  createActions: createStarsActions,
}

export default app
