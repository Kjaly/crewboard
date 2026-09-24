import { olderConfigPath } from '../src/routing/profile-store.js'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initPlan, updatePlan, loadPlan } from '../src/plan/store.js'
import { DEFAULT_ROUTING } from '../src/routing/routing.js'
import { resolveRouting, savePreset, setRepositoryPreset, setPlanPreset, deletePreset } from '../src/routing/presets.js'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'presets-home-'))
  const root = await mkdtemp(join(tmpdir(), 'presets-repo-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ routing: DEFAULT_ROUTING }))
  await initPlan(root, 'goal', new Date('2026-09-23'))
  const env = { HOME: home }
  const routing = Object.fromEntries(Object.keys(DEFAULT_ROUTING.classes).map((cls) => [cls, ['codex/gpt-6-luna', 'codex/gpt-6-sol']])) as typeof DEFAULT_ROUTING.classes
  return { root, home, env, routing }
}

it('uses the builtin routing when no preset is chosen', async () => {
  const { root, env } = await fixture()
  const result = await resolveRouting(root, undefined, env)
  expect(result.source).toBe('builtin')
  expect(result.routing).toEqual(DEFAULT_ROUTING.classes)
})

it('plan wins over repository, and repository wins over builtin', async () => {
  const { root, env, routing } = await fixture()
  await savePreset({ id: 'codex', label: 'Codex', routing }, env)
  await savePreset({ id: 'claude', label: 'Claude', routing: { ...routing, code: ['claude/opus'] } }, env)
  await setRepositoryPreset(root, 'codex', env)
  expect((await resolveRouting(root, undefined, env)).source).toBe('repository')
  await setPlanPreset(root, 'main', 'claude', env)
  expect(await resolveRouting(root, 'main', env)).toMatchObject({ source: 'plan', routing: { code: ['claude/opus'] } })
})

it('intersects with machine disabled workers and reports them', async () => {
  const { root, home, env, routing } = await fixture()
  await savePreset({ id: 'codex', label: 'Codex', routing }, env)
  await setRepositoryPreset(root, 'codex', env)
  await writeFile(olderConfigPath({}, home), JSON.stringify({ routing: { ...DEFAULT_ROUTING, disabled: { 'codex/gpt-6-luna': 'quota' } } }))
  expect(await resolveRouting(root, undefined, env)).toMatchObject({ routing: { code: ['codex/gpt-6-sol'] }, dropped: [{ id: 'codex/gpt-6-luna', reason: 'disabled' }] })
})

it('deleting an in-use preset names its references and resets them to builtin', async () => {
  const { root, env, routing } = await fixture()
  await savePreset({ id: 'codex', label: 'Codex', routing }, env)
  await setRepositoryPreset(root, 'codex', env)
  await setPlanPreset(root, 'main', 'codex', env)
  const result = await deletePreset('codex', [root], env)
  expect(result.usedIn).toEqual(expect.arrayContaining([`${root}:repository`, `${root}:plan:main`]))
  expect((await resolveRouting(root, 'main', env)).source).toBe('builtin')
  expect((await loadPlan(root)).preset).toBeUndefined()
})

it('a missing plan preset falls through and reports the missing reference', async () => {
  const { root, env, routing } = await fixture()
  await savePreset({ id: 'codex', label: 'Codex', routing }, env)
  await setRepositoryPreset(root, 'codex', env)
  await updatePlan(root, (p) => ({ ...p, preset: 'gone' }))
  expect(await resolveRouting(root, 'main', env)).toMatchObject({ source: 'repository', dropped: [{ id: 'gone', reason: 'unknown' }] })
})

it('an explicit All workers choice on a plan overrides the repository while clear inherits it', async () => {
  const { root, env, routing } = await fixture()
  await savePreset({ id: 'codex', label: 'Codex', routing }, env)
  await setRepositoryPreset(root, 'codex', env)
  await setPlanPreset(root, 'main', 'all-workers', env)
  expect(await resolveRouting(root, 'main', env)).toMatchObject({ source: 'plan', preset: { id: 'all-workers' }, routing: DEFAULT_ROUTING.classes })
  await setPlanPreset(root, 'main', undefined, env)
  expect((await resolveRouting(root, 'main', env)).source).toBe('repository')
})
