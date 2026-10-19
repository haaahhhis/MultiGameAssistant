import type { UiPlugin } from '../../plugins.ts'
import { PipelinesPage } from './PipelinesPage.tsx'
import { ScheduleSettingsPage } from './ScheduleSettingsPage.tsx'

export const pipelinesPlugin: UiPlugin = {
  id: 'pipelines',
  title: '编排',
  milestone: 'M4',
  requires: ['pipelines', 'scripts', 'runs'],
  pages: [{ id: 'pipelines', title: '编排', icon: 'flow', order: 20, component: PipelinesPage }],
}

export const schedulePlugin: UiPlugin = {
  id: 'schedule',
  title: '定时与自启',
  milestone: 'M4',
  requires: ['schedule', 'pipelines'],
  settingsPages: [{ id: 'schedule', title: '定时与自启', order: 9, component: ScheduleSettingsPage }],
}
