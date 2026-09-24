// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { ensureStyles } from '../../src/client/styles.js'

it('replaces a stylesheet left by an earlier build of the plugin', () => {
  const stale = document.createElement('style')
  stale.setAttribute('data-orchestra', '')
  stale.textContent = '.old{}'
  document.head.append(stale)
  ensureStyles()
  const tags = document.querySelectorAll('style[data-orchestra]')
  expect(tags).toHaveLength(1)
  expect(tags[0]!.textContent).not.toBe('.old{}')
  expect(tags[0]!.textContent).toContain('.orc-')
})
