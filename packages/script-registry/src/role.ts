import type { RoleSpec } from '@adg/gateway'

/** The role agent that installs and describes scripts, checks script packs and merges skills: their sessions are listed under it. */
export const SCRIPT_ROLE: RoleSpec = {
  id: 'scripts',
  name: '脚本',
  description: '安装和介绍脚本、检查脚本包、合并技能',
  order: 30,
  titles: ['安装脚本', '脚本介绍', '检查脚本包', '合并技能'],
}
