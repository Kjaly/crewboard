import { expect, it } from 'vitest'
import { apply, inject, name } from '../src/client/index.js'

it('registers the sidebar entry and the main panel through slots', () => {
  const registered: Array<Record<string, unknown>> = []
  const injected: string[] = []
  const slots = {
    inject: (slot: string, fn: () => unknown) => {
      injected.push(slot)
      fn()
    },
    register: (opts: Record<string, unknown>) => {
      registered.push(opts)
      return () => {}
    },
  }
  expect(name).toBe('crewboard/client')
  expect(inject).toEqual(['slots'])
  // The labels are asserted in Russian, so the test names the language: without a locale the
  // plugin speaks English, and the sidebar label would read `Orchestra`.
  apply({ get: (n: string) => n === 'slots' ? slots : undefined, inject: (names, fn) => {
    if (names[0] === 'locale') fn({ locale: { getSnapshot: () => ({ active: 'ru' }), subscribe: () => () => {}, addLanguage: () => () => {} } })
  } })
  expect(injected).toEqual(['sidebar.panellist', 'main', 'settings.section'])
  expect(registered[0]).toMatchObject({ name: 'sidebar.panellist', id: 'crewboard', order: 100 })
  expect((registered[0]!.label as () => string)()).toBe('Оркестрация')
  expect(registered[1]).toEqual({ name: 'main', key: 'crewboard' })
  expect(registered[2]).toMatchObject({ name: 'settings.section', id: 'crewboard', order: 40 })
  expect((registered[2]!.label as () => string)()).toBe('Crewboard')
})

it('does not throw when the slots service is missing', () => {
  expect(() => apply({ get: () => undefined })).not.toThrow()
})

it('registers slots synchronously even when the locale service never answers', () => {
  const injected: string[] = []
  const slots = { inject: (slot: string, fn: () => unknown) => { injected.push(slot); fn() }, register: () => () => {} }
  // dsh reads slots at boot; a dictionary still on its way must not delay registration.
  apply({ get: (n: string) => n === 'slots' ? slots : undefined, inject: () => {} })
  expect(injected).toEqual(['sidebar.panellist', 'main', 'settings.section'])
})
