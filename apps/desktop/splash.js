// Drives splash.html. State comes from the query (?s=…) on load and from
// main.mjs through window.adgSplash.set(state) afterwards:
//   { step: 'env' | 'service' | 'ui', title, hint?, slowHint?,
//     error?: { title, detail?, actions: [{ id, label, primary? }] } }
'use strict'

const STEPS = ['env', 'service', 'ui', 'connect']
/** A hint for a slow step appears after this long. */
const SLOW_MS = 12_000
const $ = id => document.getElementById(id)
const started = Date.now()
let stepSince = Date.now()
let current = { step: 'env', title: '正在启动' }

function set(state) {
  if (state.step !== current.step) stepSince = Date.now()
  current = state
  const failed = state.error !== undefined
  $('boot').classList.toggle('failed', failed)
  $('stage').textContent = failed ? state.error.title : state.title
  $('steps').hidden = failed
  const at = STEPS.indexOf(state.step)
  for (const li of $('steps').children) {
    const i = STEPS.indexOf(li.dataset.step)
    li.classList.toggle('done', i < at)
    li.classList.toggle('now', i === at)
  }
  $('detail').hidden = !failed || !state.error.detail
  $('detail-text').textContent = failed ? state.error.detail ?? '' : ''
  const actions = $('actions')
  actions.replaceChildren()
  const bridge = window.adgDesktop?.splash
  actions.hidden = !failed || bridge === undefined
  if (failed && bridge !== undefined) {
    for (const action of state.error.actions ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      if (action.primary) button.className = 'primary'
      button.addEventListener('click', async () => {
        const answer = await bridge(action.id)
        if (action.id === 'copy' && answer === true) {
          button.textContent = '已复制'
          setTimeout(() => { button.textContent = action.label }, 1500)
        }
      })
      actions.append(button)
    }
    actions.querySelector('.primary')?.focus()
  }
  tick()
}

function tick() {
  const failed = current.error !== undefined
  const seconds = Math.floor((Date.now() - started) / 1000)
  $('elapsed').textContent = failed || seconds < 3 ? '' : `${seconds} 秒`
  const hint = failed ? '' : Date.now() - stepSince > SLOW_MS && current.slowHint ? current.slowHint : current.hint ?? ''
  const el = $('hint')
  if (hint !== '') el.textContent = hint
  el.classList.toggle('shown', hint !== '')
}

window.adgSplash = { set }
try {
  const initial = new URLSearchParams(location.search).get('s')
  if (initial !== null) set(JSON.parse(initial))
} catch {
  // keep the default state
}
setInterval(tick, 1000)
