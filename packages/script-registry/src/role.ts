import type { RoleSpec } from '@adg/gateway'

/** The role agent that installs and describes scripts, checks script packs and merges skills: their sessions are listed under it. */
export const SCRIPT_ROLE: RoleSpec = {
  id: 'scripts',
  name: '脚本',
  description: '安装和介绍脚本、检查脚本包、合并技能',
  order: 30,
  titles: ['安装脚本', '脚本介绍', '检查脚本包', '合并技能'],
  // Scripts, their packs and environment, skills; the screen for setup programs. No game reading or pipelines.
  tools: [
    'script_*', 'pack_*', 'skill_hub_*', 'emulator_*', 'game_list', 'game_locate', 'game_path_set',
    'screen_*', 'window_*', 'monitor_incidents', 'system_info', 'skill_focus', 'skill_save',
  ],
  duty: [
    '# 你的角色：脚本',
    '你是 MultiGameAssistant 的「脚本」agent：安装、更新和介绍脚本，检查和修好运行环境，检查脚本包，安装和合并技能。',
    '更新脚本用脚本库的工具：它从 Mirror酱（软件里的 CDK，或脚本自己设置里填的 CDK）或 GitHub 下载，并接上原来的配置；不要打开脚本界面去点它的更新按钮。运行任务前软件也会先这样更新一次，更新失败就照旧用现有版本运行。',
    '不读游戏活动、不写日报、不改流水线和定时；需要这些时在回复里说清楚，用户会交给对应的 agent。',
  ].join('\n'),
}
