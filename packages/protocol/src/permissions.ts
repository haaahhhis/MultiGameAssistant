/**
 * `permissions@1`: how much the agent may do without asking. `ask` (default):
 * commands run in dsh's sandbox and every approval goes to the user; `full`:
 * no sandbox, and every approval is allowed at once. On top of the mode, each
 * area of what the agent can do (edit pipelines, operate the screen, install
 * scripts…) can be set on its own: allowed without asking, asked every time
 * (even under full access), or not allowed. Served by the gateway.
 */
import { z } from 'zod'

export const PERMISSIONS_CAPABILITY = 'permissions'

export const PermissionMode = z.enum(['ask', 'full'])
export type PermissionMode = z.infer<typeof PermissionMode>

/** `default`: as the mode says. */
export const AreaPolicy = z.enum(['default', 'allow', 'ask', 'deny'])
export type AreaPolicy = z.infer<typeof AreaPolicy>

export interface AgentArea {
  readonly id: string
  readonly title: string
  readonly description: string
  /** The agent tools in it. */
  readonly tools: readonly string[]
  /** dsh's own tools: the setting applies when they ask for approval (they do not always). */
  readonly approvalOnly?: boolean
}

/** Everything the agent can do on its own, by area (tool names as the agent sees them). */
export const AGENT_AREAS: readonly AgentArea[] = [
  { id: 'pipelines-edit', title: '编辑流水线和定时', description: '起草、修改流水线，设定时间（schedule_set），以及 dsh 自己的定时任务。', tools: ['pipeline_draft', 'schedule_set', 'schedule_create', 'schedule_update', 'schedule_delete'] },
  { id: 'run', title: '运行流水线和脚本', description: '启动、停止流水线和脚本任务。', tools: ['pipeline_run', 'script_run', 'script_stop'] },
  { id: 'scripts-config', title: '改脚本配置', description: '修改脚本的配置副本、导入配置、新建选项、打开脚本自己的设置界面、设置游戏位置。', tools: ['script_config_set', 'script_config_import', 'script_choice_create', 'script_settings', 'game_path_set'] },
  { id: 'scripts-install', title: '安装、更新、删除脚本', description: '从 GitHub 安装、更新、回滚、删除脚本，运行脚本的安装程序，导入本地脚本，修复运行环境，起草脚本包。', tools: ['script_install', 'script_update', 'script_rollback', 'script_remove', 'script_setup_run', 'script_import', 'script_env_fix', 'pack_propose'] },
  { id: 'screen', title: '操作屏幕和模拟器', description: '在游戏窗口或模拟器里点击、输入、按键、滑动、切换窗口（截图不算）。', tools: ['screen_tap', 'screen_type', 'screen_key', 'screen_scroll', 'screen_swipe', 'window_focus'] },
  { id: 'games', title: '启动、关闭游戏和模拟器', description: '打开、关掉游戏，启动、关闭、安装、设置模拟器。', tools: ['game_launch', 'game_close', 'emulator_start', 'emulator_stop', 'emulator_install', 'emulator_configure'] },
  { id: 'game-records', title: '记录活动、添加游戏', description: '把读到的活动写进日历，给新游戏建游戏包。', tools: ['game_record', 'game_add'] },
  { id: 'skills', title: '保存技能', description: '把做法存成技能，以后的对话都会用到。', tools: ['skill_save'] },
  { id: 'web', title: '上网查资料', description: '读网页、搜索。', tools: ['web_fetch', 'web_search'] },
  { id: 'shell', title: '运行命令、改文件', description: 'dsh 自带的命令行和文件编辑。只在它请求确认时按这里的设置处理（沙箱里的普通命令不会请求）。', tools: ['pwsh', 'bash', 'edit', 'write'], approvalOnly: true },
]

export function areaOf(toolName: string): AgentArea | undefined {
  return AGENT_AREAS.find(a => a.tools.includes(toolName))
}

export const PermissionsState = z.object({
  mode: PermissionMode,
  /** When the mode last changed. */
  since: z.number().optional(),
  /** Area id → policy; areas not listed are `default`. */
  areas: z.record(z.string(), AreaPolicy).default({}),
  /** Approvals answered "allow" by full access or an area set to allow, newest first (since the host started). */
  recent: z.array(z.object({
    at: z.number(),
    sessionId: z.string(),
    toolName: z.string(),
    reason: z.string().optional(),
  })),
})
export type PermissionsState = z.infer<typeof PermissionsState>

export const PermissionsRequests = {
  'permissions/get': {
    capability: PERMISSIONS_CAPABILITY,
    params: z.object({}),
    result: PermissionsState,
  },
  'permissions/set': {
    capability: PERMISSIONS_CAPABILITY,
    params: z.object({ mode: PermissionMode }),
    result: PermissionsState,
  },
  /** One area's policy. */
  'permissions/area/set': {
    capability: PERMISSIONS_CAPABILITY,
    params: z.object({ area: z.string(), policy: AreaPolicy }),
    result: PermissionsState,
  },
} as const

export const PermissionsNotifications = {
  /** The mode or an area changed, or something was allowed without asking. */
  'permissions/changed': PermissionsState,
} as const
