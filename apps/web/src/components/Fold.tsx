import { useState, type ReactNode } from 'react'
import { Icon } from './Icons.tsx'

const read = (key: string, fallback: boolean): boolean => {
  try {
    const value = localStorage.getItem(`adg.fold.${key}`)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

/** Open or folded, remembered per list in this browser. */
export function useFold(key: string, initial = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => read(key, initial))
  const toggle = () => setOpen(o => {
    try { localStorage.setItem(`adg.fold.${key}`, o ? '0' : '1') } catch { /* private window: not remembered */ }
    return !o
  })
  return [open, toggle]
}

/** A heading that folds what follows it. */
export function FoldHead({ open, onToggle, children, count, className = '' }: { open: boolean; onToggle: () => void; children: ReactNode; count?: number; className?: string }) {
  return (
    <button type="button" className={`fold-head ${className}`} aria-expanded={open} onClick={onToggle}>
      <Icon name="chevron" className={`fold-chevron ${open ? 'open' : ''}`} />
      <span className="fold-title">{children}</span>
      {count !== undefined && <span className="fold-count">{count}</span>}
    </button>
  )
}

/** A folding section: heading plus body. */
export function Fold({ id, title, count, initial = true, children, className = '' }: { id: string; title: ReactNode; count?: number; initial?: boolean; children: ReactNode; className?: string }) {
  const [open, toggle] = useFold(id, initial)
  return (
    <div className={`fold ${className}`}>
      <FoldHead open={open} onToggle={toggle} {...(count === undefined ? {} : { count })}>{title}</FoldHead>
      {open && children}
    </div>
  )
}
