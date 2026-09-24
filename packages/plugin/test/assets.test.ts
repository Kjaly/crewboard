import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_LIB_DIR, assetRoutes } from '../src/host/assets.js'

function fakeRes() {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status
      res.headers = headers
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk) res.body += chunk.toString()
    },
  }
  return res
}
const req = (method: string, url: string) => ({ method, url }) as IncomingMessage

it('serves the lazily loaded layout engine from the host, since dsh only serves the declared client bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-assets-'))
  await writeFile(join(dir, 'elk.js'), 'window.__orchElk = 1')
  const route = assetRoutes(dir).find((r) => r.path === '/crewboard/assets/elk.js')
  expect(route).toMatchObject({ kind: 'exact', path: '/crewboard/assets/elk.js' })
  const ok = fakeRes()
  await route?.handler(req('GET', '/crewboard/assets/elk.js'), ok as unknown as ServerResponse)
  expect(ok).toMatchObject({ status: 200, body: 'window.__orchElk = 1' })
  expect(ok.headers['content-type']).toContain('javascript')
  const post = fakeRes()
  await route?.handler(req('POST', '/crewboard/assets/elk.js'), post as unknown as ServerResponse)
  expect(post.status).toBe(405)
  const missing = fakeRes()
  await assetRoutes(join(dir, 'nope')).find((r) => r.path === '/crewboard/assets/elk.js')?.handler(req('GET', '/crewboard/assets/elk.js'), missing as unknown as ServerResponse)
  expect(missing.status).toBe(404)
})

it('serves preview renderers as separate assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-preview-assets-'))
  for (const name of ['preview-dxf.js', 'preview-structured.js']) {
    await writeFile(join(dir, name), 'window.preview = true')
    const route = assetRoutes(dir).find((r) => r.path.endsWith('/' + name))!
    const res = fakeRes()
    await route.handler(req('GET', route.path), res as unknown as ServerResponse)
    expect(res).toMatchObject({ status: 200, body: 'window.preview = true' })
  }
})

it('serves each lazy screen asset and rejects missing assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-screen-assets-'))
  for (const name of ['review', 'welcome', 'settings', 'draft', 'ledger', 'trace', 'task']) {
    const path = `/crewboard/assets/screen-${name}.js`
    const route = assetRoutes(dir).find((item) => item.path === path)!
    await writeFile(join(dir, `screen-${name}.js`), `screen:${name}`)
    const ok = fakeRes()
    await route.handler(req('GET', path), ok as unknown as ServerResponse)
    expect(ok).toMatchObject({ status: 200, body: `screen:${name}` })
    expect(ok.headers['cache-control']).toBe('no-cache')
    const post = fakeRes()
    await route.handler(req('POST', path), post as unknown as ServerResponse)
    expect(post.status).toBe(405)
    const missing = fakeRes()
    await assetRoutes(join(dir, 'missing')).find((item) => item.path === path)!.handler(req('GET', path), missing as unknown as ServerResponse)
    expect(missing.status).toBe(404)
  }
})

describe('vendor marks', () => {
  it('lists only the files the owner actually put in the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-vendors-'))
    await writeFile(join(dir, 'claude.svg'), '<svg/>')
    await writeFile(join(dir, 'notes.txt'), 'nope')
    const route = assetRoutes(HOST_LIB_DIR, dir).find((r) => r.path.endsWith('vendors.json'))!
    const res = fakeRes()
    await route.handler({ method: 'GET', url: route.path } as never, res as never)
    expect(JSON.parse(res.body)).toEqual({ vendors: ['claude'] })
  })

  it('serves a mark and answers 404 for one that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-vendors-'))
    await writeFile(join(dir, 'devin.svg'), '<svg id="devin"/>')
    const route = assetRoutes(HOST_LIB_DIR, dir).find((r) => r.kind === 'prefix')!
    const ok = fakeRes()
    await route.handler({ method: 'GET', url: '/crewboard/assets/vendor/devin.svg' } as never, ok as never)
    expect(ok.body).toContain('devin')
    const missing = fakeRes()
    await route.handler({ method: 'GET', url: '/crewboard/assets/vendor/claude.svg' } as never, missing as never)
    expect(missing.status).toBe(404)
  })
})
