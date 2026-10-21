import type { UiPlugin } from '../../plugins.ts'
import { SkillsPage } from './SkillsPage.tsx'

export const skillsPlugin: UiPlugin = {
  id: 'skills',
  title: '技能',
  requires: ['skills'],
  pages: [{ id: 'skills', title: '技能', icon: 'sparkles', order: 50, component: SkillsPage }],
}
