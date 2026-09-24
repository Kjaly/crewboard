// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PartBoundary } from '../../src/client/boundary.js'
import { setLang } from '../../src/client/i18n.js'

beforeEach(() => setLang('en'))
afterEach(() => cleanup())

function Broken(): never { throw new TypeError("Cannot read properties of undefined (reading 'length')") }

it('keeps a failing part from blanking its siblings', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<div><PartBoundary area="task panel"><Broken /></PartBoundary><p>Graph still here</p></div>)
  expect(screen.getByRole('alert').textContent).toContain('task panel')
  expect(screen.getByText('Graph still here')).toBeTruthy()
})
