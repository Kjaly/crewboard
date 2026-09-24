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

// Every `crewboard`/`orch` call parses the whole bundle. Ceilings sit ~15% above the size reached by
// moving core to zod/mini and minifying (main 414 KiB, runners 22 and 9 KiB, 2026-09-24): growth past
// them is a decision to make on purpose, not something to discover later. Raised main 476 → 480 KiB for
// the per-worktree baseline record (bl1, +3.8 KB, 2026-09-24), 480 → 484 KiB for the refresh that lets
// untracked setup files through and names what blocks it, in two languages (rf1, +2.9 KB, 2026-09-24).
// Raised 484 → 492 KiB for reading plans a newer build wrote (pq1, +6.1 KB, 2026-09-24): tolerant schema
// fields, hash-named bounded quarantine, the two-language incompatibility errors. main.js already stood
// at 484.3 KiB before pq1 (i18n2). Raised 492 → 508 KiB for the repository list (rg1, +13.3 KB,
// 2026-09-24): `repo add|list|rm`, worktree discovery, the «not on screen» warning, in two languages.
// main.js already stood at 492.4 KiB (504 226 B) before rg1, over the old ceiling. Raised 508 → 516 KiB
// for «Needs you» in the terminal (nq1, +7.8 KB, 2026-09-24): `attention` builds the screen's repository
// snapshot and its shared needs-you set, with `--all` over the screen's list, in two languages. Raised 516 → 520 KiB with st1 (+1.9 KB):
// directions that end in a state matching reality.
it('keeps the CLI bundles within their weight and free of classic zod', async () => {
  for (const [name, ceiling] of [['main.js', 520], ['cli-runner-main.js', 26], ['runner-main.js', 10]] as const) {
    const code = await readFile(dist(name), 'utf8')
    expect(Buffer.byteLength(code), name).toBeLessThan(ceiling * 1024)
    // Classic zod registers `ZodString`/`ZodObject`; zod/mini registers `ZodMini…`. One classic import
    // anywhere in core brings back ~800 KB.
    expect(code, name).not.toMatch(/\("Zod(?:String|Object|Type|Error)"/)
  }
  expect((await readFile(dist('main.js'), 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true)
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
