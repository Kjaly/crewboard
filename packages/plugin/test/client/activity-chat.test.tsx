// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '../../src/shared/types.js'
import type { SteerResult } from '@crewboard/core'
import { setLang } from '../../src/client/i18n.js'
import { Conversation, conversationTurns } from '../../src/client/panel/conversation.js'
import { ActivityComposer, type SteerFeedback } from '../../src/client/panel/activity-composer.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask, type FetchCall } from './helpers.js'

type Event = TaskDetail['events'][number]
const at = (n: number) => `2026-09-22T12:${String(n).padStart(2, '0')}:00Z`
const action = (n: number, text = `step ${n}`): Event => ({ ts: at(n), kind: 'action', text })

beforeEach(() => setLang('ru'))
afterEach(() => cleanup())

describe('conversation projection', () => {
  it('folds an action+file mix into one technical turn and keeps prose as its boundary', () => {
    const events: Event[] = [
      action(0, 'pnpm test'),
      { ts: at(1), kind: 'file', text: 'a.ts' },
      { ts: at(2), kind: 'message', text: 'Готово.' },
      { ts: at(3), kind: 'action', text: 'pnpm build' },
    ]
    const turns = conversationTurns(events)
    expect(turns.map((turn) => [turn.kind, turn.events.length])).toEqual([
      ['technical', 2], ['message', 1], ['technical', 1],
    ])
    expect(turns[0]?.kind === 'technical' && turns[0].latest.text).toBe('a.ts')
  })

  it('keeps a tool error inside the technical turn and a run problem outside it', () => {
    const events: Event[] = [
      action(0),
      { ts: at(1), kind: 'problem', text: 'edit failed', origin: 'tool' },
      action(2),
      { ts: at(3), kind: 'problem', text: 'supervisor exited', origin: 'interrupt' },
    ]
    const turns = conversationTurns(events)
    expect(turns.map((turn) => turn.kind)).toEqual(['technical', 'problem'])
    expect(turns[0]?.kind === 'technical' && turns[0].problems).toHaveLength(1)
    expect(turns[0]?.kind === 'technical' && turns[0].events).toHaveLength(3)
  })

  it('orders turns exactly as the normalized events arrived', () => {
    const events: Event[] = [
      { ts: at(0), kind: 'message', text: 'Первое' },
      action(1),
      { ts: at(2), kind: 'steer', text: 'уточни' },
      { ts: at(3), kind: 'message', text: 'Второе' },
    ]
    expect(conversationTurns(events).map((turn) => turn.ts)).toEqual([at(0), at(1), at(2), at(3)])
  })
})

describe('conversation rendering', () => {
  it('names a known operation and target from tool metadata, never from the file name alone', () => {
    const events: Event[] = [
      { ts: at(1), kind: 'action', text: 'pnpm test', tool: { name: 'bash', op: 'command', target: 'pnpm test' } },
      { ts: at(2), kind: 'file', text: 'a.ts', tool: { name: 'write', op: 'write', target: '/wt/a.ts' } },
      { ts: at(3), kind: 'file', text: 'b.ts' },
    ]
    render(<Conversation events={events} />)
    expect(screen.getByText('Выполняет команду')).toBeTruthy()
    expect(screen.getByText('Пишет')).toBeTruthy()
    // No metadata: the step stays the actual reported text.
    expect(screen.getAllByText('b.ts').length).toBeGreaterThan(0)
  })

  it('shows a tool problem on the technical summary and in its details', () => {
    const events: Event[] = [action(0), { ts: at(1), kind: 'problem', text: 'edit failed', origin: 'tool' }]
    const { container } = render(<Conversation events={events} />)
    expect(screen.getByText('1 проблема')).toBeTruthy()
    expect(container.querySelector('.orc-tech__step--problem')?.textContent).toContain('edit failed')
  })

  it('renders an unknown-author direction neutrally and a public final as agent prose', () => {
    const events: Event[] = [
      { ts: at(1), kind: 'steer', text: 'Перепроверь' },
      { ts: at(2), kind: 'final', text: 'Готово.', display: 'Готово.\n\nС уважением.' },
    ]
    const { container } = render(<Conversation events={events} />)
    expect(screen.getByText('Указание')).toBeTruthy()
    expect(screen.queryByText('Вы')).toBeNull()
    expect(screen.getByText('Агент')).toBeTruthy()
    expect(container.querySelector('.orc-turn--final .orc-turn__body')?.textContent).toBe('Готово.\n\nС уважением.')
  })
})

const OUTCOME = (delivery: SteerResult['delivery'], over: Record<string, unknown> = {}): SteerFeedback => ({
  text: 'сделано',
  result: { delivery, state: 'queued', steerId: 'steer-1', message: 'сделано', ...over } as unknown as SteerResult,
})

describe('Activity composer', () => {
  it('prefills «Ask for progress» only into an empty draft and never sends', async () => {
    const onChange = vi.fn()
    const onSend = vi.fn()
    const { rerender } = render(<ActivityComposer value="" onChange={onChange} onSend={onSend} pending={false} outcome={null} onRelaunch={() => {}} focusSignal={0} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спросить о ходе' }))
    expect(onChange).toHaveBeenCalledWith('Кратко: что сделано, текущий шаг и следующий шаг?')
    expect(onSend).not.toHaveBeenCalled()
    onChange.mockClear()
    rerender(<ActivityComposer value="свой текст" onChange={onChange} onSend={onSend} pending={false} outcome={null} onRelaunch={() => {}} focusSignal={0} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спросить о ходе' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('sends on Ctrl+Enter, not on a plain Enter, and disables an empty or pending draft', () => {
    const onSend = vi.fn()
    const { rerender } = render(<ActivityComposer value="готово" onChange={() => {}} onSend={onSend} pending={false} outcome={null} onRelaunch={() => {}} focusSignal={0} />)
    const field = screen.getByRole('textbox', { name: 'Сообщение агенту' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    rerender(<ActivityComposer value="" onChange={() => {}} onSend={onSend} pending={false} outcome={null} onRelaunch={() => {}} focusSignal={0} />)
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveProperty('disabled', true)
    rerender(<ActivityComposer value="готово" onChange={() => {}} onSend={onSend} pending outcome={null} onRelaunch={() => {}} focusSignal={0} />)
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveProperty('disabled', true)
  })

  it('disables only the draft that was delivered, never a newer one, and keeps the id diagnostic', () => {
    const { rerender } = render(<ActivityComposer value="сделано" onChange={() => {}} onSend={() => {}} pending={false} outcome={OUTCOME('delivered')} onRelaunch={() => {}} focusSignal={0} />)
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/В очереди/)).toBeTruthy()
    expect(screen.getByText(/на момент отправки/)).toBeTruthy()
    expect(screen.getByTitle('steer-1')).toBeTruthy()
    rerender(<ActivityComposer value="новое указание" onChange={() => {}} onSend={() => {}} pending={false} outcome={OUTCOME('delivered')} onRelaunch={() => {}} focusSignal={0} />)
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveProperty('disabled', false)
  })

  it('prefers the current steer record over the initial receipt and never auto-relaunches', () => {
    const record = { id: 'steer-1', createdAt: at(1), mode: 'auto' as const, preview: 'сделано', file: '/tmp/s.md', state: 'acknowledged' as const, timestamps: { queued: at(1), acknowledged: at(2) } }
    const { rerender } = render(<ActivityComposer value="сделано" onChange={() => {}} onSend={() => {}} pending={false} outcome={OUTCOME('delivered')} record={record} onRelaunch={() => {}} focusSignal={0} />)
    expect(screen.getByText('Подтверждена')).toBeTruthy()
    expect(screen.queryByText(/на момент отправки/)).toBeNull()
    const abandoned = { ...record, state: 'abandoned' as const, reason: 'run_finished' as const, timestamps: { queued: at(1), abandoned: at(2) } }
    const onRelaunch = vi.fn()
    rerender(<ActivityComposer value="сделано" onChange={() => {}} onSend={() => {}} pending={false} outcome={OUTCOME('delivered')} record={abandoned} onRelaunch={onRelaunch} focusSignal={0} />)
    expect(screen.getByText(/Поправка не доставлена/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Перезапустить с этой поправкой' })).toBeTruthy()
    expect(onRelaunch).not.toHaveBeenCalled()
  })

  it('keeps an unsent draft visible in a read-only composer after the run ends', () => {
    const { container, unmount } = render(<ActivityComposer value="мой черновик" onChange={() => {}} onSend={() => {}} pending={false} outcome={null} onRelaunch={() => {}} focusSignal={0} readOnly />)
    expect(screen.getByText(/Не отправлено/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Скопировать текст' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
    expect((container.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true)
    unmount()
    // A delivered text is not called unsent.
    render(<ActivityComposer value="сделано" onChange={() => {}} onSend={() => {}} pending={false} outcome={OUTCOME('delivered')} onRelaunch={() => {}} focusSignal={0} readOnly />)
    expect(screen.queryByText(/Не отправлено/)).toBeNull()
  })
})

describe('composer against the real steer API', () => {
  const RUN = { runId: 'r1', agent: 'dsh', startedAt: at(0) }
  const running = () => makeTask({ id: 'a', status: 'running', runs: 1 })

  it('keeps a newer draft and its own outcome when an older request resolves delivered', async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: 'a', status: 'running', runs: [RUN] }))
      if (url.includes('/api/steer')) return new Promise((done) => { resolve = done })
      return jsonOk(null)
    })
    const task = running()
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'первое')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await user.clear(field)
    await user.type(field, 'второе')
    resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { kind: 'steer', delivery: 'delivered', state: 'queued', steerId: 'steer-1', message: 'первое' } }) })
    await waitFor(() => expect(screen.getByText(/В очереди/)).toBeTruthy())
    expect(screen.getByTitle('steer-1')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Сообщение агенту' }) as HTMLTextAreaElement).value).toBe('второе')
    expect(screen.getByRole('button', { name: 'Отправить' })).toHaveProperty('disabled', false)
  })

  it.each(['delivered', 'error'] as const)('never projects another task response (%s) into the selected task', async (response) => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: url.includes('id=b') ? 'b' : 'a', status: 'running', runs: [RUN] }))
      if (url.includes('/api/steer')) return new Promise((done) => { resolve = done })
      return jsonOk(null)
    })
    const a = makeTask({ id: 'a', status: 'running', runs: 1 })
    const b = makeTask({ id: 'b', status: 'running', runs: 1 })
    const repo = makeRepo([a, b])
    const { rerender } = render(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
    await user.type(await screen.findByRole('textbox', { name: 'Сообщение агенту' }), 'для A')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача b' })).toBeTruthy())
    resolve(response === 'delivered'
      ? { ok: true, status: 200, json: async () => ({ ok: true, value: { kind: 'steer', delivery: 'delivered', state: 'queued', steerId: 'steer-A', message: 'для A' } }) }
      : { ok: false, status: 409, json: async () => ({ ok: false, error: 'old-task-error' }) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Остановить' })).toHaveProperty('disabled', false))
    expect(screen.queryByText(/old-task-error/)).toBeNull()
    await waitFor(() => expect(screen.queryByText(/В очереди/)).toBeNull())
    expect(screen.queryByTitle('steer-A')).toBeNull()
  })

  it('brings an older-run view back to the latest conversation when Give direction is used', async () => {
    const user = userEvent.setup()
    const runs = [{ runId: 'r1', agent: 'dsh', startedAt: at(0) }, { runId: 'r2', agent: 'dsh', startedAt: at(1) }]
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'running', runs })) : jsonOk(null)))
    const task = makeTask({ id: 'a', status: 'running', runs: 2 })
    const { container } = render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const select = async () => {
      await waitFor(() => expect(container.querySelector('#orc-activity-run')).toBeTruthy())
      return container.querySelector('#orc-activity-run') as HTMLSelectElement
    }
    fireEvent.change(await select(), { target: { value: 'r1' } })
    expect((await select()).value).toBe('r1')
    // An older run is read-only: neither the composer nor a sendable fallback form appears.
    expect(screen.queryByRole('textbox', { name: 'Сообщение агенту' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Поправить…' }))
    await waitFor(() => expect((container.querySelector('#orc-activity-run') as HTMLSelectElement).value).toBe('r2'))
    expect(screen.getByRole('textbox', { name: 'Сообщение агенту' })).toBeTruthy()
  })

  it('preserves an unsent draft and never relaunches when the run turns terminal mid-request', async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    const calls = installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: 'a', status: 'running', runs: [RUN] }))
      if (url.includes('/api/steer')) return new Promise((done) => { resolve = done })
      return jsonOk(null)
    })
    const task = running()
    const repo = makeRepo([task])
    const { rerender } = render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    await user.type(await screen.findByRole('textbox', { name: 'Сообщение агенту' }), 'не отправлено')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    const ended = makeTask({ id: 'a', status: 'in_review', runs: 1 })
    rerender(<TaskPanel repo={repo} task={ended} attention={[]} onSelect={() => {}} density="overview" />)
    resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { kind: 'steer', delivery: 'abandoned', state: 'abandoned', reason: 'run_finished', steerId: 'steer-2', message: 'не отправлено' } }) })
    await waitFor(() => expect(calls.filter((call: FetchCall) => call.url.includes('/api/relaunch'))).toHaveLength(0))
    // The draft survives the run ending; the API's real outcome is shown, not a fake confirmation.
    rerender(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Сообщение агенту' }) as HTMLTextAreaElement).value).toBe('не отправлено'))
    expect(screen.getByText(/Поправка не доставлена/)).toBeTruthy()
    expect(screen.getByTitle('steer-2')).toBeTruthy()
  })

  it('keeps a refused steer\u2019s text and relaunches with it, never an empty note', async () => {
    const user = userEvent.setup()
    const calls = installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: 'a', status: 'running', runs: [RUN] }))
      if (url.includes('/api/steer')) return jsonOk({ kind: 'steer', delivery: 'refused', state: 'refused', runId: 'r1', runState: 'running', steerId: 'steer-r', message: 'правка' })
      if (url.includes('/api/relaunch')) return jsonOk({ runId: 'r2' })
      return jsonOk(null)
    })
    const task = running()
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'правка')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(screen.getByText(/Поправка отклонена/)).toBeTruthy())
    // A refused request keeps the submitted text so it can be corrected and retried.
    expect((field as HTMLTextAreaElement).value).toBe('правка')
    await user.click(screen.getByRole('button', { name: 'Перезапустить с этой поправкой' }))
    await waitFor(() => expect(calls.filter((call: FetchCall) => call.url.includes('/api/relaunch'))).toHaveLength(1))
    expect(calls.find((call: FetchCall) => call.url.includes('/api/relaunch'))?.body).toMatchObject({ repo: '/repo', task: 'a', note: 'правка' })
  })

  it('relaunches an abandoned queued steer from the captured text after its draft was cleared', async () => {
    const user = userEvent.setup()
    let steers: unknown[] = []
    const calls = installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: 'a', status: 'running', runs: [RUN], steers: steers as never }))
      if (url.includes('/api/steer')) return jsonOk({ kind: 'steer', delivery: 'delivered', state: 'queued', runId: 'r1', steerId: 'steer-q', message: 'очередь' })
      if (url.includes('/api/relaunch')) return jsonOk({ runId: 'r2' })
      return jsonOk(null)
    })
    const task = running()
    const repo = makeRepo([task])
    const { rerender } = render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'очередь')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    // An accepted queued write clears only the exact submitted revision.
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(''))
    expect(calls.filter((call: FetchCall) => call.url.includes('/api/relaunch'))).toHaveLength(0)
    // The queued steer is abandoned later: the detail carries the record.
    steers = [{ id: 'steer-q', createdAt: at(1), mode: 'auto', preview: 'очередь', text: 'очередь', file: '/f', state: 'abandoned', timestamps: { queued: at(1), abandoned: at(2) }, reason: 'run_finished' }]
    const ended = makeTask({ id: 'a', status: 'in_review', runs: 1 })
    rerender(<TaskPanel repo={makeRepo([ended])} task={ended} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByTitle('steer-q')).toBeTruthy())
    rerender(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const relaunch = await screen.findByRole('button', { name: 'Перезапустить с этой поправкой' })
    await user.click(relaunch)
    await waitFor(() => expect(calls.filter((call: FetchCall) => call.url.includes('/api/relaunch'))).toHaveLength(1))
    // The captured delivery text is the note; the cleared draft never yields an empty relaunch.
    expect(calls.find((call: FetchCall) => call.url.includes('/api/relaunch'))?.body).toMatchObject({ note: 'очередь' })
  })

  it('keeps A\u2019s in-flight steer across B and back, and never shows it on B', async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    installFetch((url) => {
      if (url.includes('/api/task')) return jsonOk(makeDetail({ id: url.includes('id=b') ? 'b' : 'a', status: 'running', runs: [RUN] }))
      if (url.includes('/api/steer')) return new Promise((done) => { resolve = done })
      return jsonOk(null)
    })
    const a = running()
    const b = makeTask({ id: 'b', status: 'running', runs: 1 })
    const repo = makeRepo([a, b])
    const { rerender } = render(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
    const field = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    await user.type(field, 'для A')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    // B is visited while A is still in flight: it never inherits A's text or in-flight state.
    rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача b' })).toBeTruthy())
    expect((await screen.findByRole('textbox', { name: 'Сообщение агенту' }) as HTMLTextAreaElement).value).toBe('')
    // Back to A before the answer, with a newer draft typed on top.
    rerender(<TaskPanel repo={repo} task={a} attention={[]} onSelect={() => {}} density="overview" />)
    const back = await screen.findByRole('textbox', { name: 'Сообщение агенту' })
    expect((back as HTMLTextAreaElement).value).toBe('для A')
    await user.type(back, ' A2')
    resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: { kind: 'steer', delivery: 'delivered', state: 'queued', steerId: 'steer-A', message: 'для A' } }) })
    await waitFor(() => expect(screen.getByText(/В очереди/)).toBeTruthy())
    // The older answer neither overwrites the newer draft nor leaks into B.
    expect((screen.getByRole('textbox', { name: 'Сообщение агенту' }) as HTMLTextAreaElement).value).toBe('для A A2')
    rerender(<TaskPanel repo={repo} task={b} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача b' })).toBeTruthy())
    expect((screen.getByRole('textbox', { name: 'Сообщение агенту' }) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByText(/В очереди/)).toBeNull()
  })
})
