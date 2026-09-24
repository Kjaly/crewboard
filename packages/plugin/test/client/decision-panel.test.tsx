// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskDetail, TaskSnapshot } from '../../src/shared/types.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask, ROOT } from './helpers.js'
import { setLang } from '../../src/client/i18n.js'

const decision = makeTask({ id: 'human', title: 'Живая проверка 2r', kind: 'decision', needsHuman: true, deps: ['build', 'review'] })
const build = makeTask({ id: 'build', title: 'Сборка', worker: 'codex/gpt-6-sol', status: 'accepted' })
const review = makeTask({ id: 'review', title: 'Ревью', worker: 'claude/opus', status: 'accepted', closed: 'negative' })

function mount(task: TaskSnapshot, details: Record<string, TaskDetail>, onSelect = vi.fn()) {
  installFetch((url) => {
    if (url.includes('/api/task')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id') ?? task.id
      return jsonOk(details[id] ?? makeDetail({ id }))
    }
    return jsonOk(null)
  })
  const repo = makeRepo([task, build, review])
  const view = render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={onSelect} density="overview" />)
  return { ...view, onSelect }
}

beforeEach(() => { localStorage.clear(); setLang('ru') })
afterEach(() => cleanup())

it('renders contract checklist as checkboxes and keeps scratch ticks through rerender and localStorage', async () => {
  const user = userEvent.setup()
  const detail = makeDetail({ id: decision.id, kind: 'decision', deps: decision.deps, contract: { path: 'docs/check.md', text: 'Проверить руками\n- [ ] Открыть экран\n- [ ] Сверить результат', truncated: false } })
  const mounted = mount(decision, { human: detail })
  const first = await screen.findByRole('checkbox', { name: 'Открыть экран' })
  expect(screen.getByText('Проверить руками')).toBeTruthy()
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  await user.click(first)
  expect(first).toHaveProperty('checked', true)
  expect(JSON.parse(localStorage.getItem(`crewboard:decision-checks:${ROOT}::human`) ?? 'null')).toMatchObject({ version: 1, revision: detail.contract?.text, items: ['Открыть экран'] })
  mounted.rerender(<TaskPanel repo={makeRepo([decision, build, review])} task={decision} attention={[]} onSelect={mounted.onSelect} density="overview" />)
  expect(screen.getByRole('checkbox', { name: 'Открыть экран' })).toHaveProperty('checked', true)
  mounted.unmount()
  mount(decision, { human: detail })
  expect(await screen.findByRole('checkbox', { name: 'Открыть экран' })).toHaveProperty('checked', true)
})

it('carries checks only for unchanged checklist text across reorder and insertions', async () => {
  const user = userEvent.setup()
  const key = `crewboard:decision-checks:${ROOT}::human`
  const makeChecklist = (text: string) => makeDetail({ id: decision.id, kind: 'decision', deps: decision.deps, contract: { path: 'docs/check.md', text, truncated: false } })
  mount(decision, { human: makeChecklist('- [ ] Open screen\n- [ ] Compare output') })
  await user.click(await screen.findByRole('checkbox', { name: 'Open screen' }))
  cleanup()
  mount(decision, { human: makeChecklist('- [ ] New condition\n- [ ] Compare output\n- [ ] Open screen') })
  expect(await screen.findByRole('checkbox', { name: 'Open screen' })).toHaveProperty('checked', true)
  expect(screen.getByRole('checkbox', { name: 'Compare output' })).toHaveProperty('checked', false)
  expect(screen.getByRole('checkbox', { name: 'New condition' })).toHaveProperty('checked', false)
  expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ version: 1, items: ['Open screen'] })
})

it('does not carry a check to a rephrased condition and drops legacy index-only ticks', async () => {
  const user = userEvent.setup()
  const key = `crewboard:decision-checks:${ROOT}::human`
  const makeChecklist = (text: string) => makeDetail({ id: decision.id, kind: 'decision', deps: decision.deps, contract: { path: 'docs/check.md', text, truncated: false } })
  mount(decision, { human: makeChecklist('- [ ] Verify the result') })
  await user.click(await screen.findByRole('checkbox', { name: 'Verify the result' }))
  cleanup()
  mount(decision, { human: makeChecklist('- [ ] Confirm the result') })
  expect(await screen.findByRole('checkbox', { name: 'Confirm the result' })).toHaveProperty('checked', false)
  cleanup()
  localStorage.setItem(key, JSON.stringify([0]))
  mount(decision, { human: makeChecklist('- [ ] Confirm the result') })
  expect(await screen.findByRole('checkbox', { name: 'Confirm the result' })).toHaveProperty('checked', false)
  expect(localStorage.getItem(key)).toBeNull()
})

it('says honestly when there is no contract', async () => {
  mount(decision, { human: makeDetail({ id: decision.id, kind: 'decision', deps: decision.deps }) })
  expect(await screen.findByText('Оркестратор не оставил списка проверки')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText('Открыть экран')).toBeNull()
  expect(screen.getByText('Принять решение — вы подтверждаете, что проверили и согласны.')).toBeTruthy()
  expect(screen.getByText('Вернуть… — укажите, что именно не так; причина уходит оркестратору.')).toBeTruthy()
})

it('lists dependency verdicts, models, changed files and selects a predecessor', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  mount(decision, {
    human: makeDetail({ id: decision.id, kind: 'decision', deps: decision.deps }),
    build: makeDetail({ id: 'build', worker: 'codex/gpt-6-sol', changedFiles: ['a', 'b'], verdict: { kind: 'result', facts: [] } }),
    review: makeDetail({ id: 'review', worker: 'claude/opus', changedFiles: ['c'], verdict: { kind: 'negative', claim: 'negative', facts: [] } }),
  }, onSelect)
  expect(await screen.findByText('Изменено 3 файла в задачах ниже')).toBeTruthy()
  expect(screen.getByText(/Результат получен · Codex GPT-6 Sol · изменено 2 файла/)).toBeTruthy()
  expect(screen.getByText(/Отрицательный результат · Claude Opus 5 · изменено 1 файл · Закрыта с отрицательным результатом/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Ревью' }))
  expect(onSelect).toHaveBeenCalledWith('review')
})

it('keeps the ordinary task panel snapshot', async () => {
  const task = makeTask({ id: 'ordinary', title: 'Обычная задача', status: 'in_review', worker: 'codex/gpt-6-sol' })
  const view = mount(task, { ordinary: makeDetail({ id: task.id }) })
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Обзор' })).toBeTruthy())
  expect(view.container.querySelector('.orc-panel')).toMatchSnapshot()
})

it('a decision in review shows its choice and «Where to look», never a verdict or worker lines (w1b, B05)', async () => {
  const reviewing = { ...decision, status: 'in_review' as const, check: 'checked' as const }
  // The host sends a decision without a verdict, even when the orchestrator stored a report for it.
  const detail = { ...makeDetail({ id: decision.id, kind: 'decision', status: 'in_review', deps: decision.deps, report: { runId: '', text: 'Варианты: A или B', source: 'orchestrator', truncated: false } }), verdict: undefined }
  const { container } = mount(reviewing, { human: detail })
  expect(await screen.findByRole('heading', { name: 'Куда смотреть' })).toBeTruthy()
  await waitFor(() => expect(screen.getByText('Варианты: A или B')).toBeTruthy())
  expect(container.querySelector('.orc-verdict')).toBeNull()
  // Predecessors keep their verdicts in «Where to look»; the decision itself has none.
  expect(screen.queryByText(/Спорно/)).toBeNull()
  expect(container.querySelector('.orc-panel__choice')).toBeNull()
  expect(container.querySelector('.orc-panel__identity-name')).toBeNull()
})
