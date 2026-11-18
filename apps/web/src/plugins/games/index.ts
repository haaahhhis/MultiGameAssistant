import type { UiPlugin } from '../../plugins.ts'
import { GamesPage } from './GamesPage.tsx'
import { ReportPage } from './ReportPage.tsx'

export const gamesPlugin: UiPlugin = {
  id: 'games',
  title: '游戏看板',
  milestone: 'M6',
  requires: ['games'],
  pages: [
    { id: 'games', title: '游戏', icon: 'library', order: -10, component: GamesPage },
    // The 游戏 agent's tab beside its 对话: the daily report is its work.
    { id: 'daily-report', title: '日报', icon: 'send', order: 10, agent: 'games', component: ReportPage },
  ],
}
