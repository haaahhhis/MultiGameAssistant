import type { UiPlugin } from '../../plugins.ts'
import { ApiKeysPage } from './ApiKeysPage.tsx'

export const settingsPlugin: UiPlugin = {
  id: 'settings-credentials',
  title: '模型与 API 设置',
  requires: ['credentials', 'models'],
  settingsPages: [{ id: 'api-keys', title: '模型与 API', order: 0, component: ApiKeysPage }],
}
