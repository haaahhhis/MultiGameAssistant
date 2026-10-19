import type { UiPlugin } from '../../plugins.ts'
import { ApiKeysPage } from './ApiKeysPage.tsx'

export const settingsPlugin: UiPlugin = {
  id: 'settings-credentials',
  title: '模型',
  requires: ['credentials', 'models'],
  settingsPages: [{ id: 'api-keys', title: '模型', order: 0, component: ApiKeysPage }],
}
