/*
 * The 「多游戏助手」 entry in dsh's own sidebar (dsh desktop, or dsh web in a
 * browser), shipped by the dsh plugin package as `lib/client.js`
 * (scripts/package-plugin.mjs). Its page shows this app's UI, which the
 * gateway serves under dsh's web server at /adg/, behind dsh's own login.
 *
 * dsh loads browser plugins in this form (a factory registered with
 * `__ModuleLoader__`, React from dsh's own module table); the sidebar row and
 * the page share one id, as dsh's Automation tasks do.
 */
window.__ModuleLoader__.load({
  id: 'dsh-multigameassistant',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'multigameassistant'

    function Mark() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M9.5 8.3v7.4l6.2-3.7-6.2-3.7Z' }),
        h('path', { d: 'M4 12a8 8 0 0 1 14.5-4.7M20 12a8 8 0 0 1-14.5 4.7' }))
    }

    function Page() {
      return h('iframe', {
        src: '/adg/',
        title: '多游戏助手',
        allow: 'clipboard-read; clipboard-write',
        style: { border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' },
      })
    }

    module.exports.inject = ['slots']
    module.exports.apply = (ctx) => {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Page))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: '多游戏助手' }, Mark))
    }
    return module.exports
  },
})
