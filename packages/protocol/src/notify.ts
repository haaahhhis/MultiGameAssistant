/**
 * `notify@1`: chat channels (远程连接) that carry incidents, approvals and
 * 助手's conversation (served by `@adg/notify`); `feishu@1` and `qqbot@1`,
 * each channel's own settings (served by `@adg/feishu`, `@adg/qqbot`).
 */
import { z } from 'zod'

export const NOTIFY_CAPABILITY = 'notify'
export const FEISHU_CAPABILITY = 'feishu'
export const QQBOT_CAPABILITY = 'qqbot'

/** Credential holding the Feishu app secret (dsh credentials; never sent back to a UI). */
export const FEISHU_SECRET_REF = 'ADG_FEISHU_APP_SECRET'
/** Credential holding the QQ bot's AppSecret. */
export const QQBOT_SECRET_REF = 'ADG_QQBOT_APP_SECRET'

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
  /**
   * Also send approvals from sessions not started in Feishu (the UI, schedules,
   * game reading) as cards to everyone above. A Feishu conversation's own
   * approvals always go to its person only, whatever this says.
   */
  otherApprovals: z.boolean(),
})
export type FeishuSettings = z.infer<typeof FeishuSettings>

/** Someone not on the list wrote to the bot; the user may allow them. */
export const FeishuPending = z.object({ openId: z.string(), at: z.number(), text: z.string() })
export type FeishuPending = z.infer<typeof FeishuPending>

const FeishuView = z.object({ settings: FeishuSettings, secretConfigured: z.boolean(), pending: z.array(FeishuPending) })

/** Someone allowed to talk to the QQ bot: their user_openid (one per bot). */
export const QQUser = z.object({
  openId: z.string().min(1),
  name: z.string().optional(),
  addedAt: z.number(),
})
export type QQUser = z.infer<typeof QQUser>

/** The QQ official bot (bot.q.qq.com): direct messages over its WebSocket gateway. */
export const QQSettings = z.object({
  enabled: z.boolean(),
  /** 机器人 AppID, from the QQ open platform. */
  appId: z.string().optional(),
  /** Only these people may talk to the agent; notices and 助手's conversation go to them. */
  allowedUsers: z.array(QQUser),
})
export type QQSettings = z.infer<typeof QQSettings>

export const QQPending = z.object({ openId: z.string(), at: z.number(), text: z.string() })
export type QQPending = z.infer<typeof QQPending>

const QQView = z.object({ settings: QQSettings, secretConfigured: z.boolean(), pending: z.array(QQPending) })

export const NotifyRequests = {
  'notify/status': {
    capability: NOTIFY_CAPABILITY,
    params: z.object({}),
    result: z.object({ channels: z.array(ChannelStatus) }),
  },
  /** Conversations people have with the agent through a chat channel (Feishu): which session is whose. */
  'notify/conversations': {
    capability: NOTIFY_CAPABILITY,
    params: z.object({}),
    result: z.object({ items: z.array(z.object({ sessionId: z.string(), channel: z.string(), user: z.string() })) }),
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
      otherApprovals: z.boolean().optional(),
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
  'qqbot/settings': {
    capability: QQBOT_CAPABILITY,
    params: z.object({}),
    result: QQView,
  },
  'qqbot/settings/set': {
    capability: QQBOT_CAPABILITY,
    params: z.object({
      enabled: z.boolean().optional(),
      appId: z.string().trim().regex(/^\d{6,20}$/, 'AppID 是一串数字，在 QQ 开放平台「开发设置」里复制').nullable().optional(),
    }),
    result: QQView,
  },
  'qqbot/users/allow': {
    capability: QQBOT_CAPABILITY,
    params: z.object({ openId: z.string().trim().regex(/^[0-9A-Za-z_-]{8,64}$/, 'user_openid 是一串字母数字（机器人回复你的那条消息里有）'), name: z.string().max(40).optional() }),
    result: QQView,
  },
  /** Take someone off the allowed list, or dismiss a pending one. */
  'qqbot/users/remove': {
    capability: QQBOT_CAPABILITY,
    params: z.object({ openId: z.string() }),
    result: QQView,
  },
  /** Run the self-check again (AppID / AppSecret, the WebSocket gateway). */
  'qqbot/check': {
    capability: QQBOT_CAPABILITY,
    params: z.object({}),
    result: z.object({ checks: z.array(ChannelCheck) }),
  },
} as const

export const NotifyNotifications = {
  /** A channel's state or its settings changed. */
  'notify/changed': z.object({}),
} as const
