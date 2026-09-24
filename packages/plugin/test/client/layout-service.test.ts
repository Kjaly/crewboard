import { afterEach, expect, it, vi } from 'vitest'
import { bindLayout, resetLayout, selectMainPanel } from '../../src/client/layout.js'

afterEach(() => resetLayout())

const refused = () => {
  throw new Error('cannot get property "layout" without inject')
}

// Audit B1 (docs/notes/2026-09-23-codebase-audit.md): cordis throws on an un-injected read instead
// of returning undefined, and bindLayout read `ctx.layout` first thing, outside any guard — so the
// injection callback was never reached and the toasts' «Открыть» could not switch panels. The same
// trap had already taken the whole plugin down once, through `locale`.
it('binds through the injection when the root context refuses a direct read', () => {
  const selectPanel = vi.fn()
  const ctx = {
    get: refused,
    get layout(): unknown {
      return refused()
    },
    inject: (_names: readonly string[], fn: (child: unknown) => void) => fn({ layout: { selectPanel } }),
  }
  expect(() => bindLayout(ctx as never)).not.toThrow()
  expect(selectMainPanel('crewboard')).toBe(true)
  expect(selectPanel).toHaveBeenCalledWith('crewboard')
})

it('stays quiet and reports failure when no route to the service exists', () => {
  const ctx = {
    get: refused,
    get layout(): unknown {
      return refused()
    },
  }
  expect(() => bindLayout(ctx as never)).not.toThrow()
  expect(selectMainPanel('crewboard')).toBe(false)
})
