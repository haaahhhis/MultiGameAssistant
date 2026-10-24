import type { UiPlugin } from '../../plugins.ts'
import { GamesPage } from './GamesPage.tsx'

export const gamesPlugin: UiPlugin = {
  id: 'games',
  title: '游戏看板',
  milestone: 'M6',
  requires: ['games'],
  pages: [{ id: 'games', title: '游戏', icon: 'gamepad', order: -10, component: GamesPage }],
}
