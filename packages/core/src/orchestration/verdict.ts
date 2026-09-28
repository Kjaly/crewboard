import type { TaskDetail } from './detail.js'
import { ownWorkUnchecked } from '../plan/graph.js'
import type { CheckState, Task } from '../plan/schema.js'
import type { CrewboardCheck } from '../runs/checks-run.js'
import type { RunEvidence } from '../runs/evidence.js'

export type VerdictKind = 'result' | 'negative' | 'disputed'
/**
 * `deviation` — the worker declares a deviation from the contract (`text` — its line); `outside_paths` — changed
 * files outside the paths the contract's `<paths>` block names (`files` — the first of them, `count` — all).
 * `crewboard_checks` (ck1) — the contract's checks Crewboard ran itself: `count` passed of `total`, `commands` — the
 * failed ones; `checks_mismatch` — the worker claims a result, Crewboard saw these `commands` fail (tone `bad`).
 */
export type VerdictFact = { code: 'files_changed' | 'uncommitted' | 'no_changes' | 'tests' | 'journal' | 'duration' | 'checks_run' | 'checks_not_run' | 'checks_unreported' | 'checks_unreadable' | 'deviation' | 'outside_paths' | 'crewboard_checks' | 'checks_mismatch'; count?: number; total?: number; minutes?: number; text?: string; files?: string[]; commands?: string[]; tone: 'ok' | 'flat' | 'warn' | 'bad'; sourceLine?: number }
export type VerdictCode = 'blocked' | 'negative' | 'run_failed' | 'no_files' | 'report_missing' | 'claim_missing'
/**
 * `caution` (vc1, B27): a received result the worker itself qualifies — it declares a deviation from the contract.
 * The result stands, but it is not shown as a clean green one and a batch does not pre-select it.
 */
export type Verdict = { kind: VerdictKind; claim?: 'result' | 'negative' | 'blocked'; why?: 'blocked' | 'negative'; facts: VerdictFact[]; mismatch?: Exclude<VerdictCode, 'blocked' | 'negative'>; caution?: 'deviation' }

/** A structured orchestrator judgement is authoritative; proof prose contributes declared deviations only. */
export function attestedVerdict(kind: VerdictKind, report: string): Verdict {
  const deviation = declaredDeviation(report)
  const facts: VerdictFact[] = deviation ? [{ code: 'deviation', text: deviation.line.length <= 120 ? deviation.line : `${deviation.line.slice(0, 119)}…`, tone: 'warn', sourceLine: deviation.index }] : []
  return {
    kind,
    ...(kind === 'result' ? { claim: 'result' as const, ...(deviation ? { caution: 'deviation' as const } : {}) } : kind === 'negative' ? { claim: 'negative' as const, why: 'negative' as const } : {}),
    facts,
  }
}
/** A check Crewboard ran (ck1) passed: exit code 0 and no timeout. */
export const checkPassed = (check: Pick<CrewboardCheck, 'exitCode' | 'timedOut'>): boolean => check.exitCode === 0 && !check.timedOut
export const RISK_WORDS: readonly string[] = ['не удалось', 'заблокирован', 'отклонение', 'не проверено']

/** How many lines from the top of an answer may carry the claim: a short preface or a heading may come first. */
const CLAIM_LINES = 5
const CLAIM_REPORT_HEADING = /^#{1,6}\s*(?:отчёт|отчет|итог|report)\s*:?\s*#*$/i

/** A line without its markdown dressing: quote, list or checkbox marker, bold and inline code. */
export function plainLine(line: string): string {
  return line.trim().replace(/^>\s*/, '').replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '').replace(/\*\*|__|`/g, '').trim()
}

/** «Result:» in the languages workers answer in: RU/UK, EN, DE, FR, ES/PT, IT, PL. */
const CLAIM_LABEL = /^(?:результат|result|ergebnis|résultat|resultat|resultado|risultato|wynik)\s*:\s*(.*)$/u
/**
 * «Done:» in the same languages (p5j): the label itself states the work is finished, the value says what was done.
 * The word as a sentence of its own, «Готово. Архивный план …» (ny1), is the same label.
 */
const DONE_LABEL = /^(?:готово|сделано|выполнено|зроблено|виконано|done|finished|completed|fertig|erledigt|terminé|fait|hecho|listo|terminado|feito|pronto|concluído|fatto|completato|gotowe|zrobione)\s*(?::|[.!](?=\s|$))\s*(.*)$/u
/**
 * Whole words that state the work is finished; a stem alone would also match «готовлю» (in progress).
 * First-person done verbs count too (mk1): «сделал все четыре пункта», «implemented the export», «zrobiłem eksport».
 */
const POSITIVE_WORD = /(?<!\p{L})(?:(?:сделал|выполнил|реализовал|добавил|завершил|закончил)[аи]?|зроби(?:в|ла|ли)|викона(?:в|ла|ли)|реалізува(?:в|ла|ли)|дода(?:в|ла|ли)|did|added|gemacht|umgesetzt|implementiert|hinzugefügt|implémentée?s?|ajoutée?s?|faite?s?|hice|implementé|añadí|agregué|completé|terminé|fiz|implementei|adicionei|concluí|terminei|fatt[oaie]|implementat[oaie]|aggiunt[oaie]|finit[oaie]|(?:zrobi|wykona|zaimplementowa|doda|ukończy|zakończy)ł(?:em|am)|получен[аоы]?|готов[аоы]?|выполнен[аоы]?|сделан[аоы]?|заверш[её]н[аоы]?|закончен[аоы]?|реализован[аоы]?|зел[её]н(?:ый|ая|ое|ые)?|успешно|отримано|виконано|зроблено|received|done|ready|completed?|finished|implemented|succeeded|successful(?:ly)?|passed|green|fertig|erledigt|abgeschlossen|erfolgreich|grün|terminée?s?|réussie?s?|prête?s?|completad[oa]s?|terminad[oa]s?|list[oa]s?|hech[oa]s?|conclu[íi]d[oa]s?|completat[oa]|pront[oa])(?!\p{L})/u
/** A negation, a hedge or a failure anywhere in the claim sentence makes it no claim of a result. */
const CAVEAT_WORD = /(?<!\p{L})(?:не|нет|ни|ні|частично|почти|кроме|но|однако|упал\p{L}*|пада\p{L}*|заблокир\p{L}*|not|no|never|partial(?:ly)?|partly|almost|mostly|except|but|however|fail\p{L}*|blocked|nicht|kein\p{L}*|teilweise|aber|pas|mais|sauf|non|pero|excepto|nie)(?!\p{L})|n't/u
/**
 * A negation that belongs to the outcome (vr2): the work changed what the product does — «черновик теперь не может
 * писать», «больше не падает», «no longer fails», «never writes». The marker, the negation and the word it falls on
 * describe a result and state one; the next two words are read too, but keep their own caveats («больше не падает, но …»).
 */
const OUTCOME_NEGATION = /(?<!\p{L})(?:(?:теперь|больше|уже|тепер|більше|вже|ya|já|już)\s+(?:не|ні|no|não|nie)|никогда\s+не|ніколи\s+не|no\s+longer|never|nicht\s+mehr|niemals|nie\s+mehr|jamais|nunca|nigdy|non\s+più|mai\s+più)(\s+\p{L}+)((?:\s+\p{L}+){0,2})/gu
/**
 * Inside such a span the negation still denies the result when it falls on a positive word or on an outcome of the
 * work itself: «теперь не готово», «больше не проходит», «no longer works», «never passed».
 */
const RESULT_WORD = /(?<!\p{L})(?:pass\p{L}*|work\p{L}*|succeed\p{L}*|build\p{L}*|compil\p{L}*|проход\p{L}*|пройд\p{L}*|прош\p{L}*|работа\p{L}*|удал\p{L}*|удаё\p{L}*|собира\p{L}*|собра\p{L}*|компил\p{L}*|працю\p{L}*|funktion\p{L}*|läuft|besteh\p{L}*|marche\p{L}*|fonctionn\p{L}*|funciona\p{L}*|pasa\p{L}*|passa\p{L}*|działa\p{L}*|przechodz\p{L}*)(?!\p{L})/u
/**
 * A free-text value after the label (f0a): «Result: каркас готов, все проверки зелёные. Не запушено.» The first
 * sentence is the claim; it counts as a result only with a positive word and no caveat. Later sentences may
 * carry notes («не запушено») without undoing the claim. A negation that belongs to the outcome (vr2, dr2) is no
 * caveat and itself states the result. After a «Done:» label the label is
 * the positive word, so the value only has to carry no caveat.
 */
function freeTextClaim(value: string, labelled: 'result' | 'done'): Verdict['claim'] {
  const sentence = value.split(/[.!?;…](?:\s|$)/u, 1)[0] ?? ''
  let outcome = false
  const rest = sentence.replace(OUTCOME_NEGATION, (span, _negated: string, after: string) => {
    if (POSITIVE_WORD.test(span) || RESULT_WORD.test(span)) return span
    outcome = true
    return ` ${after}`
  })
  // «больше не попадает ни в «Needs you», ни в счётчик» (ny1): «ни» continues the outcome's own negation.
  if (CAVEAT_WORD.test(outcome ? rest.replace(/(?<!\p{L})(?:ни|ні)(?!\p{L})/gu, ' ') : rest)) return undefined
  return labelled === 'done' || outcome || POSITIVE_WORD.test(rest) ? 'result' : undefined
}

function claimOfLine(line: string): Verdict['claim'] {
  const plain = plainLine(line).toLocaleLowerCase('ru')
  const done = plain.match(DONE_LABEL)?.[1]
  if (done !== undefined) return freeTextClaim(done, 'done')
  const rest = plain.match(CLAIM_LABEL)?.[1]
  if (rest === undefined) return undefined
  const value = rest.match(/^[\p{L}]+/u)?.[0]
  if (value === 'получен' || value === 'received') return 'result'
  if (value === 'отрицательный' || value === 'negative') return 'negative'
  if (value === 'заблокирован' || value === 'blocked') return 'blocked'
  return freeTextClaim(rest, 'result')
}

/**
 * The line that carries the result claim (w1b, B04): among the first lines of the answer, or the first line of a
 * «Отчёт» / «Итог» / «Report» section — the orchestrator's prompt asks for both, so either place counts.
 * A claim quoted mid-sentence or buried in prose is not one.
 */
export function claimLineOf(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\r?\n/)
  const top = lines.filter((line) => line.trim()).slice(0, CLAIM_LINES)
  const afterHeading = lines.flatMap((line, i) => CLAIM_REPORT_HEADING.test(line.trim()) ? lines.slice(i + 1).filter((next) => next.trim()).slice(0, 1) : [])
  return [...top, ...afterHeading].find((line) => claimOfLine(line))?.trim()
}

export function claimOf(text: string | undefined): Verdict['claim'] {
  const line = claimLineOf(text)
  return line ? claimOfLine(line) : undefined
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
/**
 * The lines of a contract's `<tag>` block (ck1): the block opens at a line that is exactly `<tag>` and closes at a line
 * that is exactly `</tag>` (surrounding whitespace allowed). A tag mentioned inline, in a code span or inside fenced code
 * is prose, not a block; an unclosed block is none. With several blocks the last one counts — the template puts the
 * real block in its own section after the prose, so earlier ones are examples. `requiredChecks`, `contractPaths`, the
 * contract warnings, the verdict and `verify --run-checks` all read blocks through here, so they agree.
 */
export function contractBlock(contract: string, tag: string): string[] | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  let fence: string | undefined
  let current: string[] | undefined
  let last: string[] | undefined
  for (const line of contract.split(/\r?\n/)) {
    const marker = line.match(FENCE)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined
      continue
    }
    if (marker) {
      fence = marker
      current = undefined
      continue
    }
    const bare = line.trim().toLowerCase()
    if (current) {
      if (bare === close) {
        last = current
        current = undefined
      } else if (bare === open) current = []
      else current.push(line)
    } else if (bare === open) current = []
  }
  return last
}

export function requiredChecks(contract: string): string[] {
  return (contractBlock(contract, 'checks') ?? []).map((line) => line.trim().replace(/^(?:[-*+•]|\d+[.)])\s*/, '')).filter(Boolean)
}

/** The paths a contract names in its `<paths>` block, one per line: a directory, a file or a glob with `*`. */
export function contractPaths(contract: string): string[] {
  return (contractBlock(contract, 'paths') ?? []).map((line) => line.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, '').replace(/`/g, '').replace(/^\.\//, '').trim()).filter(Boolean)
}

/** `src/api` covers everything under it; `*` matches within one path segment, `**` across segments. */
function pathCovers(pattern: string, file: string): boolean {
  if (!pattern.includes('*')) {
    const base = pattern.replace(/\/+$/, '')
    return file === base || file.startsWith(`${base}/`)
  }
  // `**` spans segments, `*` stays within one; everything else is literal.
  const source = pattern.split('**').map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*').replace(/\.\*\//g, '(?:.*/)?')
  return new RegExp(`^${source}(?:/.*)?$`).test(file)
}

/** Changed files none of the contract's paths cover; with no `<paths>` block nothing is outside. */
export function filesOutside(paths: readonly string[], files: readonly string[]): string[] {
  if (!paths.length) return []
  return files.filter((file) => !paths.some((pattern) => pathCovers(pattern, file)))
}

const DEVIATION_WORD = /(?<!\p{L})(?:deviat\p{L}*|отклонени\p{L}*|отклонил\p{L}*|отступ(?:ил|лени)\p{L}*)/u
const JOURNAL_WORDS = /журнал\p{L}*\s+отклонений|deviations?\s+(?:journal|log)/u
/** «No deviations», «Отклонения: нет», «Deviations — none»: the section says there is nothing to report. */
const NO_DEVIATION = /^(?:нет|none|no|n\/a|—|-|отсутствуют|не было|без отклонений)(?!\p{L})|(?<!\p{L})(?:нет|none)[.!]?$|(?<!\p{L})(?:нет|без|no|none|not|never|не было|отсутствуют)\s+(?:\p{L}+\s+)?(?:deviat|отклон|отступ)|(?:deviat|отклон)\p{L}*\s+(?:нет|none|отсутствуют|не было)(?!\p{L})/u

/**
 * The line where the worker declares a deviation from the contract (vc1, B27), or undefined: a line or a section
 * heading that names a deviation and does not say there was none. The deviations journal's own mention and file
 * paths are not a declaration — a journal may well list nothing.
 */
export function declaredDeviation(text: string | undefined): { line: string; index: number } | undefined {
  const lines = (text ?? '').split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    const raw = line.trim()
    // Paths such as `docs/tmp/…_deviations.md` name a file, not a deviation.
    const plain = plainLine(raw).toLocaleLowerCase('ru').replace(/\S*[/\\]\S*|\S+\.(?:md|txt|json)\b/g, ' ').trim()
    if (!DEVIATION_WORD.test(plain) || JOURNAL_WORDS.test(plain) || NO_DEVIATION.test(plain)) continue
    const heading = /^#{1,6}\s/.test(raw) || /:\s*$/.test(plain)
    const value = heading ? lines.slice(i + 1).map((line) => plainLine(line)).find(Boolean) : plain.split(/:\s*/).slice(1).join(': ').trim()
    if (heading && !value) continue
    if (value && NO_DEVIATION.test(value.toLocaleLowerCase('ru'))) continue
    return { line: heading ? `${plainLine(raw).replace(/^#+\s*/, '').replace(/:\s*$/, '')}: ${value}` : plainLine(raw), index: i }
  }
  return undefined
}

export function checkState(report: string, check: string, required: readonly string[] = [check]): 'run' | 'not_run' | 'unreported' {
  // Compare command identities (package/script/task), ignoring shell filters, result suffixes and formatting.
  // A command string alone is not evidence it ran: require a nearby execution/result verb or outcome.
  const command = check.match(/(?:pnpm|npm|yarn|bun)\s+(?:--filter\s+\S+\s+)?(?:run\s+)?([\w:.-]+)/i)?.[1]
  const scriptOf = (value: string) => value.match(/(?:pnpm|npm|yarn|bun)\s+(?:--filter\s+\S+\s+)?(?:run\s+)?([\w:.-]+)/i)?.[1]?.toLocaleLowerCase()
  const scriptCount = command ? required.filter((item) => scriptOf(item) === command.toLocaleLowerCase()).length : 0
  const typecheckAlias = /^\s*(?:[-*+•]\s*)?typecheck\s*[—:-]/i.test(check)
  const terms = (check.replace(/→.*$/, '').match(/[\p{L}\p{N}_:.@/-]+/gu) ?? []).filter((x) => x.length > 2)
  const identity = command ? undefined : terms.slice(0, Math.min(3, terms.length))
  const lines = report.split(/\r?\n/)
  const mentions = lines.map((line, i) => ({ line, i })).filter(({ line }) => typecheckAlias
    ? scriptCount === 1 && /^\s*(?:[-*+•]\s*)?typecheck\s*[—:-]/i.test(line)
    : command
      ? scriptCount <= 1 ? new RegExp(`\\b${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(line)
        : (() => {
          const filter = check.match(/--filter\s+(\S+)/i)?.[1]
          return !!filter && line.includes(filter) && new RegExp(`\\b${command}\\b`, 'i').test(line)
        })()
    : !!identity?.length && identity.every((term) => line.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
  if (!mentions.length) return 'unreported'
  const negative = /не\s+(?:запускал|выполнял|проводил)|not\s+(?:run|executed)|skipped/i
  // RU forms (ux7 F-04, ux3 R-09): «прошёл», «зелёный», «пройдены», «упал», «N тестов»; ok and a tick mark.
  const positive = /запустил|выполнил|прошл|прош[её]л|пройден|упал|зел[её]н|pass(?:ed)?|failed|\b\d+\s+(?:passed|tests?)\b|\d+\s+тест|green|успеш|готово|\bok\b|[✓✔]/i
  for (const { line, i } of mentions) {
    if (negative.test(line)) return 'not_run'
    if (positive.test(line)) return 'run'
    const context = [lines[i - 1] ?? '', lines[i + 1] ?? ''].join(' ')
    if (negative.test(context)) return 'not_run'
    if (positive.test(context)) return 'run'
  }
  return 'unreported'
}

export type WorkerClaimProjection = {
  version: 1
  source: 'finalAnswer'
  capturedAt: string
  checks: Array<{ command: string; state: 'run' | 'not_run' | 'unreported' }>
  /** A clearly labelled, non-contract worker browser claim; it never becomes a gate or receipt. */
  workerBrowserClaim?: { state: 'not_run'; line: string; sourceLine: number }
}
/** Re-extract worker prose without modifying its immutable evidence snapshot or treating claims as receipts. */
export function projectWorkerCheckClaims(finalAnswer: string | undefined, capturedAt: string, required: readonly string[]): WorkerClaimProjection {
  const answer = finalAnswer ?? ''
  const workerBrowserClaim = answer.split(/\r?\n/).flatMap((line, sourceLine) =>
    /^\s*(?:[-*+•]|\d+[.)])?\s*worker\s+browser\s*[—:-].*\bnot\s+run\b/i.test(line) ? [{ state: 'not_run' as const, line: line.trim(), sourceLine }] : [],
  )[0]
  return { version: 1, source: 'finalAnswer', capturedAt, checks: required.map((command) => ({ command, state: checkState(answer, command, required) })), ...(workerBrowserClaim ? { workerBrowserClaim } : {}) }
}

/**
 * The checks Crewboard saw fail that the worker did not declare unrun (ck1): with a claimed result, a mismatch — the
 * worker says the work passed, Crewboard saw otherwise.
 */
export function failedAsClaimed(evidence: Pick<RunEvidence, 'checks' | 'crewboardChecks'> | undefined): string[] {
  return (evidence?.crewboardChecks?.checks ?? []).filter((check) => !checkPassed(check) && evidence?.checks.find((item) => item.command === check.command)?.state !== 'not_run').map((check) => check.command)
}

export function verdictOf(detail: Omit<TaskDetail, 'verdict'> | TaskDetail): Verdict {
  const report = detail.report?.text
  // Evidence written before w1b keeps only the answer's first line as `claimLine`; the full answer is read first.
  const handoff = detail.runs.at(-1)?.outcome === 'incomplete' && detail.check?.state === 'checked' && !!detail.check.report && !!detail.check.commit && detail.report?.source === 'orchestrator'
  const claim = handoff ? claimOf(report) : claimOf(detail.evidence?.finalAnswer) ?? claimOf(detail.evidence?.claimLine) ?? claimOf(report)
  const facts: VerdictFact[] = []
  if (detail.changedFiles.length) facts.push({ code: 'files_changed', count: detail.changedFiles.length, tone: 'ok' })
  else if (detail.runs.length) facts.push({ code: 'no_changes', tone: 'flat' })
  // Changes no commit carries stay behind in the copy: accepted as is, they would never reach the base branch (w1d).
  if (detail.uncommitted) facts.push({ code: 'uncommitted', count: detail.uncommitted, tone: 'warn' })
  const reportLines = report?.split(/\r?\n/) ?? []
  const testIndex = reportLines.findIndex((line) => /тест|провер|test|check/i.test(line))
  if (testIndex >= 0) {
    const raw = reportLines[testIndex]!.trim()
    // A section title (`## Checks`) says where the checks are, not what they found: the chip keeps its
    // generic name. A plain line is shown without its markdown marks.
    const heading = /^#{1,6}\s/.test(raw)
    const testLine = plainLine(raw)
    // At 11px, roughly 48 characters fill a chip in the narrow review panel.
    const failed = /fail|не прош|упал/i.test(testLine) || (/ошиб/i.test(testLine) && !/без ошибок|0 ошибок/i.test(testLine))
    facts.push({ code: 'tests', ...(!heading && testLine.length <= 48 ? { text: testLine } : {}), tone: failed ? 'warn' : 'ok', sourceLine: testIndex })
  }
  if (report && /журнал отклонений|deviations journal/i.test(report)) facts.push({ code: 'journal', tone: 'flat' })
  // A deviation the worker declares is a fact to read before Accept, not part of a green result (vc1, B27).
  const deviation = report ? declaredDeviation(report) : declaredDeviation(detail.evidence?.finalAnswer)
  if (deviation) facts.push({ code: 'deviation', text: deviation.line.length <= 120 ? deviation.line : `${deviation.line.slice(0, 119)}…`, tone: 'warn', ...(report ? { sourceLine: deviation.index } : {}) })
  const paths = detail.evidence?.paths ?? (detail.contract ? contractPaths(detail.contract.text) : [])
  const outside = filesOutside(paths, detail.changedFiles)
  if (outside.length) facts.push({ code: 'outside_paths', count: outside.length, files: outside.slice(0, 5), tone: 'warn' })
  const run = detail.runs.at(-1)
  if (run?.startedAt && run.finishedAt) {
    const duration = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
    if (Number.isFinite(duration)) facts.push({ code: 'duration', minutes: Math.round(duration / 60000), tone: 'flat' })
  }
  // A recognized handoff (an incomplete last run with an orchestrator report for its checked commit) makes that
  // report the current check claim. The worker's own `not_run` lines stay in the immutable evidence and the
  // read-time projection as history, but they are no longer shown as the current root's unrun checks; the contract's
  // commands are read against the orchestrator's report. Without the handoff the worker's claim stays current, so an
  // ordinary completed run is untouched.
  const checkCommands = detail.contract ? requiredChecks(detail.contract.text) : detail.workerClaimProjection?.checks.map((check) => check.command) ?? detail.evidence?.checks.map((check) => check.command) ?? []
  const states = handoff
    ? checkCommands.map((check) => checkState(report ?? '', check, checkCommands))
    : detail.workerClaimProjection?.checks.map((check) => check.state) ?? detail.evidence?.checks.map((check) => check.state) ?? checkCommands.map((check) => checkState(report ?? '', check))
  if (states.includes('run')) facts.push({ code: 'checks_run', count: states.filter((state) => state === 'run').length, tone: 'ok' })
  if (states.includes('not_run')) facts.push({ code: 'checks_not_run', count: states.filter((state) => state === 'not_run').length, tone: 'warn' })
  if (states.includes('unreported')) facts.push({ code: 'checks_unreported', count: states.filter((state) => state === 'unreported').length, tone: 'flat' })
  if (states.includes('unreadable')) facts.push({ code: 'checks_unreadable', count: states.filter((state) => state === 'unreadable').length, tone: 'warn' })
  // What Crewboard saw when it ran the checks itself (ck1) stands beside the worker's claim; the verdict is not rewritten.
  const ran = detail.evidence?.crewboardChecks
  if (ran?.checks.length) {
    const failed = ran.checks.filter((check) => !checkPassed(check))
    facts.push({ code: 'crewboard_checks', count: ran.checks.length - failed.length, total: ran.checks.length, ...(failed.length ? { commands: failed.map((check) => check.command) } : {}), tone: failed.length ? 'warn' : 'ok' })
    const mismatched = claim === 'result' ? failedAsClaimed(detail.evidence) : []
    if (mismatched.length) facts.push({ code: 'checks_mismatch', count: mismatched.length, commands: mismatched, tone: 'bad' })
  }

  // Nothing reported on work no worker runs — a decision still being prepared, a root task not finished
  // (rt1): there is no claim to dispute yet.
  const ownWork = detail.kind === 'decision' || detail.kind === 'root'
  if (ownWork && !detail.runs.length && !detail.report) return { kind: 'result', facts }
  let mismatch: Verdict['mismatch']
  if (claim === 'result' && ['failed', 'cancelled'].includes(run?.outcome ?? '')) mismatch = 'run_failed'
  // Files are measured in a worker's copy; the orchestrator's own work (no runs) has none to count.
  else if (claim === 'result' && detail.changedFiles.length === 0 && !(ownWork && !detail.runs.length)) mismatch = 'no_files'
  else if (detail.runs.length && !detail.report) mismatch = 'report_missing'
  else if (!claim) mismatch = 'claim_missing'
  if (mismatch) return { kind: 'disputed', ...(claim ? { claim } : {}), mismatch, facts }
  if (claim === 'negative' || claim === 'blocked') return { kind: 'negative', claim, why: claim, facts }
  return { kind: 'result', ...(claim ? { claim } : {}), ...(deviation ? { caution: 'deviation' as const } : {}), facts }
}

/**
 * w1b (B03): what a batch may accept without opening each item — a received result; a prepared decision is
 * also clean, though dc1 keeps decisions out of batches entirely (they are confirmed one by one). Negative,
 * disputed, unknown and unchecked work is at risk: the batch never pre-selects it and the confirmation counts it.
 */
export function cleanToAccept(task: { kind: Task['kind']; check?: CheckState }, verdict: Pick<Verdict, 'kind' | 'caution'> | null | undefined): boolean {
  if (ownWorkUnchecked(task.kind, task.check)) return false
  return task.kind === 'decision' || (verdict?.kind === 'result' && !verdict.caution)
}
