import type { UiPlugin } from '../../plugins.ts'
import { AboutPage } from './AboutPage.tsx'
import { ApiKeysPage } from './ApiKeysPage.tsx'
import { PermissionsPage } from './PermissionsPage.tsx'
import { PersonaPage } from './PersonaPage.tsx'

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

export const personaPlugin: UiPlugin = {
  id: 'persona',
  title: '回复风格',
  requires: ['persona'],
  settingsPages: [{ id: 'persona', title: '回复风格', order: 2, component: PersonaPage }],
}

/** Version, license and source: always there, nothing on the host needed. */
export const aboutPlugin: UiPlugin = {
  id: 'about',
  title: '关于',
  requires: [],
  settingsPages: [{ id: 'about', title: '关于', order: 100, component: AboutPage }],
}
