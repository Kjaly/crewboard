import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCliBackend, normalize, runCliRun } from '@crewboard/core'
import { describe, expect, it } from 'vitest'
import { createPool } from '../src/workers/pool.js'
import { handbackEvents, parseOutcome, workerPrompt, workerResponseSchema } from '../src/workers/protocol.js'
import { stepsFromEvents } from '../src/workers/steps.js'
import { builtinAgents } from '../src/workers/agents.js'
import { createFakeBackend } from './fake-backend.js'

describe('parseOutcome', () => {
  it.each([
    ['report', '<crewboard-report>Готово</crewboard-report>', { count: 3 }, { kind: 'report', summary: 'Готово', result: { count: 3 } }],
    ['question', '<crewboard-question>Как?\n\n- Так\n- Иначе</crewboard-question>', null, { kind: 'question', text: 'Как?', options: ['Так', 'Иначе'] }],
    ['split', 'Делю.\n<crewboard-split>\n- [codex] Код | готов\n- Тесты | проходят\n</crewboard-split>', null, { kind: 'split', summary: 'Делю.', parts: [{ title: 'Код', criteria: ['готов'], provider: 'codex' }, { title: 'Тесты', criteria: ['проходят'] }] }],
    ['zero result', '<crewboard-report>Ноль</crewboard-report>', 0, { kind: 'report', summary: 'Ноль', result: 0 }],
    ['false result', '<crewboard-report>Нет</crewboard-report>', false, { kind: 'report', summary: 'Нет', result: false }],
  ])('reads the %s envelope', (_name, handback, result, expected) => {
    expect(parseOutcome(JSON.stringify({ handback, result }))).toEqual(expected)
  })

  it.each(['{"answer":"ordinary JSON"}', '{"handback":3,"result":{}}', '{broken'])('keeps non-envelope text: %s', (input) => {
    expect(parseOutcome(input)).toEqual({ kind: 'report', summary: input })
  })

  it.each([
    ['report tag', 'Сделал.\n<crewboard-report>Короб готов</crewboard-report>', { kind: 'report', summary: 'Короб готов', detail: 'Сделал.' }],
    ['text before and after the report', 'Answer before.\n<crewboard-report>Summary</crewboard-report>\nAnswer after.', { kind: 'report', summary: 'Summary', detail: 'Answer before.\n\nAnswer after.' }],
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

describe('workerResponseSchema', () => {
  it.each(['', '#', '#result'])('rebases references when $id=%j keeps the same document', ($id) => {
    expect(workerResponseSchema({ $id, properties: { count: { $ref: '#/$defs/count' } }, $defs: { count: { type: 'integer' } } })).toMatchObject({ properties: { result: { anyOf: [{ properties: { count: { $ref: '#/properties/result/anyOf/0/$defs/count' } } }, { type: 'null' }] } } })
  })

  it('rebases document-local references without changing annotation data or the supplied schema', () => {
    const schema = { type: 'object', properties: { node: { $ref: '#/$defs/node' } }, $defs: { node: { type: 'object', properties: { next: { $ref: '#' } } } }, default: { $ref: '#/literal-data' } }
    const original = structuredClone(schema)
    const wrapped = workerResponseSchema(schema)
    expect(wrapped).toMatchObject({ properties: { result: { anyOf: [{ properties: { node: { $ref: '#/properties/result/anyOf/0/$defs/node' } }, $defs: { node: { properties: { next: { $ref: '#/properties/result/anyOf/0' } } } }, default: { $ref: '#/literal-data' } }, { type: 'null' }] } } })
    expect(schema).toEqual(original)
  })
})

describe('handback display', () => {
  it('reassembles an envelope streamed in chunks by a fallback backend', () => {
    const handback = '<crewboard-question>Как?\n\n- Один\n- Два</crewboard-question>'
    const response = JSON.stringify({ result: { evidence: 'x'.repeat(64_000) }, handback })
    const raw = [{ ts: 't1', type: 'answer_delta', data: response.slice(0, 33_000) }, { ts: 't2', type: 'answer_delta', data: response.slice(33_000) }]
    expect(stepsFromEvents(normalize(handbackEvents(raw)))).toEqual([{ i: 0, ts: 't1', kind: 'message', text: 'Как? - Один - Два', detail: 'Как?\n\n- Один\n- Два' }])
    expect(raw.map((event) => event.data).join('')).toBe(response)
    const withNarration = [{ ts: 't0', type: 'answer_delta', data: 'Проверяю.\n' }, ...raw, { ts: 't3', type: 'result', data: response }]
    const steps = stepsFromEvents(normalize(handbackEvents(withNarration)))
    expect(steps).toHaveLength(1)
    expect(steps[0]?.detail).toBe('Проверяю.\nКак?\n\n- Один\n- Два')
  })

  it('projects the human response before clipping a large structured result and keeps raw data intact', () => {
    const handback = '<crewboard-question>Как?\n\n- Один\n- Два</crewboard-question>'
    const response = JSON.stringify({ result: { evidence: 'x'.repeat(64_000) }, handback })
    const raw = [{ ts: 't1', type: 'answer_delta', data: response }, { ts: 't2', type: 'result', data: response }]
    expect(stepsFromEvents(normalize(handbackEvents(raw)))).toEqual([{ i: 0, ts: 't1', kind: 'message', text: 'Как? - Один - Два', detail: 'Как?\n\n- Один\n- Два' }])
    expect(raw[0]?.data).toBe(response)
    expect(raw[1]?.data).toBe(response)
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

  it('wraps the result schema while keeping handback instructions on fresh, resumed and fallback prompts', async () => {
    const { fake, pool } = await make()
    const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false }
    await pool.launch({ agent: 'codex/model', cwd: '/repo', prompt: 'Check files', fallbackPrompt: 'Full assignment', previousSessionId: 'session', schema })
    const launch = fake.launches[0]!
    expect(launch.schema).toMatchObject({ type: 'object', required: ['handback', 'result'], additionalProperties: false, properties: { handback: { type: 'string' }, result: { anyOf: [schema, { type: 'null' }] } } })
    expect(await readFile(launch.promptFile, 'utf8')).toContain('handback')
    expect(await readFile(launch.promptFile, 'utf8')).toContain('crewboard-question')
    expect(await readFile(launch.fallbackPromptFile!, 'utf8')).toContain('handback')
  })

  it('keeps the structured result intact when polling', async () => {
    const { fake, pool } = await make()
    const final = JSON.stringify({ handback: '<crewboard-report>Готово</crewboard-report>', result: { count: 3 } })
    fake.script({ events: ['Checking'], final })
    const runId = await pool.launch({ agent: 'codex/model', cwd: '/repo', prompt: 'p' })
    const run = await pool.poll('codex/model', runId, 0)
    expect(run.finalText).toBe(final)
    expect(parseOutcome(run.finalText!)).toEqual({ kind: 'report', summary: 'Готово', result: { count: 3 } })
  })

  it.each((['claude', 'codex'] as const).flatMap((kind) => [
    { kind, handback: '<crewboard-report>Готово</crewboard-report>', result: { count: 3 }, expected: 'report' },
    { kind, handback: '<crewboard-question>Как?</crewboard-question>', result: null, expected: 'question' },
    { kind, handback: '<crewboard-split>\n- Код\n- Тесты\n</crewboard-split>', result: null, expected: 'split' },
  ]))('$kind returns a $expected through the CLI and pool', async ({ kind, handback, result, expected }) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-schema-pool-'))
    const fixture = fileURLToPath(new URL('../../core/test/fixtures/fake-schema-cli.mjs', import.meta.url))
    const response = { handback, result }
    const backend = createCliBackend({ kind, runsRoot: dir, command: process.execPath, commandArgs: [fixture, kind], env: { ...process.env, TEST_SCHEMA_LOG: join(dir, 'argv.json'), TEST_SCHEMA_RESULT: JSON.stringify(response) }, startRunner: (args, env) => runCliRun(args, undefined, env) })
    const pool = createPool({ backendFor: async () => backend, runsDir: dir })
    const agent = `${kind}/model`
    const runId = await pool.launch({ agent, cwd: dir, prompt: 'Check files', schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } })
    const run = await pool.poll(agent, runId, 0)
    expect(run).toMatchObject({ terminal: true, failed: false, finalText: JSON.stringify(response) })
    const displayed = run.events.map((event) => event.display ?? event.text).join('\n')
    expect(displayed).not.toContain('"handback"')
    expect(displayed.split(handback)).toHaveLength(2)
    const outcome = parseOutcome(run.finalText!)
    expect(outcome.kind).toBe(expected)
    if (outcome.kind === 'report') expect(outcome.result).toEqual(result)
  })

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
