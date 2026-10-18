import type { UiPlugin } from '../../plugins.ts'
import { ChatView } from './ChatView.tsx'

export const chatPlugin: UiPlugin = {
  id: 'chat',
  title: '对话',
  requires: ['sessions', 'chat'],
  sessionViews: [{ id: 'chat', title: '对话', order: 0, component: ChatView }],
}
