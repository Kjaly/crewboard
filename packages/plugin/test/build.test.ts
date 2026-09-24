import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildWhileWatching, failingBuild, leftovers } from '../../core/test/build-atomic.js'

const pkg = fileURLToPath(new URL('..', import.meta.url))

describe('plugin build', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: pkg, stdio: 'pipe' })
  })

  it('wraps the client bundle for the dsh module loader with React from the shell', async () => {
    const client = await readFile(`${pkg}/lib/client.js`, 'utf8')
    expect(client.startsWith('window.__ModuleLoader__.load({\n\tid: "dsh-crewboard",')).toBe(true)
    expect(client).toContain('return module.exports;')
    expect(client).not.toMatch(/node:(fs|child_process)/)
    expect(client).not.toContain('@deepseek-ai/')
  })

  it('keeps the layout engine out of the screen and in its own bundle', async () => {
    const client = await readFile(`${pkg}/lib/client.js`, 'utf8')
    // Keep screens opened after first paint out of the always loaded bundle. The ceiling is the measured
    // size plus ~5% (296.0 KiB, 2026-09-24, after opt2); scripts/release-check.mjs holds the same number.
    // Client measured after wave 1 (w1a–w1f), 2026-09-24: 312.8 KiB → 329; host index.js 459.4 KiB → 483.
    expect(Buffer.byteLength(client)).toBeLessThan(329 * 1024)
    expect(client).not.toContain('Task actions')
    expect(client).not.toContain('Действия с задачей')
    for (const lang of ['en', 'ru']) expect((await readFile(`${pkg}/lib/dict-${lang}.js`, 'utf8')).length).toBeGreaterThan(1000)
    for (const name of ['review', 'welcome', 'settings', 'draft', 'ledger', 'trace', 'task']) {
      const asset = await readFile(`${pkg}/lib/screen-${name}.js`, 'utf8')
      expect(client).toContain(`/crewboard/assets/screen-${name}.js`)
      expect(client).not.toContain(`__orchScreenBundles["${name}"]`)
      expect(asset).toContain(`__orchScreenBundles["${name}"]`)
      expect(asset.length).toBeGreaterThan(1000)
      // Dictionaries and the stylesheet are shared assets; a copy here would double the download
      // and give the screen its own language and style state.
      expect(asset).not.toContain('worktree.policy.afterAccept')
      expect(asset).not.toContain('.orc-root{')
    }
    expect(client).not.toContain('elk.bundled')
    expect(client).toContain('/crewboard/assets/elk.js')
    const taskAsset = await readFile(`${pkg}/lib/screen-task.js`, 'utf8')
    expect(client).not.toContain('/crewboard/assets/preview-dxf.js')
    expect(client).not.toContain('/crewboard/assets/preview-structured.js')
    expect(taskAsset).toContain('/crewboard/assets/preview-dxf.js')
    expect(taskAsset).toContain('/crewboard/assets/preview-structured.js')
    expect(await readFile(`${pkg}/lib/preview-dxf.js`, 'utf8')).toContain('__orchRenderDxf')
    expect(await readFile(`${pkg}/lib/preview-structured.js`, 'utf8')).toContain('__orchStructured')

    const elk = await readFile(`${pkg}/lib/elk.js`, 'utf8')
    const sandbox = { globalThis: {} } as { globalThis: { __orchElk?: new () => { layout(g: unknown): Promise<unknown> } } }
    new Function('globalThis', 'self', 'window', elk)(sandbox.globalThis, sandbox.globalThis, sandbox.globalThis)
    expect(typeof sandbox.globalThis.__orchElk).toBe('function')
  })

  it('produces a host ESM bundle with the cordis plugin exports and no @deepseek-ai imports', async () => {
    const host = await readFile(`${pkg}/lib/index.js`, 'utf8')
    expect(host).not.toMatch(/from ["']@deepseek-ai\//)
    const mod = (await import(`${pkg}/lib/index.js?t=${Date.now()}`)) as { name: string; apply: unknown }
    expect(mod.name).toBe('crewboard')
    expect(typeof mod.apply).toBe('function')
  })
  // dsh loads the host on every start. Ceilings are the measured size plus ~5% (host 422.8 KiB, runners
  // 23.4 and 8.9 KiB, 2026-09-24, after opt2; the Claude/Codex runner 25.9 KiB after bg1, which keeps a run
  // open for the worker's background work; 27.3 KiB after w1a, which fails a Claude run on `is_error` and records
  // the worker's process group): growth past them is a decision to make on purpose, not
  // something to discover later — measure it and move the number with the new size.
  it('keeps the host and runner bundles within their weight and free of classic zod', async () => {
    for (const [name, ceiling] of [['index.js', 483], ['cli-runner-main.js', 29], ['runner-main.js', 10]] as const) {
      expect(Buffer.byteLength(await readFile(`${pkg}/lib/${name}`)), name).toBeLessThan(ceiling * 1024)
    }
    // Classic zod registers `ZodString`/`ZodObject`; zod/mini registers `ZodMini…`. No bundle — host,
    // runners, client, lazy screens, previews, dictionaries — may carry the classic build.
    for (const name of (await readdir(`${pkg}/lib`)).filter((file) => file.endsWith('.js'))) {
      expect(await readFile(`${pkg}/lib/${name}`, 'utf8'), name).not.toMatch(/\("Zod(?:String|Object|Type|Error)"/)
    }
  })
  it('ships the detached run supervisors next to the host bundle, where the inlined core looks for them', async () => {
    // core resolves its supervisor entry as new URL('./…-main.js', import.meta.url); inside the host
    // bundle import.meta.url is lib/index.js, so the entries must live in lib/ — otherwise every launch
    // from the panel silently never starts.
    await access(`${pkg}/lib/runner-main.js`)
    await access(`${pkg}/lib/cli-runner-main.js`)
    const runDir = await mkdtemp(join(tmpdir(), 'orch-entry-'))
    const promptFile = join(runDir, 'prompt.md')
    await writeFile(promptFile, 'build it')
    const fakeCodex = fileURLToPath(new URL('../../core/test/fixtures/fake-codex.mjs', import.meta.url))
    const args = { kind: 'codex', runDir, cwd: runDir, promptFile, command: process.execPath, commandArgs: [fakeCodex] }
    execFileSync(process.execPath, [`${pkg}/lib/cli-runner-main.js`, JSON.stringify(args)], { stdio: 'pipe', timeout: 30_000 })
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as { status: string; sessionId?: string }
    expect(state).toMatchObject({ status: 'completed', sessionId: 'th-1' })
    const fakeDevin = fileURLToPath(new URL('../../core/test/fixtures/fake-devin.mjs', import.meta.url))
    const devinDir = await mkdtemp(join(tmpdir(), 'orch-devin-entry-'))
    const devinArgs = { kind: 'devin', runDir: devinDir, cwd: devinDir, promptFile, command: process.execPath, commandArgs: [fakeDevin, 'normal'] }
    execFileSync(process.execPath, [`${pkg}/lib/cli-runner-main.js`, JSON.stringify(devinArgs)], { stdio: 'pipe', timeout: 30_000 })
    expect(JSON.parse(await readFile(join(devinDir, 'state.json'), 'utf8'))).toMatchObject({ status: 'completed', sessionId: 'devin-session' })

  })

  // dsh loads lib/ of the main checkout while that checkout rebuilds: the host, runners and client must
  // exist at every moment of a build, and a failed build must leave the previous one in place (bd1).
  it('keeps the host, runners and client in place while it rebuilds', async () => {
    const entries = ['index.js', 'runner-main.js', 'cli-runner-main.js', 'client.js'].map((name) => `${pkg}/lib/${name}`)
    const { rounds, misses } = await buildWhileWatching(pkg, entries)
    expect(rounds).toBeGreaterThan(0)
    expect(misses).toBe(0)
    expect(await leftovers(pkg)).toEqual([])
  }, 120_000)

  it('leaves the previous build in place when a build fails', async () => {
    const before = await readdir(`${pkg}/lib`)
    const host = await readFile(`${pkg}/lib/index.js`, 'utf8')
    expect(await failingBuild(pkg)).not.toBe(0)
    expect(await readdir(`${pkg}/lib`)).toEqual(before)
    expect(await readFile(`${pkg}/lib/index.js`, 'utf8')).toBe(host)
    expect(await leftovers(pkg)).toEqual([])
  })
})
