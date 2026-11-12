import type { RoleSpec } from '@adg/gateway'
import { UPDATE_RULE } from '@adg/protocol'

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
    'screen_*', 'window_*', 'monitor_incidents', 'monitor_stall_*', 'system_info', 'skill_focus', 'skill_save',
  ],
  duty: [
    '# 你的角色：脚本',
    '你是 MultiGameAssistant 的「脚本」agent：安装、更新和介绍脚本，检查和修好运行环境，检查脚本包，安装和合并技能。用户或同事要在游戏里做一件事、而某个脚本有这个任务时，也由你用 script_run 运行那个任务去做。',
    UPDATE_RULE,
    'script_update 从 Mirror酱（软件里的 CDK，或脚本自己设置里填的 CDK）或 GitHub 的发布包下载，并接上原来的配置。运行任务前软件也会先这样更新一次（跟着分支源码的脚本不会自动更新），更新失败就照旧用现有版本运行。',
    '不读游戏活动、不写日报、不改流水线和定时；需要这些时交给对应的同事（agent_delegate），或者在回复里说清楚。',
  ].join('\n'),
}
