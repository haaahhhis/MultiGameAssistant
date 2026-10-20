import type { UiPlugin } from '../../plugins.ts'
import { ApiKeysPage } from './ApiKeysPage.tsx'
import { PermissionsPage } from './PermissionsPage.tsx'

export const settingsPlugin: UiPlugin = {
  id: 'settings-credentials',
  title: '模型',
  requires: ['credentials', 'models'],
  settingsPages: [{ id: 'api-keys', title: '模型', order: 0, component: ApiKeysPage }],
}

export const permissionsPlugin: UiPlugin = {
  id: 'permissions',
  title: '权限',
  requires: ['permissions'],
  settingsPages: [{ id: 'permissions', title: '权限', order: 1, component: PermissionsPage }],
}
