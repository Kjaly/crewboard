import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { readStream, startApp } from './helpers.js'

const running: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

describe('live stream', () => {
  it('says hello, then reports every journal append with its goal and number', async () => {
    const t = await startApp()
    running.push(t)
    const res = await fetch(`${t.server.url}/api/live`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reading = readStream(res, (s) => s.includes('event: change'))
    const { goalId } = await t.call<{ goalId: string }>('crewboard_start_goal', { project: t.project, title: 'Кухня', criteria: [] })
    const text = await reading
    expect(text).toContain('event: hello')
    const data = /event: change\ndata: (.+)\n/.exec(text)?.[1]
    expect(JSON.parse(data!)).toMatchObject({ goalId, seq: 1 })
  })

  it('ends open streams when the server closes', async () => {
    const t = await startApp()
    const res = await fetch(`${t.server.url}/api/live`)
    const reading = readStream(res, () => false, 4000)
    await t.close()
    const started = Date.now()
    await reading
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('the server port', () => {
  it('refuses a busy port with EADDRINUSE instead of crashing', async () => {
    const t = await startApp()
    running.push(t)
    const port = Number(new URL(t.server.url).port)
    const second = createApp({ env: t.env, backendFor: () => async () => t.fake.backend, tickMs: 60_000 })
    await expect(second.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})


describe('agent settings HTTP writes', () => {
  it('saves a validated configuration and returns 409 for an outdated revision', async () => {
    const t = await startApp()
    running.push(t)
    const url = `${t.server.url}/api/agents-config`
    const before = await (await fetch(url)).json() as { revision: string; config: unknown }
    const put = (body: unknown) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const saved = await put({ revision: before.revision, config: { agents: { codex: { effort: 'medium' } }, presets: { cheap: false } } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ config: { agents: { codex: { effort: 'medium' } }, presets: { cheap: false } } })
    expect((await put({ revision: before.revision, config: before.config })).status).toBe(409)
    const current = await (await fetch(url)).json() as { revision: string }
    expect((await put({ revision: current.revision, config: { agents: { codex: { effort: 'invalid' } } } })).status).toBe(400)
  })

  it.each([
    [{ origin: 'https://foreign.example', 'content-type': 'application/json' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ])('refuses an unsafe settings write with headers %j', async (headers, status) => {
    const t = await startApp()
    running.push(t)
    const response = await fetch(`${t.server.url}/api/agents-config`, { method: 'PUT', headers, body: '{}' })
    expect(response.status).toBe(status)
  })
})
