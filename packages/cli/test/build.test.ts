import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import { buildWhileWatching, failingBuild, leftovers } from '../../core/test/build-atomic.js'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const dist = (name: string) => new URL(`../dist/${name}`, import.meta.url)

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: pkg, stdio: 'pipe' })
})

// The bundled CLI resolves the detached run supervisors next to itself; a missing file makes every
// `orch run` fail instantly with no events (regression from bundling the CLI for npm).
it('ships the run supervisors next to the bundled CLI', async () => {
  const main = await readFile(dist('main.js'), 'utf8')
  for (const name of ['runner-main.js', 'cli-runner-main.js']) {
    expect(main).toContain(`./${name}`)
    expect((await stat(dist(name))).size).toBeGreaterThan(1000)
  }
})

// Every `crewboard`/`orch` call parses the whole bundle. Ceilings are the measured size plus ~5%
// (main 351.0 KiB, runners 23.3 and 8.7 KiB, 2026-09-24, after opt2; the Claude/Codex runner 25.8 KiB after bg1,
// which keeps a run open for the worker's background work; 27.2 KiB after w1a, which fails a Claude run on `is_error`
// and records the worker's process group; main 375.3 KiB after w1f — `drop`, the `wait`/`gc`/`cost` texts and help in both
// languages): growth past them is a decision to make on purpose,
// not something to discover later — measure it and move the number with the new size.
// Current ceilings, measured after wave 1 (w1a–w1f), 2026-09-24: main 394.6 KiB → 415, runners 27.3 / 8.7 KiB.
it('keeps the CLI bundles within their weight and free of classic zod', async () => {
  for (const [name, ceiling] of [['main.js', 415], ['cli-runner-main.js', 29], ['runner-main.js', 10]] as const) {
    const code = await readFile(dist(name), 'utf8')
    expect(Buffer.byteLength(code), name).toBeLessThan(ceiling * 1024)
    // Classic zod registers `ZodString`/`ZodObject`; zod/mini registers `ZodMini…`. One classic import
    // anywhere in core brings back ~800 KB.
    expect(code, name).not.toMatch(/\("Zod(?:String|Object|Type|Error)"/)
  }
  expect((await readFile(dist('main.js'), 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true)
})

// A value `import('@crewboard/core')` makes esbuild keep core as a namespace object with every export,
// so nothing of core is tree-shaken (it once cost 115 KB). `createExamplePlan` belongs to the screen only:
// finding it in the CLI means the namespace is back.
it('tree-shakes core out of the CLI bundle', async () => {
  expect(await readFile(dist('main.js'), 'utf8')).not.toContain('createExamplePlan')
})

// `orch` runs from dist/ of the main checkout while that checkout rebuilds: the entries must exist at every
// moment of a build, and a build that fails must leave the previous one in place (bd1, 2026-09-24).
it('keeps every entry in place while it rebuilds', async () => {
  const { rounds, misses } = await buildWhileWatching(pkg, ['main.js', 'runner-main.js', 'cli-runner-main.js'].map((name) => fileURLToPath(dist(name))))
  expect(rounds).toBeGreaterThan(0)
  expect(misses).toBe(0)
  expect(await leftovers(pkg)).toEqual([])
})

it('leaves the previous build in place when a build fails', async () => {
  const before = await readFile(dist('main.js'), 'utf8')
  expect(await failingBuild(pkg)).not.toBe(0)
  expect(await readFile(dist('main.js'), 'utf8')).toBe(before)
  expect((await readdir(fileURLToPath(dist('')))).sort()).toEqual(['cli-runner-main.js', 'main.js', 'runner-main.js'])
  expect(await leftovers(pkg)).toEqual([])
})
