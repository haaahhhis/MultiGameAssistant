const paths = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
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
  copy: 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
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
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v4M12 17v.01',
  package: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12v9M12 12 4 7.5',
  flow: 'M5 4h4v4H5zM15 16h4v4h-4zM15 4h4v4h-4zM9 6h6M17 8v8M7 8v6a2 2 0 0 0 2 2h6',
  monitor: 'M4 5h16v11H4zM9 20h6M12 16v4M7 12l2.5-3 2.5 2 3-4 2 2',
  gamepad: 'M7 9v4M5 11h4M15 10.5v.01M17.5 12.5v.01M6.5 6h11a4 4 0 0 1 4 4.4l-.6 5.3a2.6 2.6 0 0 1-4.5 1.4L14.5 15h-5l-1.9 2.1a2.6 2.6 0 0 1-4.5-1.4l-.6-5.3A4 4 0 0 1 6.5 6Z',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  home: 'M4 11 12 4l8 7M6 9.5V20h12V9.5',
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  calendar: 'M5 5.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1ZM4 10h16M8 3.5v4M16 3.5v4M8 14h2M14 14h2M8 17h2',
  send: 'M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4 17-6.5Z',
} as const

export type IconName = keyof typeof paths

/** Decorative icons only; labels and interactions stay with the calling control. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`ui-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}

/** A filled square, for stop buttons. */
export function StopGlyph() {
  return <svg className="ui-icon stop-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" /></svg>
}

/** The AutoDailyGamePlay mark: a play triangle inside a rounded tile. */
export function AdgMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`adg-mark ${size}`} aria-hidden="true">
      <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 7.5v9l7.5-4.5L9 7.5Z" /><path d="M4 12a8 8 0 0 1 14.5-4.7M20 12a8 8 0 0 1-14.5 4.7" />
      </svg>
    </span>
  )
}
