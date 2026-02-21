import type { AppModule } from '../_shared/app-types'
import { createCodexActions } from './main'

export const app: AppModule = {
  id: 'codex',
  name: 'Codex',
  pageTitle: 'Codex on G2',
  connectLabel: 'Connect',
  actionLabel: 'New Thread',
  initialStatus: 'Ready',
  createActions: createCodexActions,
}

export default app
