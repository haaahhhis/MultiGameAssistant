import type { UiPlugin } from '../../plugins.ts'
import { FeishuSettingsPage } from './FeishuSettingsPage.tsx'
import { RunsPage } from './RunsPage.tsx'

export const monitorPlugin: UiPlugin = {
  id: 'runs',
  title: '运行监控',
  milestone: 'M3',
  requires: ['runs', 'monitor'],
  pages: [{ id: 'runs', title: '运行', icon: 'monitor', order: 30, component: RunsPage }],
}

export const feishuPlugin: UiPlugin = {
  id: 'feishu',
  title: '飞书',
  milestone: 'M3',
  requires: ['notify', 'feishu', 'credentials'],
  settingsPages: [{ id: 'feishu', title: '飞书', order: 12, component: FeishuSettingsPage }],
}
