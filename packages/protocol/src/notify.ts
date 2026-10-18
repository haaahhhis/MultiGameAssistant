/**
 * `notify@1`: chat channels that carry incidents, approvals and conversations
 * with the agent (served by `@adg/notify`), and `feishu@1`, the Feishu
 * channel's own settings (served by `@adg/feishu`).
 */
import { z } from 'zod'

export const NOTIFY_CAPABILITY = 'notify'
export const FEISHU_CAPABILITY = 'feishu'

/** Credential holding the Feishu app secret (dsh credentials; never sent back to a UI). */
export const FEISHU_SECRET_REF = 'ADG_FEISHU_APP_SECRET'

export const ChannelCheck = z.object({
  id: z.string(),
  label: z.string(),
  /** `null`: not checked yet. */
  ok: z.boolean().nullable(),
  detail: z.string().optional(),
})
export type ChannelCheck = z.infer<typeof ChannelCheck>

export const ChannelStatus = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(['off', 'connecting', 'ready', 'error']),
  detail: z.string().optional(),
  /** People notices go to. */
  recipients: z.number().int().min(0),
  checks: z.array(ChannelCheck),
})
export type ChannelStatus = z.infer<typeof ChannelStatus>

export const FeishuUser = z.object({
  openId: z.string().min(1),
  name: z.string().optional(),
  addedAt: z.number(),
})
export type FeishuUser = z.infer<typeof FeishuUser>

export const FeishuSettings = z.object({
  enabled: z.boolean(),
  appId: z.string().optional(),
  /** `feishu` (open.feishu.cn) or `lark` (open.larksuite.com). */
  domain: z.enum(['feishu', 'lark']),
  /** Only these people may talk to the agent; notices go to them. */
  allowedUsers: z.array(FeishuUser),
  /** Also post notices to this group chat (`oc_…`). */
  chatId: z.string().optional(),
  /** Send approval requests as cards (answered by whoever is first: UI or Feishu). */
  approvals: z.boolean(),
})
export type FeishuSettings = z.infer<typeof FeishuSettings>

/** Someone not on the list wrote to the bot; the user may allow them. */
export const FeishuPending = z.object({ openId: z.string(), at: z.number(), text: z.string() })
export type FeishuPending = z.infer<typeof FeishuPending>

const FeishuView = z.object({ settings: FeishuSettings, secretConfigured: z.boolean(), pending: z.array(FeishuPending) })

export const NotifyRequests = {
  'notify/status': {
    capability: NOTIFY_CAPABILITY,
    params: z.object({}),
    result: z.object({ channels: z.array(ChannelStatus) }),
  },
  /** Send a test notice through one channel, or all. */
  'notify/test': {
    capability: NOTIFY_CAPABILITY,
    params: z.object({ channel: z.string().optional() }),
    result: z.object({ sent: z.array(z.string()), failed: z.array(z.object({ channel: z.string(), error: z.string() })) }),
  },
  'feishu/settings': {
    capability: FEISHU_CAPABILITY,
    params: z.object({}),
    result: FeishuView,
  },
  'feishu/settings/set': {
    capability: FEISHU_CAPABILITY,
    params: z.object({
      enabled: z.boolean().optional(),
      appId: z.string().trim().regex(/^cli_[0-9a-fA-F]{16}$/, 'App ID 是 cli_ 加 16 位字母数字，在「凭证与基础信息」里复制').nullable().optional(),
      domain: z.enum(['feishu', 'lark']).optional(),
      chatId: z.string().trim().regex(/^oc_[A-Za-z0-9]+$/, '群 ID 以 oc_ 开头').nullable().optional(),
      approvals: z.boolean().optional(),
    }),
    result: FeishuView,
  },
  'feishu/users/allow': {
    capability: FEISHU_CAPABILITY,
    params: z.object({ openId: z.string().trim().regex(/^ou_[A-Za-z0-9]+$/, 'open_id 以 ou_ 开头'), name: z.string().max(40).optional() }),
    result: FeishuView,
  },
  /** Take someone off the allowed list, or dismiss a pending one. */
  'feishu/users/remove': {
    capability: FEISHU_CAPABILITY,
    params: z.object({ openId: z.string() }),
    result: FeishuView,
  },
  /** Run the self-check again (credentials, bot, long connection). */
  'feishu/check': {
    capability: FEISHU_CAPABILITY,
    params: z.object({}),
    result: z.object({ checks: z.array(ChannelCheck) }),
  },
} as const

export const NotifyNotifications = {
  /** A channel's state or the Feishu settings changed. */
  'notify/changed': z.object({}),
} as const
