import type { UiPlugin } from '../../plugins.ts'
import { InstallSettingsPage } from './InstallSettingsPage.tsx'
import { ScriptsPage } from './ScriptsPage.tsx'

export const scriptsPlugin: UiPlugin = {
  id: 'scripts',
  title: '脚本库',
  milestone: 'M1',
  requires: ['scripts'],
  pages: [{ id: 'scripts', title: '脚本', icon: 'package', order: 10, component: ScriptsPage }],
  settingsPages: [{ id: 'script-install', title: '脚本安装', order: 10, component: InstallSettingsPage }],
}
