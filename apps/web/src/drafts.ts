/**
 * What was typed but not sent, per conversation (and for the home page), so
 * switching sessions and coming back finds it again. The text survives a
 * reload (localStorage, this browser only); pasted images only live while the
 * page is open — they are too big to keep.
 */
import type { PromptImage } from '@adg/protocol'

export type DraftImage = PromptImage & { url: string }

const PREFIX = 'adg.draft.'
/** Drafts kept at most; the oldest go first. */
const KEEP = 60
const images = new Map<string, DraftImage[]>()

export function readDraft(key: string): string {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return ''
    const saved = JSON.parse(raw) as { text?: unknown }
    return typeof saved.text === 'string' ? saved.text : ''
  } catch {
    return ''
  }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim() === '') { localStorage.removeItem(PREFIX + key); return }
    localStorage.setItem(PREFIX + key, JSON.stringify({ text, at: Date.now() }))
    prune()
  } catch {
    // storage full or blocked: the draft only lasts while the page is open
  }
}

export function readDraftImages(key: string): DraftImage[] {
  return images.get(key) ?? []
}

export function saveDraftImages(key: string, list: readonly DraftImage[]): void {
  if (list.length === 0) images.delete(key)
  else images.set(key, [...list])
}

function prune(): void {
  const drafts: { key: string; at: number }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key === null || !key.startsWith(PREFIX)) continue
    try { drafts.push({ key, at: Number((JSON.parse(localStorage.getItem(key) ?? '{}') as { at?: unknown }).at) || 0 }) } catch { drafts.push({ key, at: 0 }) }
  }
  if (drafts.length <= KEEP) return
  for (const old of drafts.sort((a, b) => a.at - b.at).slice(0, drafts.length - KEEP)) localStorage.removeItem(old.key)
}
