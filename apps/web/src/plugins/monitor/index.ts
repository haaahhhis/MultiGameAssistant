import type { UiPlugin } from '../../plugins.ts'
import { RemoteSettingsPage } from './RemoteSettingsPage.tsx'
import { RunsPage } from './RunsPage.tsx'

export const monitorPlugin: UiPlugin = {
  id: 'runs',
  title: '运行监控',
  milestone: 'M3',
  requires: ['runs', 'monitor'],
  pages: [{ id: 'runs', title: '运行', icon: 'monitor', order: 30, agent: 'intervene', component: RunsPage }],
}

/** 远程连接: Feishu and the QQ bot; the page keeps its old id, so links to `#/settings/feishu` still land here. */
export const feishuPlugin: UiPlugin = {
  id: 'feishu',
  title: '远程连接',
  milestone: 'M3',
  requires: ['notify', 'credentials'],
  settingsPages: [{ id: 'feishu', title: '远程连接', order: 12, component: RemoteSettingsPage }],
}
