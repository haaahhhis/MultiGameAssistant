/**
 * Product areas whose host plugins land in later milestones (docs/PLAN.zh.md §8).
 *
 * Each declares the capability its host plugin will serve, so it stays hidden
 * until that plugin is mounted; the plugin status page lists it meanwhile.
 * When a milestone lands, its entry here is replaced by the real UI plugin.
 */
import type { UiPlugin } from '../../plugins.ts'
import { Placeholder } from './Placeholder.tsx'

export const roadmapPlugins: readonly UiPlugin[] = [
  {
    id: 'pipelines',
    title: '编排',
    milestone: 'M4',
    requires: ['pipelines'],
    pages: [{ id: 'pipelines', title: '编排', icon: 'flow', order: 20, component: Placeholder }],
  },
  {
    id: 'runs',
    title: '运行监控',
    milestone: 'M3',
    requires: ['runs', 'monitor'],
    pages: [{ id: 'runs', title: '运行', icon: 'monitor', order: 30, component: Placeholder }],
  },
  {
    id: 'games',
    title: '游戏看板',
    milestone: 'M6',
    requires: ['games'],
    pages: [{ id: 'games', title: '游戏', icon: 'gamepad', order: 40, component: Placeholder }],
  },
]
