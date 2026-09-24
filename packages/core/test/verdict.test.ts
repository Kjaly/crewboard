import { describe, expect, it } from 'vitest'
import { verdictOf } from '../src/orchestration/verdict.js'
import type { TaskDetail } from '../src/orchestration/detail.js'
import { acceptTask } from '../src/orchestration/review.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const detail = (patch: Partial<Omit<TaskDetail, 'verdict'>> = {}): Omit<TaskDetail, 'verdict'> => ({
  id: 't1', title: 'Задача', kind: 'implement', status: 'in_review', deps: [], dependents: [],
  runs: [{ runId: 'run_1', agent: 'worker', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:01:00Z', outcome: 'completed' }],
  notes: [], steers: [], events: [], changedFiles: ['src/a.ts'], report: { runId: 'run_1', text: 'Результат: получен\nТесты: 230 пройдены', source: 'section', truncated: false },
  ...patch,
})

describe('вердикт задачи', () => {
  it('считает заявленный результат при зелёном запуске и изменениях результатом', () => {
    expect(verdictOf(detail()).kind).toBe('result')
  })
  it('помечает успешное заявление при отменённом запуске спорным', () => {
    const result = verdictOf(detail({ runs: [{ runId: 'run_1', agent: 'worker', startedAt: '', outcome: 'cancelled' }] }))
    expect(result.kind).toBe('disputed')
    expect(result.mismatch).toBe('run_failed')
  })
  it('сохраняет отрицательный вердикт при приёмке в заметке', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-verdict-'))
    try {
      await initPlan(root, 'цель')
      await updatePlan(root, (plan) => { plan.tasks.push({ id: 't1', title: 'Задача', kind: 'implement', status: 'ready', deps: [], runs: [], notes: [] }); return plan })
      await acceptTask(root, 't1', new Date('2026-09-22T10:00:00Z'), verdictOf(detail({ report: { runId: 'run_1', text: 'Результат: заблокирован', source: 'final', truncated: false } })))
      expect((await loadPlan(root)).tasks[0]?.notes.at(-1)?.text).toContain('negative')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('считает отсутствие изменений при заявленном успехе спорным', () => {
    expect(verdictOf(detail({ changedFiles: [] })).kind).toBe('disputed')
  })
  it('не принимает отчёт без claim за результат', () => {
    const result = verdictOf(detail({ report: { runId: 'run_1', text: 'Тесты зелёные', source: 'final', truncated: false } }))
    expect(result.kind).toBe('disputed')
    expect(result.mismatch).toBe('claim_missing')
  })
  it.each([
    ['t3d: команда и числовой итог с суффиксом контракта', '<checks>\n- pnpm --filter crewboard test → green\n</checks>', 'Результат: получен\nВыполнил pnpm --filter @crewboard/core build && pnpm --filter crewboard test; 267 тестов прошли', 'checks_run'],
    ['t1: выполнена проверка статуса', '<checks>\n- git status --short\n</checks>', 'Результат: получен\nВыполнил git status --short; рабочее дерево чистое', 'checks_run'],
    ['t3b: команда названа, но сказано что не запускалась', '<checks>\n- pnpm lint:i18n\n</checks>', 'Результат: отрицательный\nПроверки не запускал; pnpm lint:i18n не пройдёт', 'checks_not_run'],
    ['команда только процитирована, нет сообщения о запуске', '<checks>\n- pnpm --filter crewboard test\n</checks>', 'Результат: получен\nКонтракт просил «pnpm --filter crewboard test».', 'checks_unreported'],
  ] as const)('%s', (_name, contract, text, expected) => {
    const result = verdictOf(detail({ contract: { path: 'contract.md', text: contract, truncated: false }, report: { runId: 'run_1', text, source: 'section', truncated: false } }))
    expect(result.facts.some((fact) => fact.code === expected)).toBe(true)
    expect(result.mismatch).toBeUndefined()
  })
  it('не считает непомянутую проверку невыполненной или mismatch', () => {
    const result = verdictOf(detail({ contract: { path: 'contract.md', text: '<checks>\n- pnpm lint:i18n\n</checks>', truncated: false } }))
    expect(result.kind).toBe('result')
    expect(result.mismatch).toBeUndefined()
    expect(result.facts.some((fact) => fact.code === 'checks_unreported')).toBe(true)
  })
  it('не считает отсутствующий отчёт результатом', () => {
    const result = verdictOf(detail({ report: undefined }))
    expect(result.kind).toBe('disputed')
    expect(result.mismatch).toBe('report_missing')
  })
  it('сохраняет строку источника, а длинный тестовый факт не копирует в чип', () => {
    const long = 'Проверки: выполнена полная интеграционная проверка нескольких сценариев без ошибок'
    const facts = verdictOf(detail({ report: { runId: 'run_1', text: `Результат: получен\n\n${long}`, source: 'section', truncated: false } })).facts
    expect(facts.find((fact) => fact.sourceLine === 2)).toEqual({ code: 'tests', tone: 'ok', sourceLine: 2 })
    expect(facts.find((fact) => fact.sourceLine === 2)?.text).toBeUndefined()
    expect(verdictOf(detail()).facts.find((fact) => fact.sourceLine === 1)?.text).toBe('Тесты: 230 пройдены')
  })
})
