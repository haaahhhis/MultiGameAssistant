/** Test helper: a fake Mirror酱 server. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** A fake Mirror酱: `latest` answers by resource, CDK and current_version; packages are served from /dl/. */
export async function fakeMirror(state: { latest: string; cdk: string; full: Uint8Array; incremental?: { from: string; body: Uint8Array }; rid?: string }) {
  const asked: URLSearchParams[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/dl/full.zip') { res.writeHead(200, { 'content-length': state.full.length }); res.end(state.full); return }
    if (url.pathname === '/dl/patch.zip' && state.incremental !== undefined) { res.writeHead(200, { 'content-length': state.incremental.body.length }); res.end(state.incremental.body); return }
    if (url.pathname !== `/api/resources/${state.rid ?? 'Tool'}/latest`) { res.writeHead(404).end(JSON.stringify({ code: 8001, msg: 'resource not found' })); return }
    asked.push(url.searchParams)
    const reply = (body: object) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.searchParams.has('os')) return reply({ code: 8001, msg: 'resource not found' })
    const cdk = url.searchParams.get('cdk')
    if (cdk !== null && cdk !== state.cdk) return reply({ code: 7002, msg: 'invalid cdk' })
    const base = { version_name: state.latest, version_number: 1, channel: 'stable', os: '', arch: '' }
    const current = url.searchParams.get('current_version')
    if (cdk === null || current === state.latest) return reply({ code: 0, msg: 'ok', data: base })
    const inc = state.incremental !== undefined && current === state.incremental.from
    const body = inc ? state.incremental!.body : state.full
    return reply({ code: 0, msg: 'success', data: { ...base, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl/${inc ? 'patch' : 'full'}.zip`, sha256: sha(body), filesize: body.length, update_type: inc ? 'incremental' : 'full', cdk_expired_time: 1824382315 } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
