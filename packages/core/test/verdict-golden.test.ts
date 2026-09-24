import { describe, expect, it } from 'vitest'
import { checkState, verdictOf } from '../src/orchestration/verdict.js'
import type { TaskDetail } from '../src/orchestration/detail.js'
import { extractReport } from '../src/runs/report.js'
import type { RunEvidence } from '../src/runs/evidence.js'

/**
 * w1b (B04): honest reports in the phrasings workers actually use (ux3, ux7). The evidence is shaped the way a
 * run leaves it before w1b: `claimLine` is the answer's first line, the report is the extracted section.
 */
const detailOf = (answer: string, patch: Partial<Omit<TaskDetail, 'verdict'>> = {}): Omit<TaskDetail, 'verdict'> => {
  const report = extractReport('run_1', answer)
  const evidence: RunEvidence = {
    version: 1, runId: 'run_1', worker: 'worker', finalAnswer: answer, finalAnswerState: 'reported', report,
    claimLine: answer.split(/\r?\n/, 1)[0]?.trim(), files: [{ path: 'src/a.ts', added: 1, deleted: 0 }], filesState: 'reported',
    checks: [], checksState: 'unreadable', capturedAt: '2026-09-24T10:01:00Z',
  }
  return {
    id: 't1', title: 'Задача', kind: 'implement', status: 'in_review', deps: [], dependents: [],
    runs: [{ runId: 'run_1', agent: 'worker', startedAt: '2026-09-24T10:00:00Z', finishedAt: '2026-09-24T10:01:00Z', outcome: 'completed' }],
    notes: [], steers: [], events: [], changedFiles: ['src/a.ts'], report, evidence, ...patch,
  }
}

const tuple = (detail: Omit<TaskDetail, 'verdict'>) => {
  const verdict = verdictOf(detail)
  return { verdict: verdict.kind, reason: verdict.why ?? verdict.mismatch }
}

const prose = Array.from({ length: 12 }, (_, i) => `Шаг ${i + 1}: правка модуля.`).join('\n')

describe('golden table: claim in RU/EN reports → {verdict, reason}', () => {
  it.each([
    ['EN claim on the first line', 'Result: received\nDone.', 'result', undefined],
    ['RU claim on the first line', 'Результат: получен\nСделано.', 'result', undefined],
    ['RU report heading, then the claim (ux7 F-03)', '## Отчёт\nРезультат: получен\n- Проверки: pnpm test прошёл', 'result', undefined],
    ['EN report heading, blank line, then the claim', '## Report\n\nResult: received\n', 'result', undefined],
    ['report heading after long prose', `${prose}\n\n## Отчёт\nРезультат: получен`, 'result', undefined],
    ['a short preface before the claim', 'Готово, ниже отчёт.\n\nРезультат: получен', 'result', undefined],
    ['leading blank lines', '\n\nResult: received', 'result', undefined],
    ['bold label', '**Результат:** получен', 'result', undefined],
    ['bold line', '**Result: received**', 'result', undefined],
    ['list marker', '- Result: received', 'result', undefined],
    ['numbered list marker', '1. Результат: получен', 'result', undefined],
    ['quote marker', '> Результат: получен', 'result', undefined],
    ['inline code', '`Результат: получен`', 'result', undefined],
    ['trailing full stop', 'Результат: получен.', 'result', undefined],
    ['trailing explanation', 'Результат: Получен — всё по контракту', 'result', undefined],
    ['upper case', 'RESULT: RECEIVED', 'result', undefined],
    ['RU negative after a heading', '# Отчёт\n\nРезультат: отрицательный\nНе удалось воспроизвести.', 'negative', 'negative'],
    ['EN negative', 'Result: negative', 'negative', 'negative'],
    ['RU blocked in an «Итог» section', '## Итог\nРезультат: заблокирован — нет доступа', 'negative', 'blocked'],
    ['EN blocked with a full stop', 'Result: blocked.', 'negative', 'blocked'],
    ['no claim at all', 'Тесты зелёные, всё готово', 'disputed', 'claim_missing'],
    ['a claim that denies itself', 'Результат: не получен', 'disputed', 'claim_missing'],
    ['a quoted claim mid-line', 'Контракт просит строку «Результат: получен».', 'disputed', 'claim_missing'],
    ['a claim buried deep in prose, no report heading', `${prose}\nResult: received`, 'disputed', 'claim_missing'],
    // f0a (newsroom-guard): the label is kept, the value is the worker's own positive sentence.
    ['RU free-text result under an EN label (f0a)', 'Result: каркас монорепозитория по образцу Crewboard готов, все проверки зелёные. Закоммичено в ветке `orch/f0a-task` …', 'result', undefined],
    ['RU free-text result under a RU label', 'Результат: модуль реализован, тесты зелёные', 'result', undefined],
    ['EN free-text result', 'Result: the scaffold is done and all checks pass green', 'result', undefined],
    ['DE free-text result', 'Ergebnis: Gerüst fertig, alle Prüfungen grün', 'result', undefined],
    ['ES free-text result', 'Resultado: la tarea está completada', 'result', undefined],
    ['FR free-text result', 'Résultat : tâche terminée', 'result', undefined],
    ['a later sentence may carry a caveat', 'Result: каркас готов. Не запушено — по контракту.', 'result', undefined],
    ['RU free text that negates itself', 'Result: каркас не готов', 'disputed', 'claim_missing'],
    ['EN free text that negates itself', 'Result: scaffold not done yet', 'disputed', 'claim_missing'],
    ['a hedged free-text claim', 'Результат: готово частично', 'disputed', 'claim_missing'],
    ['a positive word with a failure in the same sentence', 'Result: done, but two tests failed', 'disputed', 'claim_missing'],
    ['a free-text line with no positive word', 'Result: see below', 'disputed', 'claim_missing'],
    ['a positive word that is only in progress', 'Результат: готовлю каркас', 'disputed', 'claim_missing'],
  ] as const)('%s', (_name, answer, verdict, reason) => {
    expect(tuple(detailOf(answer))).toEqual({ verdict, reason })
  })

  it('keeps a claimed result with no files disputed', () => {
    expect(tuple(detailOf('## Отчёт\nРезультат: получен', { changedFiles: [] }))).toEqual({ verdict: 'disputed', reason: 'no_files' })
  })
})

describe('golden table: check outcomes in RU/EN reports', () => {
  it.each([
    ['pnpm test — прошёл', 'run'],
    ['pnpm test прошел', 'run'],
    ['pnpm test прошли', 'run'],
    ['pnpm test: зелёный', 'run'],
    ['pnpm test зеленые', 'run'],
    ['pnpm test — ok', 'run'],
    ['pnpm test — OK', 'run'],
    ['✓ pnpm test', 'run'],
    ['pnpm test ✔', 'run'],
    ['pnpm test (9 тестов)', 'run'],
    ['- Проверки: pnpm test прошёл (9 тестов)', 'run'],
    ['pnpm test: 230 пройдены', 'run'],
    ['pnpm test: 12 passed', 'run'],
    ['pnpm test упал на 2 тестах', 'run'],
    ['pnpm test — не прошёл', 'run'],
    ['pnpm test не запускал', 'not_run'],
    ['pnpm test skipped', 'not_run'],
    ['Контракт просил pnpm test', 'unreported'],
  ] as const)('%s → %s', (line, state) => {
    expect(checkState(`Результат: получен\n${line}`, 'pnpm test')).toBe(state)
  })

  it('counts a Russian check line as a run contract check, and shows it without its list marker', () => {
    const answer = '## Отчёт\nРезультат: получен\n- Проверки: pnpm test прошёл (9 тестов)'
    const detail = detailOf(answer, { contract: { path: 'c.md', text: '<checks>\n- pnpm test\n</checks>', truncated: false } })
    const { evidence: _evidence, ...withoutEvidence } = detail
    const verdict = verdictOf(withoutEvidence)
    expect(verdict).toMatchObject({ kind: 'result' })
    expect(verdict.facts.find((fact) => fact.code === 'checks_run')).toMatchObject({ count: 1 })
    expect(verdict.facts.find((fact) => fact.code === 'tests')?.text).toBe('Проверки: pnpm test прошёл (9 тестов)')
  })
})
