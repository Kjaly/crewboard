import { describe, expect, it } from 'vitest'
import { createNotificationPresence } from '../src/host/presence.js'

describe('notification presence', () => {
  it('keeps a client fresh until its heartbeat ages past the TTL', () => {
    const presence = createNotificationPresence(30_000)
    presence.report('tab-1', 1_000)
    expect(presence.active(1_000)).toBe(true)
    expect(presence.active(30_999)).toBe(true)
    expect(presence.active(31_001)).toBe(false)
  })

  it('retires a client immediately on an explicit clear', () => {
    const presence = createNotificationPresence()
    presence.report('tab-1', 1_000)
    presence.clear('tab-1')
    expect(presence.active(1_000)).toBe(false)
  })

  it('stays active while any of several clients is still beating', () => {
    const presence = createNotificationPresence(30_000)
    presence.report('tab-1', 1_000)
    presence.report('tab-2', 20_000)
    // tab-1 is stale at 31_001 but tab-2 is not.
    expect(presence.size(31_001)).toBe(1)
    expect(presence.active(31_001)).toBe(true)
    expect(presence.active(50_001)).toBe(false)
  })
})
