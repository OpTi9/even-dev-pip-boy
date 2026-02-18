import { createG2ClaudeActions } from './main'
import type { AppModule } from '../_shared/app-types'

export const app: AppModule = {
  id: 'g2claude',
  name: 'G2 Claude',
  pageTitle: 'Claude on G2',
  connectLabel: 'Connect',
  actionLabel: 'Clear',
  initialStatus: 'Ready',
  createActions: createG2ClaudeActions,
}

export default app
