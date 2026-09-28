import { describe, expect, it } from 'vitest'
import { attestedVerdict, checkState, projectWorkerCheckClaims, verdictOf } from '../src/orchestration/verdict.js'
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
  it('keeps an explicit attested result despite historical blocked wording and surfaces a declared deviation', () => {
    expect(attestedVerdict('result', 'Result: заблокирован historically; this is the old worker report.\nDeviation: browser check not run.')).toMatchObject({
      kind: 'result', claim: 'result', caution: 'deviation', facts: [{ code: 'deviation', tone: 'warn' }],
    })
  })
  it('scopes check claims to each command so a browser NOT RUN line cannot taint git diff --check', () => {
    const report = '- Typecheck — **PASS**, exit 0.\n- `git diff --check` — **PASS**.\n- Worker browser — **NOT RUN**, EPERM'
    const required = ['pnpm --filter @crewboard/core typecheck', 'git diff --check']
    expect(projectWorkerCheckClaims(report, '2026-09-28T10:00:00Z', required)).toEqual({ version: 1, source: 'finalAnswer', capturedAt: '2026-09-28T10:00:00Z', checks: [
      { command: required[0], state: 'run' }, { command: required[1], state: 'run' },
    ], workerBrowserClaim: { state: 'not_run', line: '- Worker browser — **NOT RUN**, EPERM', sourceLine: 2 } })
  })

  it('does not map an abbreviated Typecheck line to multiple required typecheck commands', () => {
    const report = '- Typecheck — **PASS**, exit 0.'
    const required = ['pnpm --filter @crewboard/core typecheck', 'pnpm --filter crewboard typecheck']
    expect(required.map((check) => checkState(report, check, required))).toEqual(['unreported', 'unreported'])
    expect(checkState('- pnpm --filter @crewboard/core typecheck — PASS', required[0]!, required)).toBe('run')
  })
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
    // vr2: the verbatim first lines of honest reports read as disputed on 2026-09-24/25, and their negated counterparts.
    ['a negation that describes the feature (dr2)', 'Результат: черновик теперь не может писать в рабочую копию, а воркер для него выбирается так же, как для запуска задачи.', 'result', undefined],
    ['dr2 negated: the draft is not ready', 'Результат: черновик теперь не готов, а воркер для него выбирается так же, как для запуска задачи.', 'disputed', 'claim_missing'],
    ['dr2 negated: the draft still writes to the copy', 'Результат: черновик всё ещё может писать в рабочую копию, но воркер не выбирается.', 'disputed', 'claim_missing'],
    ['a «Готово:» label (p5j)', 'Готово: tool host поддерживает протокол 1.1, …', 'result', undefined],
    ['p5j negated: «Готово:» over a failure', 'Готово: tool host не поддерживает протокол 1.1, …', 'disputed', 'claim_missing'],
    ['«Готово.» as a sentence of its own, then an outcome negation (ny1)', 'Готово. Архивный план больше не попадает ни в «Needs you», ни в какой счётчик, даже если он единственный и текущий в репозитории. Если открыть его на экране, задачи и их статусы видны как раньше. Все проверки прошли, кроме `pnpm test` целиком: в core он упал по таймаутам (подробности ниже).', 'result', undefined],
    ['ny1 negated: not done', 'Не готово. Архивный план всё ещё попадает в «Needs you».', 'disputed', 'claim_missing'],
    ['ny1 negated: «Готово.» over a caveat', 'Готово. Архивный план больше не попадает в счётчик, но всё ещё попадает в «Needs you».', 'disputed', 'claim_missing'],
    ['«Готово» without a colon or a full stop is a preface, not a label', 'Готово, ниже отчёт.', 'disputed', 'claim_missing'],
    ['RU «больше не падает»', 'Результат: сборка больше не падает на пустом плане', 'result', undefined],
    ['EN «no longer fails»', 'Result: the sync no longer fails on an empty plan', 'result', undefined],
    ['EN «never writes»', 'Result: the draft never writes to the working copy', 'result', undefined],
    ['RU «не готово» still denies', 'Результат: не готово', 'disputed', 'claim_missing'],
    ['RU «не удалось» still denies', 'Результат: не удалось собрать пакет', 'disputed', 'claim_missing'],
    ['EN «not done» still denies', 'Result: not done', 'disputed', 'claim_missing'],
    ['EN «tests do not pass» still denies', 'Result: the scaffold is done, tests do not pass', 'disputed', 'claim_missing'],
    ['an outcome negation that falls on the result', 'Result: the build no longer passes', 'disputed', 'claim_missing'],
    ['RU «больше не проходит» still denies', 'Результат: каркас готов, тесты больше не проходят', 'disputed', 'claim_missing'],
    ['a caveat after an outcome negation', 'Результат: сборка больше не падает, но линтер красный', 'disputed', 'claim_missing'],
    ['a hedge after «Готово:»', 'Готово: частично, остался экспорт', 'disputed', 'claim_missing'],
    ['a failure after «Done:»', 'Done: scaffold, but two tests failed', 'disputed', 'claim_missing'],
    ['a first-person done verb (mk1)', 'Результат: сделал все четыре пункта mk1. Все запрошенные проверки прошли: pnpm build, typecheck, lint, lint:i18n, test и release:check.', 'result', undefined],
    ['mk1 negated: «не сделал»', 'Результат: не сделал все четыре пункта mk1. Все запрошенные проверки прошли: pnpm build, typecheck, lint, lint:i18n, test и release:check.', 'disputed', 'claim_missing'],
    ['mk1 negated: «сделал не всё»', 'Результат: сделал не всё из четырёх пунктов mk1. Все запрошенные проверки прошли: pnpm build, typecheck, lint, lint:i18n, test и release:check.', 'disputed', 'claim_missing'],
    ['mk1 negated: «сделал частично»', 'Результат: сделал частично четыре пункта mk1. Все запрошенные проверки прошли: pnpm build, typecheck, lint, lint:i18n, test и release:check.', 'disputed', 'claim_missing'],
    ['RU «выполнила»', 'Результат: выполнила задачу целиком', 'result', undefined],
    ['RU «добавил»', 'Результат: добавил экспорт в CSV', 'result', undefined],
    ['EN «implemented»', 'Result: implemented the CSV export', 'result', undefined],
    ['EN «did»', 'Result: did all four items', 'result', undefined],
    ['EN «did not»', 'Result: did not finish the export', 'disputed', 'claim_missing'],
    ['EN «added» with a hedge', 'Result: added most of the export, partially', 'disputed', 'claim_missing'],
    ['DE «umgesetzt»', 'Ergebnis: Export nach CSV umgesetzt', 'result', undefined],
    ['FR «ajouté»', 'Résultat : export CSV ajouté', 'result', undefined],
    ['ES «implementé»', 'Resultado: implementé la exportación', 'result', undefined],
    ['PL «zrobiłem»', 'Wynik: zrobiłem eksport do CSV', 'result', undefined],
    ['PL «nie zrobiłem»', 'Wynik: nie zrobiłem eksportu', 'disputed', 'claim_missing'],
    ['«Сделано:»', 'Сделано: экспорт отчёта в CSV', 'result', undefined],
    ['«Done:»', 'Done: the export writes CSV', 'result', undefined],
    ['«Fertig:»', 'Fertig: Export nach CSV', 'result', undefined],
    ['«Terminé :»', 'Terminé : export CSV', 'result', undefined],
    ['«Hecho:»', 'Hecho: exportación a CSV', 'result', undefined],
    ['«Gotowe:»', '**Gotowe:** eksport do CSV', 'result', undefined],
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
