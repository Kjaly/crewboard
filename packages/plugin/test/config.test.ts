import { expect, it } from 'vitest'
import { Config, legacyDshConfigFromYaml, resolveConfig, resolveConfigWithLegacy } from '../src/host/config.js'

it('merges configured and CREWBOARD_REPOS repos and validates values', () => {
  expect(resolveConfig({ repos: ['/a'] }, { CREWBOARD_REPOS: '/b:/a' })).toEqual({ repos: ['/a', '/b'], refreshMs: 30_000, notifications: true })
  expect(resolveConfig(undefined, {})).toEqual({ repos: [], refreshMs: 30_000, notifications: true })
  expect(resolveConfig({ notifications: false }, {})).toMatchObject({ notifications: false })
  expect(Config['~standard'].validate({ repos: ['relative'] })).toMatchObject({ issues: [{ message: expect.stringContaining('absolute') }] })
  expect(Config['~standard'].validate({ refreshMs: 1000 })).toMatchObject({ issues: [{ message: expect.stringContaining('refreshMs') }] })
  expect(Config['~standard'].validate({ notifications: 'yes' })).toMatchObject({ issues: [{ message: expect.stringContaining('notifications') }] })
  expect(Config['~standard'].validate({ repos: ['/x'], refreshMs: 60_000 })).toEqual({ value: { repos: ['/x'], refreshMs: 60_000 } })
})

it('prefers CREWBOARD env names over ORCH aliases', () => {
  expect(resolveConfig(undefined, { CREWBOARD_REPOS: '/new', ORCH_REPOS: '/old' }).repos).toEqual(['/new'])
  expect(resolveConfig(undefined, { ORCH_REPOS: '/old' }).repos).toEqual(['/old'])
})

it('uses the old dsh plugin repo block only when the new plugin row omits repos', () => {
  const old = legacyDshConfigFromYaml('- id: dsh-orchestra\n  config:\n    repos:\n      - /repo/a\n      - /repo/b\n- id: other\n  config: {}\n')
  expect(resolveConfigWithLegacy(undefined, old, {})).toMatchObject({ repos: ['/repo/a', '/repo/b'] })
  expect(resolveConfigWithLegacy({ repos: ['/new'] }, old, {}).repos).toEqual(['/new'])
})
