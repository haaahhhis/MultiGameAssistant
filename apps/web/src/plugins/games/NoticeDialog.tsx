import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameNotice, GameNoticeDetail } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { ActivityDialog } from './ActivityDialog.tsx'
import { useRemoteImage } from './images.ts'

const NOTICE_KIND = { update: '版本更新', notice: '公告', news: '资讯' }

export function NoticeLabels({ notice, now }: { notice: GameNotice; now: number }) {
  const age = notice.publishedAt === undefined ? undefined : now - notice.publishedAt
  return (
    <>
      <span className="badge" data-notice-kind={notice.kind}>{NOTICE_KIND[notice.kind]}</span>
      {notice.version && <span className="notice-version">{notice.version}</span>}
      {notice.lasting && <span className="badge" title="长期有效的公告">长期</span>}
      {age !== undefined && age >= 0 && age < 3 * 86_400_000 && <span className="badge ok">新</span>}
    </>
  )
}

function ArticleImage({ client, url, title }: { client: AdgClient; url: string; title: string }) {
  const src = useRemoteImage(client, url)
  return src ? <img src={src} alt={title + ' 配图'} /> : null
}

export function NoticeDialog({ client, notice, now, color, onClose }: {
  client: AdgClient; notice: GameNotice; now: number; color: string; onClose: () => void
}) {
  const [detail, setDetail] = useState<GameNoticeDetail>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setFailed(false)
    client.connection.call('games/notice/detail', { game: notice.game, noticeId: notice.id })
      .then(result => { if (active) setDetail(result) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [client, notice.game, notice.id, attempt])

  const summary = detail?.summary?.trim() || notice.summary?.trim()
  const article = detail?.article
  const cover = detail?.cover ?? notice.cover
  const original = notice.url && /^https?:\/\//i.test(notice.url) ? notice.url : undefined
  const published = notice.publishedAt && new Date(notice.publishedAt).toLocaleDateString('zh-CN')
  return (
    <ActivityDialog label={notice.title} color={color} onClose={onClose} className="notice-dialog">
      <header className="dialog-head">
        <div className="dialog-title">
          <h3>{notice.title}</h3>
          <div className="dialog-meta"><NoticeLabels notice={notice} now={now} /><span>{[notice.source.name, published].filter(Boolean).join(' · ')}</span></div>
        </div>
        {original && <a className="small-button notice-original" href={original} target="_blank" rel="noreferrer">查看原文</a>}
        <button className="dialog-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </header>
      <article className="notice-article">
        {summary && <section className="notice-abstract"><h4>摘要</h4><p>{summary}</p></section>}
        {cover && !article?.some(b => b.type === 'image' && b.url === cover) && <ArticleImage key={cover} client={client} url={cover} title={notice.title} />}
        {article?.length ? article.map((block, i) => block.type === 'image'
          ? <ArticleImage key={i + block.url} client={client} url={block.url} title={notice.title} />
          : <p key={i}>{block.text}</p>)
          : <p className="muted small" role="status">{failed ? '正文暂时无法加载。' : detail ? '这条记录尚未收录正文。' : '正在读取正文…'}
              {failed && <button className="link-button small" onClick={() => setAttempt(n => n + 1)}>重试</button>}
            </p>}
      </article>
    </ActivityDialog>
  )
}
