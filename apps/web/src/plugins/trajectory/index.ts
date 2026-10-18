import type { UiPlugin } from '../../plugins.ts'
import { TrajectoryView } from './TrajectoryView.tsx'

export const trajectoryPlugin: UiPlugin = {
  id: 'trajectory',
  title: '轨迹',
  requires: ['sessions'],
  sessionViews: [{ id: 'trajectory', title: '轨迹', order: 10, component: TrajectoryView }],
}
