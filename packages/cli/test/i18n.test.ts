import { describe, expect, it } from 'vitest'
import { envLang } from '../src/i18n.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'
import { makeRepo } from '../../core/test/git-helpers.js'

describe('CLI language selection', () => {
  it('defaults to English and recognizes Russian LANG', async () => {
    expect(envLang({})).toBe('en')
    expect(envLang({ LANG: 'ru_RU.UTF-8' })).toBe('ru')
    const h = makeHarness({ cwd: '/tmp', env: { LANG: 'ru_RU.UTF-8' } })
    await run(['--help'], h.io)
    expect(h.out()).toContain('Crewboard — план')
  })
  it('--lang overrides the environment on every command', async () => {
    const h = makeHarness({ cwd: '/tmp', env: { LANG: 'ru_RU.UTF-8' } })
    await run(['--lang', 'en', '--help'], h.io)
    expect(h.io.lang).toBe('en')
    const h2 = makeHarness({ cwd: '/tmp', env: { LANG: 'en_US.UTF-8' } })
    await run(['--lang', 'ru', '--help'], h2.io)
    expect(h2.io.lang).toBe('ru')
  })
  it('leaves identifiers and paths as data', async () => {
    const en = makeHarness({ cwd: '/tmp', env: {} })
    const ru = makeHarness({ cwd: '/tmp', env: {} })
    await run(['--lang', 'en', '--help'], en.io)
    await run(['--lang', 'ru', '--help'], ru.io)
    expect(en.out()).not.toBe(ru.out())
    expect(en.out()).toContain('Plans\n')
    expect(en.out()).not.toMatch(/[А-Яа-яЁё]/)
    expect(ru.out()).toContain('План\n')
    for (const id of ['crewboard', 'dsh/deepseek-flash', 'code|design|review|research']) {
      expect(en.out()).toContain(id)
      expect(ru.out()).toContain(id)
    }

    const root = await makeRepo()
    const english = makeHarness({ cwd: root, env: {} })
    const russian = makeHarness({ cwd: root, env: {} })
    await run(['--lang', 'en', 'init'], english.io)
    await run(['--lang', 'ru', 'init'], russian.io)
    const path = `${root}/.orchestration/plan.json`
    expect(english.out()).toContain(path)
    expect(russian.err()).toContain(path)
  })
})
