const paths = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M6 4.5h12A3.5 3.5 0 0 1 21.5 8v6.5A3.5 3.5 0 0 1 18 18h-5.2l-4.3 3.2a.6.6 0 0 1-1-.5V18H6a3.5 3.5 0 0 1-3.5-3.5V8A3.5 3.5 0 0 1 6 4.5ZM8 11.25h.01M12 11.25h.01M16 11.25h.01',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  sparkles: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  close: 'm6 6 12 12M6 18 18 6',
  gauge: 'M12 14l4-4M3.5 15a8.5 8.5 0 1 1 17 0M6.5 19h11',
  popout: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4-4',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  pencil: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4',
  copy: 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'eye-off': 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  chevron: 'm9 6 6 6-6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3ZM12 9v4M12 16.5v.01',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM4 16l5-5 4 4 2-2 5 5M15 9.5v.01',
  paperclip: 'm20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.5v.01',
  key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11 12l8-8M16 7l2 2M14 9l2 2',
  sidebar: 'M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3ZM9.5 4.5v15',
  alert: 'M10.27 4.5a2 2 0 0 1 3.46 0l7.36 12.75A2 2 0 0 1 19.36 20.25H4.64a2 2 0 0 1-1.73-3L10.27 4.5ZM12 9.5v4.25M12 16.75v.01',
  package: 'M11 3.3a2 2 0 0 1 2 0l6.5 3.75a2 2 0 0 1 1 1.73v6.44a2 2 0 0 1-1 1.73L13 20.7a2 2 0 0 1-2 0l-6.5-3.75a2 2 0 0 1-1-1.73V8.78a2 2 0 0 1 1-1.73L11 3.3ZM3.8 7.7 12 12.4l8.2-4.7M12 12.4v8.5',
  flow: 'M5.5 3.75h2.5a1.75 1.75 0 0 1 1.75 1.75V8A1.75 1.75 0 0 1 8 9.75H5.5A1.75 1.75 0 0 1 3.75 8V5.5A1.75 1.75 0 0 1 5.5 3.75ZM16 3.75h2.5a1.75 1.75 0 0 1 1.75 1.75V8a1.75 1.75 0 0 1-1.75 1.75H16A1.75 1.75 0 0 1 14.25 8V5.5A1.75 1.75 0 0 1 16 3.75ZM16 14.25h2.5a1.75 1.75 0 0 1 1.75 1.75v2.5a1.75 1.75 0 0 1-1.75 1.75H16a1.75 1.75 0 0 1-1.75-1.75V16A1.75 1.75 0 0 1 16 14.25ZM9.75 6.75h4.5M17.25 9.75v4.5M6.75 9.75v5a2.5 2.5 0 0 0 2.5 2.5h5',
  monitor: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4ZM9 20h6M12 16v4M6.75 10.25h2.5l1.5-2.75 2.5 5.25 1.5-2.5h2.5',
  gamepad: 'M7.75 6.5h8.5a5 5 0 0 1 4.93 5.83l-.72 4.27a2.6 2.6 0 0 1-4.45 1.37L14.25 16h-4.5l-1.76 1.97a2.6 2.6 0 0 1-4.45-1.37l-.72-4.27A5 5 0 0 1 7.75 6.5ZM8.25 9.75v3.5M6.5 11.5H10M15.25 10.75v.01M17.25 12.75v.01',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5',
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  calendar: 'M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5ZM4 10h16M8.5 3v4M15.5 3v4M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 16.75h.01M12 16.75h.01',
  send: 'M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4 17-6.5Z',
  power: 'M12 3.5v8M7.2 6.5a7 7 0 1 0 9.6 0',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  compress: 'M12 3v6M9 6l3 3 3-3M12 21v-6M9 18l3-3 3 3M4 12h16',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 9h17M3.5 15h17M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6v.01M4.5 12v.01M4.5 18v.01',
  /** 定时: timed tasks and reminders. */
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.5V12l3 2',
  /** 全部活动: every game's events on one timeline. */
  timeline: 'M4.75 5h7.5a1.75 1.75 0 0 1 0 3.5h-7.5a1.75 1.75 0 0 1 0-3.5ZM9.75 10.25h9.5a1.75 1.75 0 0 1 0 3.5h-9.5a1.75 1.75 0 0 1 0-3.5ZM6.75 15.5h6.5a1.75 1.75 0 0 1 0 3.5h-6.5a1.75 1.75 0 0 1 0-3.5Z',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  /** 游戏 (the page): a game library, a card in front with two behind it; not the 游戏 agent's controller. */
  library: 'M6.5 9h11A2.5 2.5 0 0 1 20 11.5v6a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-6A2.5 2.5 0 0 1 6.5 9ZM6.5 6h11M8.5 3.25h7M10.75 12.25v4.5l3.75-2.25-3.75-2.25Z',
  /** Two ways round: a switch between two places. */
  swap: 'M7 4.5 4 7.5l3 3M4 7.5h12.5M17 13.5l3 3-3 3M20 16.5H7.5',
  blank: '',
} as const

export type IconName = keyof typeof paths

/**
 * Two-tone: the shape an icon fills, faintly, under its outline (the rail's
 * avatars and the agent tabs). Icons not here are outline only.
 */
const fills: Partial<Record<IconName, string>> = {
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z',
  timeline: 'M4.75 5h7.5a1.75 1.75 0 0 1 0 3.5h-7.5a1.75 1.75 0 0 1 0-3.5ZM9.75 10.25h9.5a1.75 1.75 0 0 1 0 3.5h-9.5a1.75 1.75 0 0 1 0-3.5ZM6.75 15.5h6.5a1.75 1.75 0 0 1 0 3.5h-6.5a1.75 1.75 0 0 1 0-3.5Z',
  chat: 'M6 4.5h12A3.5 3.5 0 0 1 21.5 8v6.5A3.5 3.5 0 0 1 18 18h-5.2l-4.3 3.2a.6.6 0 0 1-1-.5V18H6a3.5 3.5 0 0 1-3.5-3.5V8A3.5 3.5 0 0 1 6 4.5Z',
  alert: 'M10.27 4.5a2 2 0 0 1 3.46 0l7.36 12.75A2 2 0 0 1 19.36 20.25H4.64a2 2 0 0 1-1.73-3L10.27 4.5Z',
  gamepad: 'M7.75 6.5h8.5a5 5 0 0 1 4.93 5.83l-.72 4.27a2.6 2.6 0 0 1-4.45 1.37L14.25 16h-4.5l-1.76 1.97a2.6 2.6 0 0 1-4.45-1.37l-.72-4.27A5 5 0 0 1 7.75 6.5Z',
  package: 'M3.8 7.7 12 12.4v8.5a2 2 0 0 1-1-.2l-6.5-3.75a2 2 0 0 1-1-1.73V8.78a2 2 0 0 1 .3-1.08Z',
  flow: 'M5.5 3.75h2.5a1.75 1.75 0 0 1 1.75 1.75V8A1.75 1.75 0 0 1 8 9.75H5.5A1.75 1.75 0 0 1 3.75 8V5.5A1.75 1.75 0 0 1 5.5 3.75ZM16 14.25h2.5a1.75 1.75 0 0 1 1.75 1.75v2.5a1.75 1.75 0 0 1-1.75 1.75H16a1.75 1.75 0 0 1-1.75-1.75V16A1.75 1.75 0 0 1 16 14.25Z',
  calendar: 'M6.5 5h11A2.5 2.5 0 0 1 20 7.5V10H4V7.5A2.5 2.5 0 0 1 6.5 5Z',
  monitor: 'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 13.5v-7A2.5 2.5 0 0 1 5.5 4Z',
  library: 'M6.5 9h11A2.5 2.5 0 0 1 20 11.5v6a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-6A2.5 2.5 0 0 1 6.5 9Z',
}

/** Decorative icons only; labels and interactions stay with the calling control. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`ui-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {fills[name] !== undefined && <path className="ui-icon-fill" d={fills[name]} fill="currentColor" stroke="none" />}
      <path d={paths[name]} />
    </svg>
  )
}

/** A filled square, for stop buttons. */
export function StopGlyph() {
  return <svg className="ui-icon stop-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" /></svg>
}

/** The MultiGameAssistant mark: a play triangle inside a rounded tile. */
export function AdgMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`adg-mark ${size}`} aria-hidden="true">
      <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 7.5v9l7.5-4.5L9 7.5Z" /><path d="M4 12a8 8 0 0 1 14.5-4.7M20 12a8 8 0 0 1-14.5 4.7" />
      </svg>
    </span>
  )
}
