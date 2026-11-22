import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameNotice, GameNoticeDetail } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { ActivityDialog } from './ActivityDialog.tsx'
import { useRemoteImage } from './images.ts'

function ArticleImage({ client, url, title }: { client: AdgClient; url: string; title: string }) {
  const src = useRemoteImage(client, url)
  return src ? <img src={src} alt={title + ' 配图'} /> : null
}

export function NoticeDialog({ client, notice, kind, color, onClose }: {
  client: AdgClient; notice: GameNotice; kind: string; color: string; onClose: () => void
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

  const article = detail?.article
  const cover = detail?.cover ?? notice.cover
  const original = notice.url && /^https?:\/\//i.test(notice.url) ? notice.url : undefined
  const published = notice.publishedAt && new Date(notice.publishedAt).toLocaleDateString('zh-CN')
  return (
    <ActivityDialog label={notice.title} color={color} onClose={onClose} className="notice-dialog">
      <header className="dialog-head">
        <div className="dialog-title">
          <h3>{notice.title}</h3>
          <div className="dialog-meta">{[kind, notice.version, notice.source.name, published].filter(Boolean).join(' · ')}</div>
        </div>
        {original && <a className="small-button notice-original" href={original} target="_blank" rel="noreferrer">查看原文</a>}
        <button className="dialog-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </header>
      <article className="notice-article">
        {cover && !article?.some(b => b.type === 'image' && b.url === cover) && <ArticleImage key={cover} client={client} url={cover} title={notice.title} />}
        {article?.length ? article.map((block, i) => block.type === 'image'
          ? <ArticleImage key={i + block.url} client={client} url={block.url} title={notice.title} />
          : <p key={i}>{block.text}</p>)
          : <>
            <p className="muted small" role="status">{failed ? '正文暂时无法加载。' : detail ? '这条记录尚未收录正文。' : '正在读取正文…'}
              {failed && <button className="link-button small" onClick={() => setAttempt(n => n + 1)}>重试</button>}
            </p>
            {notice.summary && <p><strong>摘要</strong><br />{notice.summary}</p>}
          </>}
      </article>
    </ActivityDialog>
  )
}
