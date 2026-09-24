import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindLocale, getLang, installDictionary, relativeTime, setLang, t } from '../src/client/i18n.js'
import { en } from '../src/client/dict/en.js'
import { ru } from '../src/client/dict/ru.js'
import { STATUS_LABEL } from '../src/client/summary.js'
import { DECISION_LANE, laneTitle } from '../src/client/views/graph/layout.js'

describe('i18n dictionary and locale binding', () => {
  afterEach(() => { installDictionary('en', en); installDictionary('ru', ru); vi.unstubAllGlobals() })

  it('defaults to English and falls back to English for a missing Russian key', () => {
    expect(getLang()).toBe('en')
    expect(t('relative.now')).toBe('now')
    setLang('ru')
    expect(t('relative.ago')).toBe('{t} назад')
    expect(t('internal.testFallback')).toBe('English fallback')
  })

  it('substitutes variables and selects English and Russian plural categories', () => {
    setLang('en')
    expect(t('relative.minute', { n: 1 })).toBe('1 minute')
    expect(t('relative.minute', { n: 2 })).toBe('2 minutes')
    setLang('ru')
    expect(t('relative.minute', { n: 1 })).toBe('1 минута')
    expect(t('relative.minute', { n: 3 })).toBe('3 минуты')
    expect(t('relative.minute', { n: 5 })).toBe('5 минут')
    expect(t('relative.ago', { t: '7 часов' })).toBe('7 часов назад')
  })

  it('updates shared status and graph labels when the language changes', () => {
    setLang('en')
    expect(STATUS_LABEL.in_review).toBe('awaiting review')
    expect(laneTitle(DECISION_LANE)).toBe('Decisions')
    expect(t('graph.edgeCount', { count: 2 })).toBe('2 links')
    setLang('ru')
    expect(STATUS_LABEL.in_review).toBe('ждёт приёмки')
    expect(laneTitle(DECISION_LANE)).toBe('Решения')
    expect(t('graph.edgeCount', { count: 1 })).toBe('1 связь')
    expect(t('graph.edgeCount', { count: 2 })).toBe('2 связи')
    expect(t('graph.edgeCount', { count: 5 })).toBe('5 связей')
  })

  it('uses English screen copy first and inflects Russian screen counts', () => {
    expect(t('settings.workers')).toBe('Workers')
    expect(t('panel.side.accept')).toBe('Accept')
    expect(t('settings.worktrees.summary', { count: 2, size: '1.00' })).toBe('2 worktrees · 1.00 GB')
    setLang('ru')
    expect(t('settings.workers')).toBe('Воркеры')
    expect(t('panel.side.accept')).toBe('Принять')
    expect(t('settings.worktrees.summary', { count: 2, size: '1,00' })).toBe('2 копии · 1,00 ГБ')
    expect(t('settings.worktrees.summary', { count: 5, size: '1,00' })).toBe('5 копий · 1,00 ГБ')
  })

  it('follows a granted snapshot and disposes its subscription and own language', () => {
    const remove = vi.fn()
    const unsubscribe = vi.fn()
    let active = 'ru'
    let notify = () => {}
    const locale = {
      getSnapshot: () => ({ active }),
      subscribe: (fn: () => void) => { notify = fn; return unsubscribe },
      addLanguage: vi.fn(() => remove),
    }
    const disposers: Array<() => void> = []
    bindLocale({ inject: (_names, fn) => fn({ locale, effect: (effect: () => (() => void) | undefined) => { const dispose = effect(); if (dispose) disposers.push(dispose) } }) })
    expect(getLang()).toBe('ru')
    active = 'en'
    notify()
    expect(getLang()).toBe('en')
    for (const dispose of disposers) dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('keeps text blank until the active locale dictionary arrives, loading both in parallel', async () => {
    const scripts: Array<{ src?: string; onload?: () => void; onerror?: () => void }> = []
    vi.stubGlobal('document', { createElement: () => ({}), head: { append: (script: typeof scripts[number]) => { scripts.push(script) } } })
    const registry = globalThis.__orchDictionaries!
    delete registry.en
    delete registry.ru
    const locale = { getSnapshot: () => ({ active: 'ru' }), subscribe: () => () => {}, addLanguage: () => () => {} }
    bindLocale({ inject: (_names: readonly string[], fn: (child: unknown) => void) => fn({ locale, effect: (effect: () => (() => void) | undefined) => effect() }) } as never)
    expect(scripts.map((script) => script.src)).toEqual(['/crewboard/assets/dict-en.js', '/crewboard/assets/dict-ru.js'])
    expect(t('settings.workers')).toBe('')
    installDictionary('en', en)
    scripts[0]!.onload?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t('settings.workers')).toBe('')
    installDictionary('ru', ru)
    scripts[1]!.onload?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getLang()).toBe('ru')
    expect(t('settings.workers')).toBe('Воркеры')
    installDictionary('en', en)
    installDictionary('ru', ru)
    vi.unstubAllGlobals()
  })

  it('mounts when the root locale getter throws and reads only the granted snapshot', () => {
    const ctx = {
      get: () => { throw new Error('cannot get property "locale" without inject') },
      get locale(): unknown { throw new Error('cannot get property "locale" without inject') },
      inject: (_names: readonly string[], fn: (child: unknown) => void) => fn({ locale: {
        getSnapshot: () => ({ active: 'ru' }), subscribe: () => () => {}, addLanguage: () => () => {},
      } }),
    }
    expect(() => bindLocale(ctx as never)).not.toThrow()
    expect(getLang()).toBe('ru')
  })

  it('keeps the newer locale when an older dictionary load resolves late: ru, then en, then Russian arrives', async () => {
    const scripts = stubScripts()
    const registry = globalThis.__orchDictionaries!
    delete registry.ru
    let active = 'ru'
    let notify = () => {}
    const locale = { getSnapshot: () => ({ active }), subscribe: (fn: () => void) => { notify = fn; return () => {} }, addLanguage: () => () => {} }
    bindLocale(grant(locale))
    expect(scripts.map((script) => script.src)).toEqual(['/crewboard/assets/dict-ru.js'])
    active = 'en'
    notify()
    expect(getLang()).toBe('en')
    expect(t('settings.workers')).toBe('Workers')
    installDictionary('ru', ru)
    scripts[0]!.onload?.()
    await flush()
    expect(getLang()).toBe('en')
    expect(t('settings.workers')).toBe('Workers')
    vi.unstubAllGlobals()
  })

  it('keeps the newer locale when an older dictionary load resolves late: en, then ru, then English arrives', async () => {
    const scripts = stubScripts()
    const registry = globalThis.__orchDictionaries!
    delete registry.en
    delete registry.ru
    let active = 'en'
    let notify = () => {}
    const locale = { getSnapshot: () => ({ active }), subscribe: (fn: () => void) => { notify = fn; return () => {} }, addLanguage: () => () => {} }
    bindLocale(grant(locale))
    active = 'ru'
    notify()
    expect(scripts.map((script) => script.src)).toEqual(['/crewboard/assets/dict-en.js', '/crewboard/assets/dict-ru.js'])
    installDictionary('en', en)
    scripts[0]!.onload?.()
    await flush()
    // English is in, but dsh shows Russian: no English flash while the Russian dictionary loads.
    expect(t('settings.workers')).toBe('')
    installDictionary('ru', ru)
    scripts[1]!.onload?.()
    await flush()
    expect(getLang()).toBe('ru')
    expect(t('settings.workers')).toBe('Воркеры')
    vi.unstubAllGlobals()
  })

  it('applies the locale dsh shows when the load finishes, not the one that started it', async () => {
    const scripts = stubScripts()
    delete globalThis.__orchDictionaries!.ru
    let active = 'ru'
    const locale = { getSnapshot: () => ({ active }), subscribe: () => () => {}, addLanguage: () => () => {} }
    bindLocale(grant(locale))
    active = 'en'
    installDictionary('ru', ru)
    scripts[0]!.onload?.()
    await flush()
    expect(getLang()).toBe('en')
    vi.unstubAllGlobals()
  })

  it('drops a late setLang load once a newer language was set', async () => {
    const scripts = stubScripts()
    delete globalThis.__orchDictionaries!.ru
    setLang('ru')
    setLang('en')
    installDictionary('ru', ru)
    scripts[0]!.onload?.()
    await flush()
    expect(getLang()).toBe('en')
    vi.unstubAllGlobals()
  })

  it('shares one language across plugin instances; a re-applied instance takes the binding over', async () => {
    const unsubscribe = vi.fn()
    const remove = vi.fn()
    const addLanguage = vi.fn(() => remove)
    let active = 'en'
    const notify = new Set<() => void>()
    const locale = { getSnapshot: () => ({ active }), subscribe: (fn: () => void) => { notify.add(fn); return () => { notify.delete(fn); unsubscribe() } }, addLanguage }
    const first = await import('../src/client/i18n.js')
    const disposeFirst: Array<() => void> = []
    first.bindLocale(grant(locale, disposeFirst))
    vi.resetModules()
    const second = await import('../src/client/i18n.js')
    expect(second).not.toBe(first)
    const disposeSecond: Array<() => void> = []
    second.bindLocale(grant(locale, disposeSecond))
    // The first instance's subscription is released; Russian stays registered once, owned by the page.
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(notify.size).toBe(1)
    expect(addLanguage).toHaveBeenCalledOnce()
    const heard = vi.fn()
    first.subscribeLang(heard)
    active = 'ru'
    for (const fn of notify) fn()
    expect(first.getLang()).toBe('ru')
    expect(second.getLang()).toBe('ru')
    expect(first.t('settings.workers')).toBe('Воркеры')
    expect(second.t('settings.workers')).toBe('Воркеры')
    expect(heard).toHaveBeenCalled()
    // dsh disposing the old instance afterwards must not take Russian out of the catalog.
    for (const dispose of disposeFirst) dispose()
    expect(remove).not.toHaveBeenCalled()
    for (const dispose of disposeSecond) dispose()
    expect(remove).toHaveBeenCalledOnce()
    first.setLang('en')
    expect(second.getLang()).toBe('en')
  })

  it('uses dsh relative-time buckets', () => {
    const now = 100 * 24 * 60 * 60 * 1000
    expect(relativeTime(now - 59_000, now)).toBe('now')
    expect(relativeTime(now - 60_000, now)).toBe('1 minute ago')
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe('1 month ago')
    expect(relativeTime(now - 364 * 86_400_000, now)).toBe('12 months ago')
    expect(relativeTime(now - 365 * 86_400_000, now)).toBe('1 year ago')
  })
})

type Script = { src?: string; onload?: () => void; onerror?: () => void }
function stubScripts(): Script[] {
  const scripts: Script[] = []
  vi.stubGlobal('document', { createElement: () => ({}), head: { append: (script: Script) => { scripts.push(script) } } })
  return scripts
}
function grant(locale: unknown, disposers: Array<() => void> = []) {
  return { inject: (_names: readonly string[], fn: (child: unknown) => void) => fn({ locale, effect: (effect: () => (() => void) | undefined) => { const dispose = effect(); if (dispose) disposers.push(dispose) } }), effect: (effect: () => (() => void) | undefined) => { const dispose = effect(); if (dispose) disposers.push(dispose) } } as never
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('i18n guard', () => {
  let tempRoot: string | undefined
  afterEach(async () => { if (tempRoot) await rm(tempRoot, { recursive: true, force: true }); tempRoot = undefined })

  it('finds hardcoded Cyrillic and permits an explicitly exempt file', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'orch-i18n-'))
    const fixtureRoot = tempRoot
    const dir = path.join(fixtureRoot, 'packages/plugin/src/client')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'new-screen.tsx'), 'const label = "Привет"')
    const script = fileURLToPath(new URL('../../../scripts/lint-i18n.mjs', import.meta.url))
    expect(() => execFileSync(process.execPath, [script, '--root', fixtureRoot], { stdio: 'pipe' })).toThrow()
    expect(execFileSync(process.execPath, [script, '--root', fixtureRoot, '--allow', 'packages/plugin/src/client/new-screen.tsx'], { encoding: 'utf8' }))
      .toContain('passed')
  })
})
