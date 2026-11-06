import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Activity, ActivityImage, GameInfo, RequestParams } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText } from '../scripts/data.ts'
import { useRemoteImage } from './images.ts'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** The zone's offset from UTC at `at`, in ms. */
function zoneOffset(at: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, Number(x.value)]))
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!) - Math.floor(at / 1000) * 1000
}

/** "UTC+8" for the game's zone. */
function zoneLabel(timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName')?.value ?? ''
  return name.replace('GMT', 'UTC') || timeZone
}

/** `at` as a datetime-local value on the game's wall clock. */
function toInput(at: number | undefined, timeZone: string): string {
  if (at === undefined) return ''
  return new Date(at + zoneOffset(at, timeZone)).toISOString().slice(0, 16)
}

/** A datetime-local value on the game's wall clock as epoch ms. */
function fromInput(value: string, timeZone: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (m === null) return undefined
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return guess - zoneOffset(guess - zoneOffset(guess, timeZone), timeZone)
}

function readImage(file: File): Promise<{ image: ActivityImage; src: string }> {
  return new Promise((resolve, reject) => {
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) { reject(new Error('只支持 png、jpg、gif、webp、avif 图片')); return }
    if (file.size > MAX_IMAGE_BYTES) { reject(new Error('图片太大（最多 8 MB）')); return }
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      resolve({ image: { mediaType: file.type as ActivityImage['mediaType'], data: src.slice(src.indexOf(',') + 1) }, src })
    }
    reader.onerror = () => reject(new Error('图片读不出来'))
    reader.readAsDataURL(file)
  })
}

interface Form { name: string; kind: string; startsAt: string; endsAt: string; url: string; description: string }

/**
 * Add an event of the user's own, or write their word on one: name, kind,
 * dates (in the game's time zone), a page, a description and a picture.
 * Only what was changed is sent, so a field left as the sources say keeps
 * following them.
 */
export function ActivityEditor({ client, game, activity, onDone, onCancel }: {
  client: AdgClient
  game: GameInfo
  /** Absent: a new one. */
  activity?: Activity | undefined
  onDone: (saved: Activity) => void
  onCancel: () => void
}) {
  const tz = game.timezone
  const initial: Form = {
    name: activity?.name ?? '', kind: activity?.kind ?? '',
    startsAt: toInput(activity?.startsAt, tz), endsAt: toInput(activity?.endsAt, tz),
    url: activity?.url ?? '', description: activity?.description ?? '',
  }
  const [form, setForm] = useState<Form>(initial)
  const [image, setImage] = useState<{ image: ActivityImage; src: string } | null>(null)
  const [dropCover, setDropCover] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ownCover = activity?.own?.fields.includes('cover') === true
  const current = useRemoteImage(client, dropCover ? undefined : activity?.cover)
  const preview = image?.src ?? current
  const sourced = activity !== undefined && (activity.sources !== undefined || activity.screen !== undefined)
  useEffect(() => { setError(null) }, [form])

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))
  const pick = (file: File | undefined) => {
    if (file === undefined) return
    readImage(file).then(got => { setImage(got); setDropCover(false) }, e => setError(errorText(e)))
  }
  const paste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find(f => f.type.startsWith('image/'))
    if (file !== undefined) { e.preventDefault(); pick(file) }
  }

  const save = async () => {
    if (form.name.trim() === '') { setError('活动要有名字'); return }
    const start = form.startsAt === '' ? null : fromInput(form.startsAt, tz) ?? null
    const end = form.endsAt === '' ? null : fromInput(form.endsAt, tz) ?? null
    if (start !== null && end !== null && end <= start) { setError('结束时间要晚于开始时间'); return }
    const changed = (key: keyof Form) => activity === undefined || form[key] !== initial[key]
    const text = (key: 'name' | 'kind' | 'url' | 'description') => (changed(key) ? { [key]: form[key].trim() === '' ? null : form[key].trim() } : {})
    const params: RequestParams<'games/activity/save'> = {
      game: game.id,
      ...(activity === undefined ? {} : { activityId: activity.id }),
      ...text('name'), ...text('kind'), ...text('url'), ...text('description'),
      ...(changed('startsAt') ? { startsAt: start } : {}),
      ...(changed('endsAt') ? { endsAt: end } : {}),
      ...(image !== null ? { image: image.image } : dropCover ? { cover: null } : {}),
    }
    setBusy(true)
    setError(null)
    try {
      onDone(await client.connection.call('games/activity/save', params))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="activity-editor" onSubmit={e => { e.preventDefault(); void save() }} onPaste={paste}
      onKeyDown={e => { if (e.key === 'Escape') onCancel() }}>
      <div className="activity-editor-head">
        <strong>{activity === undefined ? `添加${game.name}的活动` : '编辑活动'}</strong>
        {sourced && <span className="muted small">你改的内容比数据站优先，刷新不会改掉；没改的照来源走。</span>}
      </div>
      <div className="activity-editor-body">
        <div className="activity-editor-image">
          <button type="button" className={`activity-image-pick ${preview === undefined ? 'empty' : ''}`} onClick={() => fileRef.current?.click()} title="选一张图片（也可以直接粘贴）">
            {preview !== undefined ? <img src={preview} alt="" /> : <><Icon name="image" /><span>选图片</span><small>或粘贴</small></>}
          </button>
          <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
          {(image !== null || (ownCover && !dropCover)) && (
            <button type="button" className="link-button small muted" onClick={() => { setImage(null); if (ownCover) setDropCover(true) }}>
              {image !== null ? '不用这张' : sourced ? '用回来源的图' : '去掉图片'}
            </button>
          )}
        </div>
        <div className="activity-editor-fields">
          <div className="field-row">
            <label className="field wide"><span className="field-title">活动名</span>
              <input className="text-input plain" autoFocus={activity === undefined} maxLength={60} value={form.name} onChange={set('name')} placeholder="例如：周年庆签到" />
            </label>
            <label className="field"><span className="field-title">类型</span>
              <input className="text-input plain" maxLength={20} value={form.kind} onChange={set('kind')} placeholder="签到、SideStory…" />
            </label>
          </div>
          <div className="field-row">
            <label className="field"><span className="field-title">开始</span>
              <input className="text-input plain" type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
            </label>
            <label className="field"><span className="field-title">结束</span>
              <input className="text-input plain" type="datetime-local" value={form.endsAt} onChange={set('endsAt')} />
            </label>
          </div>
          <span className="muted small">时间按游戏服务器时间（{zoneLabel(tz)}）{form.endsAt === '' ? '；不填结束时间的会一直留着，直到你去掉它' : ''}</span>
          <label className="field"><span className="field-title">活动页面（可选）</span>
            <input className="text-input plain" type="url" value={form.url} onChange={set('url')} placeholder="https://…" />
          </label>
          <label className="field"><span className="field-title">说明（可选）</span>
            <textarea className="text-input plain" rows={2} maxLength={500} value={form.description} onChange={set('description')} placeholder="要做什么、奖励是什么" />
          </label>
        </div>
      </div>
      <div className="activity-editor-actions">
        <button className="small-button primary" type="submit" disabled={busy}>{busy ? '保存中…' : activity === undefined ? '添加' : '保存'}</button>
        <button className="small-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
        {error !== null && <span className="tone-error small">{error}</span>}
      </div>
    </form>
  )
}
