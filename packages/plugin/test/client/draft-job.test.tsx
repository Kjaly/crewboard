// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import type { DraftJobSummary } from '../../src/client/api.js'
import { DraftJobView } from '../../src/client/draft-job.js'
import { FakeEventSource, installEventSource, installFetch, jsonOk, makeRepo, makeSnapshot } from './helpers.js'

beforeEach(() => { localStorage.clear(); resetOrchestraStore(); installEventSource() })
afterEach(() => cleanup())

const running: DraftJobSummary = { id: 'dj-abc-1', status: 'running', source: { name: 'bye.txt', hash: 'h' }, spec: 'bye.txt', agent: 'codex/gpt-6-luna', attempts: 1, pick: 'auto', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const refused: DraftJobSummary = { ...running, status: 'needs_repair', updatedAt: new Date(Date.now() + 1000).toISOString(), findings: [{ path: 'decisions[0]', code: 'invalid_type', message: 'expected string, received object' }] }

function setup(lang: 'en' | 'ru') {
  setLang(lang)
  let jobs: DraftJobSummary[] = []
  const snap = makeSnapshot(makeRepo([], [], { hasPlan: false }))
  const calls = installFetch((url) => {
    if (url.includes('/spec-files?')) return jsonOk(['bye.txt'])
    if (url.includes('/draft-worker?')) return jsonOk({ agent: 'codex/gpt-6-luna', skipped: [{ id: 'devin', reason: '✗ binary: not found → brew install --cask devin-cli' }], options: ['devin', 'codex/gpt-6-luna', 'claude/opus'] })
    if (url.endsWith('/plan-draft-from')) { jobs = [running]; return jsonOk({ job: running }) }
    if (url.includes('/plan-draft-jobs?')) return jsonOk(jobs)
    if (url.includes('/plan-draft-job?')) return jsonOk({ job: jobs[0], ...(jobs[0]?.status === 'needs_repair' ? { answer: '{"decisions":[{"question":"Wave?"}]' } : {}) })
    if (url.endsWith('/plan-draft-job-repair')) return jsonOk({ ...running, attempts: 2 })
    if (url.includes('/plan-drafts?')) return jsonOk([])
    if (url.includes('/onboarding-workers') || url.includes('/recipe?')) return jsonOk([])
    return jsonOk(snap)
  })
  return { snap, calls, refuse: () => { jobs = [refused] } }
}

it('opens a draft job at once, shows progress, then the refused answer with findings and a repair action', async () => {
  const { snap, calls, refuse } = setup('en')
  const user = userEvent.setup()
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', snap))
  await user.click(await screen.findByRole('button', { name: /From a spec/ }))
  await user.click(screen.getByRole('tab', { name: 'From the repository' }))
  await screen.findByRole('option', { name: 'bye.txt' })
  await user.click(screen.getByRole('button', { name: 'Draft plan' }))
  expect(await screen.findByRole('heading', { name: 'bye.txt' })).toBeTruthy()
  expect(screen.getByText(/A worker is drafting the plan/)).toBeTruthy()
  refuse()
  // The host advanced the job and its drafts stamp moved (pf1).
  await act(async () => FakeEventSource.last?.emit('snapshot', { ...snap, generatedAt: 'later', repos: snap.repos.map((repo) => ({ ...repo, draftsStamp: 'moved' })) }))
  expect(await screen.findByRole('heading', { name: 'Needs repair' })).toBeTruthy()
  expect(screen.getByText('decisions[0]')).toBeTruthy()
  await waitFor(() => expect(screen.getByText('{"decisions":[{"question":"Wave?"}]')).toBeTruthy())
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(calls.find((call) => call.url.endsWith('/plan-draft-job-repair'))?.body).toMatchObject({ id: 'dj-abc-1' })
})

it('speaks Russian on the draft job screen', async () => {
  const { snap, refuse } = setup('ru')
  const user = userEvent.setup()
  render(<App />)
  await act(async () => FakeEventSource.last?.emit('snapshot', snap))
  await user.click(await screen.findByRole('button', { name: /Из спецификации/ }))
  await user.click(screen.getByRole('tab', { name: 'Из репозитория' }))
  await screen.findByRole('option', { name: 'bye.txt' })
  await user.click(screen.getByRole('button', { name: 'Составить черновик' }))
  expect(await screen.findByText(/Воркер составляет план/)).toBeTruthy()
  refuse()
  // The host advanced the job and its drafts stamp moved (pf1).
  await act(async () => FakeEventSource.last?.emit('snapshot', { ...snap, generatedAt: 'later', repos: snap.repos.map((repo) => ({ ...repo, draftsStamp: 'moved' })) }))
  expect(await screen.findByRole('heading', { name: 'Нужна починка' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
})

it('shows the first line of a failed attempt with a hint, and Try again on it', async () => {
  setLang('en')
  const failed: DraftJobSummary = { ...running, status: 'failed', error: 'worker_failed', detail: 'Not logged in · Please run /login', hint: 'login', updatedAt: new Date().toISOString() }
  const snap = makeSnapshot(makeRepo([], [], { hasPlan: false }))
  installFetch((url) => {
    if (url.includes('/plan-draft-jobs?')) return jsonOk([failed])
    if (url.includes('/plan-draft-job?')) return jsonOk({ job: failed })
    if (url.includes('/plan-drafts?')) return jsonOk([])
    if (url.includes('/onboarding-workers') || url.includes('/recipe?')) return jsonOk([])
    return jsonOk(snap)
  })
  render(<DraftJobView repo="/repo" job={failed} onDraft={() => {}} onDiscarded={() => {}} onClose={() => {}} />)
  expect(await screen.findByText('Reason: Not logged in · Please run /login. Try again or discard the job.')).toBeTruthy()
  expect(screen.getByText(/codex\/gpt-6-luna does not seem to be logged in/)).toBeTruthy()
  expect(screen.getByText(/picked automatically/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})
