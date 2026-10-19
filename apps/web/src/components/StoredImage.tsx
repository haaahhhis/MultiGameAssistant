import { createContext, useContext, useEffect, useState } from 'react'
import type { AdgClient, ChatImage } from '@adg/client-core'
import { ImageViewer } from './ImageViewer.tsx'

/** The client images are fetched through; provided by the view that shows them. */
export const ImageClient = createContext<AdgClient | null>(null)

/** Fetched images by attachment id; stored images never change. */
const cache = new Map<string, Promise<string>>()

function load(client: AdgClient, image: ChatImage): Promise<string> {
  let url = cache.get(image.attachmentId)
  if (url === undefined) {
    const { attachmentId, mediaType, bytes, width, height } = image
    url = client.connection.call('attachments/image', { attachmentId, mediaType, bytes, width, height }).then(r => `data:${r.mediaType};base64,${r.data}`)
    url.catch(() => cache.delete(image.attachmentId))
    cache.set(image.attachmentId, url)
  }
  return url
}

/** A stored image (a screenshot a tool took, an image the user sent); click to see it full size. */
export function StoredImage({ image }: { image: ChatImage }) {
  const client = useContext(ImageClient)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const available = client?.capabilities.get().has('attachments') === true
  useEffect(() => {
    if (client === null || !available) return
    let live = true
    load(client, image).then(url => { if (live) setSrc(url) }, e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [client, available, image])
  const label = image.name ?? `${image.width}×${image.height} 图片`
  if (!available) return <span className="stored-image missing">{label}（当前后端不支持显示图片）</span>
  if (error !== null) return <span className="stored-image missing">{label}没能加载：{error}</span>
  if (src === null) return <span className="stored-image loading" style={{ aspectRatio: `${image.width} / ${image.height}` }} />
  return (
    <>
      <button className="stored-image" onClick={() => setZoomed(true)} title="点击放大、标注、复制">
        <img src={src} alt={label} width={image.width} height={image.height} />
      </button>
      {zoomed && <ImageViewer src={src} width={image.width} height={image.height} name={image.name ?? 'screenshot.png'} onClose={() => setZoomed(false)} />}
    </>
  )
}
