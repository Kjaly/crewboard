// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MAX_SPEC_BYTES as CORE_MAX, SPEC_EXTENSIONS } from '../../../core/src/plan/spec-upload.js'
import { setLang } from '../../src/client/i18n.js'
import { MAX_SPEC_BYTES, SPEC_TYPES, SpecPicker } from '../../src/client/spec-picker.js'
import { installFetch, jsonFail, jsonOk } from './helpers.js'

beforeEach(() => setLang('en'))
afterEach(() => cleanup())

const job = { id: 'dj-1', status: 'running' }
function fetches() {
  return installFetch((url) => {
    if (url.includes('/spec-files?')) return jsonOk(['.orchestration/specs/2026-09-24-old.md', 'README.md', 'docs/spec.md'])
    if (url.endsWith('/spec-upload')) return jsonOk({ path: '.orchestration/specs/2026-09-24-brief.md', job })
    if (url.endsWith('/plan-draft-from')) return jsonOk({ job })
    return jsonOk(null)
  })
}

it('keeps the client limits in step with the host', () => {
  expect([...SPEC_TYPES]).toEqual([...SPEC_EXTENSIONS])
  expect(MAX_SPEC_BYTES).toBe(CORE_MAX)
})

it('uploads a file chosen from disk and opens its draft job', async () => {
  const calls = fetches()
  const onDraft = vi.fn()
  render(<SpecPicker root="/repo" onDraft={onDraft} onClose={() => {}} />)
  await userEvent.setup().upload(screen.getByLabelText('Choose a file'), new File(['# Brief\nShip it'], 'brief.md', { type: 'text/markdown' }))
  expect(await screen.findByText(/brief\.md · 1 KB/)).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Draft plan' }))
  await waitFor(() => expect(onDraft).toHaveBeenCalledWith('dj-1'))
  expect(calls.find((call) => call.url.endsWith('/spec-upload'))?.body).toEqual({ repo: '/repo', name: 'brief.md', text: '# Brief\nShip it' })
})

it('accepts a dropped file and explains unsupported and oversized ones', async () => {
  fetches()
  render(<SpecPicker root="/repo" onDraft={() => {}} onClose={() => {}} />)
  const zone = screen.getByText(/Drop a file here/).parentElement!
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['%PDF'], 'brief.pdf')] } })
  expect((await screen.findByRole('alert')).textContent).toContain('.md, .markdown, .txt, .rst')
  expect((screen.getByRole('button', { name: 'Draft plan' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'.repeat(MAX_SPEC_BYTES + 1)], 'big.md')] } })
  expect((await screen.findByRole('alert')).textContent).toMatch(/limit is 256 KB/)
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['# ok'], 'ok.txt')] } })
  expect(await screen.findByText(/ok\.txt/)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('saves pasted text and shows the host refusal', async () => {
  const calls = installFetch((url) => url.endsWith('/spec-upload') ? jsonFail('too_large', 413) : jsonOk([]))
  render(<SpecPicker root="/repo" initial={{ mode: 'paste' }} onDraft={() => {}} onClose={() => {}} />)
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: /Spec text/ }), 'Build a report export')
  await user.click(screen.getByRole('button', { name: 'Draft plan' }))
  expect((await screen.findByRole('alert')).textContent).toBe('The spec is larger than 256 KB.')
  expect(calls.find((call) => call.url.endsWith('/spec-upload'))?.body).toEqual({ repo: '/repo', text: 'Build a report export' })
})

it('searches repository files, including saved specs, and drafts the selected one in Russian', async () => {
  setLang('ru')
  const calls = fetches()
  const onClose = vi.fn()
  render(<SpecPicker root="/repo" onDraft={() => {}} onClose={onClose} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: 'Из репозитория' }))
  expect(await screen.findByRole('option', { name: '.orchestration/specs/2026-09-24-old.md' })).toBeTruthy()
  await user.type(screen.getByRole('searchbox', { name: 'Поиск' }), 'docs')
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['docs/spec.md'])
  await user.click(screen.getByRole('button', { name: 'Составить черновик' }))
  await waitFor(() => expect(calls.find((call) => call.url.endsWith('/plan-draft-from'))?.body).toEqual({ repo: '/repo', file: 'docs/spec.md' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
})
