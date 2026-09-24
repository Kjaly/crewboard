import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { RawEvent } from '../src/runs/raw-event.js'
import type { Backends } from '../src/orchestration/backends.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { extractReport, finalMessage } from '../src/runs/report.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as RawEvent[]

describe('extractReport', () => {
  it('finds the «Отчёт» section, stops at the next heading and falls back to the whole answer', () => {
    const text = [
      'Вступительное слово.',
      '',
      '## Что сделано',
      '- поправил ядро',
      '',
      '## Отчёт',
      'Сделано: извлечение отчёта.',
      '- проверено: pnpm --filter @crewboard/core test',
      '',
      '## Следующие шаги',
      'ничего',
    ].join('\n')
    expect(extractReport('run_a', text)).toEqual({
      runId: 'run_a',
      text: 'Сделано: извлечение отчёта.\n- проверено: pnpm --filter @crewboard/core test',
      source: 'section',
      truncated: false,
    })

    const itog = ['## Введение', 'текст', '', '### Итог', 'Короткий итог.', '#### Деталь', 'внутри раздела', '', '## Конец', 'вне'].join('\n')
    expect(extractReport('run_b', itog)).toMatchObject({
      source: 'section',
      text: 'Короткий итог.\n#### Деталь\nвнутри раздела',
    })

    expect(extractReport('run_c', 'Просто ответ без заголовка.')).toMatchObject({
      source: 'final',
      text: 'Просто ответ без заголовка.',
    })
    expect(extractReport('run_d', '## Report\nDid the thing.')).toMatchObject({ source: 'section', text: 'Did the thing.' })
  })

  it('truncates a long report at a line boundary with an ellipsis', () => {
    const text = '## Отчёт\nстрока один длинная\nстрока два тоже длинная\nстрока три'
    const cut = extractReport('run_t', text, 20)
    expect(cut).toEqual({ runId: 'run_t', text: 'строка один длинная…', source: 'section', truncated: true })
    expect(cut.text.length).toBeLessThanOrEqual(20)

    expect(extractReport('run_s', '## Отчёт\nкоротко', 100)).toMatchObject({ source: 'section', text: 'коротко', truncated: false })

    const longFinal = `начало без заголовка ${'х'.repeat(60)}\nвторая строка ${'у'.repeat(60)}`
    const finalCut = extractReport('run_f', longFinal, 30)
    expect(finalCut).toMatchObject({ source: 'final', truncated: true })
    expect(finalCut.text.endsWith('…')).toBe(true)
    expect(finalCut.text.length).toBeLessThanOrEqual(30)
  })
})

describe('finalMessage', () => {
  it('reads the full last assistant message from every backend shape normalize parses', async () => {
    expect(finalMessage(await fixture('devin-run.json'))).toBe("I'll start by reading the two files.")
    expect(finalMessage(await fixture('opencode-run.json'))).toBe('Confirmed ground truth. Now writing both files:')

    const long = `${'а'.repeat(140)} ${'б'.repeat(140)}`
    expect(long.length).toBeGreaterThan(200)

    // dsh/ACP and direct claude/codex streams: one `answer_delta` per text chunk.
    expect(finalMessage([{ ts: 't', type: 'answer_delta', backend: 'dsh', data: long }])).toBe(long)
    expect(finalMessage([{ ts: 't', type: 'answer_delta', backend: 'claude', data: long }])).toBe(long)
    expect(finalMessage([{ ts: 't', type: 'answer_delta', backend: 'codex', data: long }])).toBe(long)

    // Devin/OpenCode: deltas glue together; a lifecycle noise event does not split them.
    expect(
      finalMessage([
        { ts: 't1', type: 'answer_delta', backend: 'devin-cli', data: 'а'.repeat(140) },
        { ts: 't2', type: 'progress', backend: 'devin-cli', data: 'message.updated' },
        { ts: 't3', type: 'answer_delta', backend: 'devin-cli', data: 'б'.repeat(140) },
      ]),
    ).toBe('а'.repeat(140) + 'б'.repeat(140))

    // A tool call separates two answers: only the last one is the final message.
    expect(
      finalMessage([
        { ts: 't1', type: 'answer_delta', data: 'старое сообщение' },
        { ts: 't2', type: 'tool_started', data: 'Read file' },
        { ts: 't3', type: 'answer_delta', data: long },
      ]),
    ).toBe(long)

    // A saved `final` event carries the whole answer.
    expect(
      finalMessage([
        { ts: 't1', type: 'answer_delta', data: 'черновик' },
        { ts: 't2', type: 'final', data: long },
      ]),
    ).toBe(long)

    expect(finalMessage([{ ts: 't', type: 'tool_started', data: 'Read file' }])).toBeUndefined()
    expect(finalMessage([])).toBeUndefined()
  })
})

function fakeBackends(events: (runId: string) => Promise<RawEvent[]>): Backends {
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-x',
    events,
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  return { forAgent: async () => backend }
}

describe('getTaskDetail report', () => {
  it('attaches the report of the last completed run and omits it for a failed or unreadable one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-report-'))
    await initPlan(root, 'goal', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push({
        ...newTask({ id: 'done', title: 'Done' }),
        runs: [{ runId: 'run_dsh-done', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', outcome: 'completed' }],
      })
      p.tasks.push({
        ...newTask({ id: 'bad', title: 'Bad' }),
        runs: [{ runId: 'run_dsh-bad', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', outcome: 'failed' }],
      })
      p.tasks.push({
        ...newTask({ id: 'retry', title: 'Retry' }),
        runs: [
          { runId: 'run_dsh-retry1', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', outcome: 'completed' },
          { runId: 'run_dsh-retry2', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', outcome: 'failed' },
        ],
      })
      p.tasks.push({
        ...newTask({ id: 'boom', title: 'Boom' }),
        runs: [{ runId: 'run_dsh-boom', agent: 'dsh', startedAt: '2026-09-22T11:00:00Z', outcome: 'completed' }],
      })
      return p
    })
    const answer = '## Отчёт\nСделано: всё.\n- проверено: pnpm test'
    const calls: string[] = []
    const backends = fakeBackends(async (runId) => {
      calls.push(runId)
      if (runId === 'run_dsh-boom') throw new Error('backend недоступен')
      return [{ ts: 't', type: 'answer_delta', backend: 'dsh', data: answer }]
    })

    const done = await getTaskDetail(root, 'done', backends, nodeExec)
    expect(done.report).toEqual({
      runId: 'run_dsh-done',
      text: 'Сделано: всё.\n- проверено: pnpm test',
      source: 'section',
      truncated: false,
    })

    expect((await getTaskDetail(root, 'bad', backends, nodeExec)).report).toBeUndefined()
    expect((await getTaskDetail(root, 'boom', backends, nodeExec)).report).toBeUndefined()

    const retry = await getTaskDetail(root, 'retry', backends, nodeExec)
    expect(retry.report?.runId).toBe('run_dsh-retry1')
    expect(calls).toContain('run_dsh-retry1')
  })
})
