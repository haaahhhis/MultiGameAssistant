import type { UiPlugin } from '../../plugins.ts'
import { PluginsPage } from './PluginsPage.tsx'

export const statusPlugin: UiPlugin = {
  id: 'plugin-status',
  title: '插件状态',
  requires: [],
  settingsPages: [{ id: 'plugins', title: '插件状态', order: 90, component: PluginsPage }],
}
