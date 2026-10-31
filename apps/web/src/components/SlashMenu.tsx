import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AdgClient } from '@adg/client-core'
import { expandSlash, slashOptions, type SlashOption, type SlashSkill } from '@adg/protocol'
import { useStore } from '../hooks.ts'

// The agent's skills, shared by every box with a slash menu; read again when a box mounts.
let cached: readonly SlashSkill[] = []

/** The skills people can call with `/name` (skills@1), or none while they load or without the capability. */
export function useSkills(client: AdgClient): readonly SlashSkill[] {
  const capabilities = useStore(client.capabilities)
  const has = capabilities.has('skills')
  const [skills, setSkills] = useState(cached)
  useEffect(() => {
    if (!has) return
    let live = true
    client.connection.call('skills/list', {}).then(r => {
      cached = r.skills.filter(s => s.userInvocable).map(s => ({ name: s.name, description: s.description }))
      if (live) setSkills(cached)
    }, () => {})
    return () => { live = false }
  }, [client, has])
  return skills
}

/**
 * The slash menu of a text box (protocol commands.ts): typing `/` lists the
 * app's commands and the agent's skills, filtered as you type; ↑↓ choose,
 * Tab or a click completes, Enter sends a command that takes nothing more,
 * Esc closes. `submit` gets what was typed (expand it with `expand`).
 */
export function useSlash({ client, text, setText, area, submit, placement = 'above', inSession = false }: {
  client: AdgClient
  text: string
  setText: (text: string) => void
  area: RefObject<HTMLTextAreaElement | null>
  /** Sends a command chosen from the list; leave out where Enter only completes. */
  submit?: ((typed: string) => void) | undefined
  placement?: 'above' | 'below'
  /** In an open conversation: its own commands (/压缩) are offered too. */
  inSession?: boolean
}): { menu: ReactNode; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean; expand: (typed: string) => string } {
  const skills = useSkills(client)
  const [pick, setPick] = useState(0)
  const [closed, setClosed] = useState(false)
  const options = closed ? [] : slashOptions(text, skills, inSession)
  const first = text.split(/\s/)[0]
  useEffect(() => { setPick(0); setClosed(false) }, [first])
  const active = Math.min(pick, Math.max(0, options.length - 1))

  const complete = (o: SlashOption) => {
    setText(`/${o.name} `)
    setClosed(true)
    area.current?.focus()
  }
  const choose = (o: SlashOption) => {
    // Only a command that takes nothing more goes at once; a skill waits for what to do with it.
    if (submit !== undefined && o.kind === 'command' && o.arg === undefined) { setText(''); submit(`/${o.name}`); area.current?.focus(); return }
    complete(o)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (options.length === 0 || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPick((active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
      return true
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      const chosen = options[active]!
      if (e.key === 'Tab') complete(chosen)
      else choose(chosen)
      return true
    }
    if (e.key === 'Escape') { e.preventDefault(); setClosed(true); return true }
    return false
  }
  const menu = options.length === 0 ? null : <SlashMenu options={options} active={active} placement={placement} onHover={setPick} onChoose={choose} />
  return { menu, onKeyDown, expand: typed => expandSlash(typed, skills) }
}

function SlashMenu({ options, active, placement, onHover, onChoose }: {
  options: readonly SlashOption[]
  active: number
  placement: 'above' | 'below'
  onHover: (index: number) => void
  onChoose: (option: SlashOption) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const [tipTop, setTipTop] = useState(0)
  // Keep the highlighted entry in view, and its description beside it.
  useLayoutEffect(() => {
    const item = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (item === null || item === undefined || list.current === null) return
    item.scrollIntoView({ block: 'nearest' })
    setTipTop(item.offsetTop - list.current.scrollTop)
  }, [active, options])
  const current = options[active]
  return (
    <div className={`slash-pop ${placement}`}>
      <div ref={list} className="slash-list" role="listbox" aria-label="命令和技能" onScroll={() => {
        const item = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        if (item !== null && item !== undefined && list.current !== null) setTipTop(item.offsetTop - list.current.scrollTop)
      }}>
        {options.map((o, i) => (
          <div key={`${o.kind}:${o.name}`}>
            {(i === 0 || options[i - 1]!.kind !== o.kind) && <div className="slash-group">{o.kind === 'command' ? '命令' : '技能'}</div>}
            <button type="button" role="option" data-index={i} aria-selected={i === active} className={`slash-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => onHover(i)} onMouseDown={e => e.preventDefault()} onClick={() => onChoose(o)}>
              {o.name}
            </button>
          </div>
        ))}
      </div>
      {current !== undefined && (
        <div className="slash-tip" style={{ top: tipTop }} role="tooltip">
          {current.kind === 'skill' && <span className="slash-tip-kind">技能</span>}
          {current.description}
          {current.kind === 'command' && current.arg !== undefined && <span className="slash-tip-arg">后面可以接：{current.arg}</span>}
          {current.kind === 'skill' && <span className="slash-tip-arg">后面写要它做的事</span>}
        </div>
      )}
    </div>
  )
}
