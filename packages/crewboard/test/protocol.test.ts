import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPool } from '../src/workers/pool.js'
import { parseOutcome, workerPrompt } from '../src/workers/protocol.js'
import { builtinAgents } from '../src/workers/agents.js'
import { createFakeBackend } from './fake-backend.js'

describe('parseOutcome', () => {
  it.each([
    ['report tag', 'Сделал.\n<crewboard-report>Короб готов</crewboard-report>', { kind: 'report', summary: 'Короб готов' }],
    ['question with options', '<crewboard-question>Шторка или слой?\n\n- Шторка\n- Слой</crewboard-question>', { kind: 'question', text: 'Шторка или слой?', options: ['Шторка', 'Слой'] }],
    ['no tag: the whole answer is the result', 'Всё готово, тесты зелёные', { kind: 'report', summary: 'Всё готово, тесты зелёные' }],
    ['empty answer', '   ', { kind: 'report', summary: 'The worker finished without a report', code: 'no_report' }],
    ['both tags: the last wins', '<crewboard-question>A?</crewboard-question>\n<crewboard-report>B</crewboard-report>', { kind: 'report', summary: 'B' }],
  ])('%s', (_name, input, expected) => {
    expect(parseOutcome(input)).toEqual(expected)
  })
})

describe('parseOutcome: split', () => {
  it.each([
    ['two parts with and without a provider', 'Делю.\n<crewboard-split>\n- [codex] Короб | панели; вырезы\n- Инструкция | шаги по порядку\n</crewboard-split>', { kind: 'split', summary: 'Делю.', parts: [{ title: 'Короб', criteria: ['панели', 'вырезы'], provider: 'codex' }, { title: 'Инструкция', criteria: ['шаги по порядку'] }] }],
    ['unknown provider and blank lines', '<crewboard-split>\n\n- [gemini] Тесты\n  \n</crewboard-split>', { kind: 'split', summary: 'The work is split into parts', parts: [{ title: 'Тесты', criteria: [] }], code: 'split' }],
  ])('%s', (_name, input, expected) => {
    expect(parseOutcome(input)).toEqual(expected)
  })

  it('names a part after a registered agent the worker chose', () => {
    const out = parseOutcome('<crewboard-split>\n- [kimi] Тесты\n</crewboard-split>', new Set(['claude', 'codex', 'deepseek', 'kimi']))
    expect(out.kind === 'split' && out.parts).toEqual([{ title: 'Тесты', criteria: [], provider: 'kimi' }])
  })

  it('keeps every listed part; the supervisor caps the count', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- Часть ${i + 1}`).join('\n')
    const out = parseOutcome(`<crewboard-split>\n${lines}\n</crewboard-split>`)
    expect(out.kind === 'split' && out.parts.length).toBe(30)
  })
})

describe('workerPrompt', () => {
  it('states the task, its criteria, its chain and the protocol', () => {
    const prompt = workerPrompt({ title: 'Модель короба', criteria: ['Панели с толщиной'], resultKind: 'local', chain: ['Кухня полного цикла'] })
    expect(prompt).toContain('Модель короба')
    expect(prompt).toContain('Панели с толщиной')
    expect(prompt).toContain('Кухня полного цикла')
    expect(prompt).toContain('<crewboard-report>')
    expect(prompt).toContain('<crewboard-question>')
    expect(prompt).toContain('<crewboard-split>')
  })
})

describe('built-in agents', () => {
  it.each([
    ['claude', undefined, 'claude/sonnet'],
    ['claude', 'opus', 'claude/opus'],
    ['codex', undefined, 'codex/gpt-6.1-sol'],
    ['deepseek', undefined, 'dsh/deepseek-flash'],
    ['deepseek', 'deepseek-pro', 'dsh/deepseek-pro'],
  ] as const)('%s %s', async (provider, model, expected) => {
    expect(builtinAgents.coreId((await builtinAgents.get(provider))!, model)).toBe(expected)
  })
})

describe('pool', () => {
  const make = async () => {
    const fake = createFakeBackend()
    const pool = createPool({ backendFor: async () => fake.backend, runsDir: await mkdtemp(join(tmpdir(), 'cb-runs-')) })
    return { fake, pool }
  }

  it('reads a finished run: its feed from an index, its final text and terminal state', async () => {
    const { fake, pool } = await make()
    fake.script({ events: ['one', 'two'], final: 'итог' })
    const runId = await pool.launch({ agent: 'codex/', cwd: '/repo', prompt: 'p' })
    const r = await pool.poll('codex/', runId, 1)
    expect(r.events.map((e) => e.text)).toEqual(['two', 'итог'])
    expect(r.nextIndex).toBe(3)
    expect(r).toMatchObject({ terminal: true, failed: false, finalText: 'итог' })
  })

  it('takes the final text from streamed answer chunks when the backend sends no result event (dsh)', async () => {
    const { fake, pool } = await make()
    fake.script({ events: ['ls'], deltas: ['math.js экспортирует `add`.\n\n<crewboard-report>Экспорт ', 'один: add</crewboard-report>'] })
    const runId = await pool.launch({ agent: 'dsh/deepseek-flash', cwd: '/repo', prompt: 'p' })
    const r = await pool.poll('dsh/deepseek-flash', runId, 0)
    expect(r.finalText).toContain('<crewboard-report>Экспорт один: add</crewboard-report>')
  })

  it('reports why a run failed', async () => {
    const { fake, pool } = await make()
    fake.script({ fail: 'auth' })
    const runId = await pool.launch({ agent: 'claude/sonnet', cwd: '/repo', prompt: 'p' })
    expect(await pool.poll('claude/sonnet', runId, 0)).toMatchObject({ terminal: true, failed: true, reason: 'auth' })
  })

  it('does not steer a run that already ended', async () => {
    const { fake, pool } = await make()
    const runId = await pool.launch({ agent: 'codex/', cwd: '/repo', prompt: 'p' })
    expect(await pool.steer('codex/', runId, 'ещё')).toBe('ended')
    expect(fake.runs[0]!.steers).toEqual([])
  })

  it('steers a live run', async () => {
    const { fake, pool } = await make()
    fake.script({ hold: true })
    const runId = await pool.launch({ agent: 'codex/', cwd: '/repo', prompt: 'p' })
    expect(await pool.steer('codex/', runId, 'ещё')).toBe('delivered')
    expect(fake.runs[0]!.steers).toEqual(['ещё'])
  })
})
