import { describe, expect, it } from 'vitest'
import { hostLang, hostT } from '../src/host/i18n.js'

describe('host language selection', () => {
  it('uses locale.preference for both confirmation languages', () => {
    const task = 'task-42'
    expect(hostT(hostLang('en'), 'actions.accept.normal', { task })).toBe('Accept task task-42? Changes are considered reviewed.')
    expect(hostT(hostLang('ru'), 'actions.accept.normal', { task })).toBe('Принять задачу task-42? Изменения считаются проверенными.')
    expect(hostLang(undefined)).toBe('en')
  })
})
