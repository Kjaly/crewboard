import type { TaskDetail } from './detail.js'
import { ownWorkUnchecked } from '../plan/graph.js'
import type { CheckState, Task } from '../plan/schema.js'

export type VerdictKind = 'result' | 'negative' | 'disputed'
export type VerdictFact = { code: 'files_changed' | 'uncommitted' | 'no_changes' | 'tests' | 'journal' | 'duration' | 'checks_run' | 'checks_not_run' | 'checks_unreported' | 'checks_unreadable'; count?: number; minutes?: number; text?: string; tone: 'ok' | 'flat' | 'warn'; sourceLine?: number }
export type VerdictCode = 'blocked' | 'negative' | 'run_failed' | 'no_files' | 'report_missing' | 'claim_missing'
export type Verdict = { kind: VerdictKind; claim?: 'result' | 'negative' | 'blocked'; why?: 'blocked' | 'negative'; facts: VerdictFact[]; mismatch?: Exclude<VerdictCode, 'blocked' | 'negative'> }
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
/** Whole words that state the work is finished; a stem alone would also match «готовлю» (in progress). */
const POSITIVE_WORD = /(?<!\p{L})(?:получен[аоы]?|готов[аоы]?|выполнен[аоы]?|сделан[аоы]?|заверш[её]н[аоы]?|закончен[аоы]?|реализован[аоы]?|зел[её]н(?:ый|ая|ое|ые)?|успешно|отримано|виконано|зроблено|received|done|ready|completed?|finished|implemented|succeeded|successful(?:ly)?|passed|green|fertig|erledigt|abgeschlossen|erfolgreich|grün|terminée?s?|réussie?s?|prête?s?|completad[oa]s?|terminad[oa]s?|list[oa]s?|hech[oa]s?|conclu[íi]d[oa]s?|completat[oa]|pront[oa])(?!\p{L})/u
/** A negation, a hedge or a failure anywhere in the claim sentence makes it no claim of a result. */
const CAVEAT_WORD = /(?<!\p{L})(?:не|нет|ни|ні|частично|почти|кроме|но|однако|упал\p{L}*|заблокир\p{L}*|not|no|never|partial(?:ly)?|partly|almost|mostly|except|but|however|fail\p{L}*|blocked|nicht|kein\p{L}*|teilweise|aber|pas|mais|sauf|non|pero|excepto|nie)(?!\p{L})|n't/u

/**
 * A free-text value after the label (f0a): «Result: каркас готов, все проверки зелёные. Не запушено.» The first
 * sentence is the claim; it counts as a result only with a positive word and no caveat. Later sentences may
 * carry notes («не запушено») without undoing the claim.
 */
function freeTextClaim(value: string): Verdict['claim'] {
  const sentence = value.split(/[.!?;…](?:\s|$)/u, 1)[0] ?? ''
  return POSITIVE_WORD.test(sentence) && !CAVEAT_WORD.test(sentence) ? 'result' : undefined
}

function claimOfLine(line: string): Verdict['claim'] {
  const plain = plainLine(line).toLocaleLowerCase('ru')
  const rest = plain.match(CLAIM_LABEL)?.[1]
  if (rest === undefined) return undefined
  const value = rest.match(/^[\p{L}]+/u)?.[0]
  if (value === 'получен' || value === 'received') return 'result'
  if (value === 'отрицательный' || value === 'negative') return 'negative'
  if (value === 'заблокирован' || value === 'blocked') return 'blocked'
  return freeTextClaim(rest)
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

export function requiredChecks(contract: string): string[] {
  const block = contract.match(/<checks>([\s\S]*?)<\/checks>/i)?.[1]
  return (block ?? '').split(/\r?\n/).map((line) => line.trim().replace(/^(?:[-*+•]|\d+[.)])\s*/, '')).filter(Boolean)
}

export function checkState(report: string, check: string): 'run' | 'not_run' | 'unreported' {
  // Compare command identities (package/script/task), ignoring shell filters, result suffixes and formatting.
  // A command string alone is not evidence it ran: require a nearby execution/result verb or outcome.
  const command = check.match(/(?:pnpm|npm|yarn|bun)\s+(?:--filter\s+\S+\s+)?(?:run\s+)?([\w:.-]+)/i)?.[1]
  const terms = (check.replace(/→.*$/, '').match(/[\p{L}\p{N}_:.@/-]+/gu) ?? []).filter((x) => x.length > 2)
  const lines = report.split(/\r?\n/)
  const mentions = lines.map((line, i) => ({ line, i })).filter(({ line }) => command
    ? new RegExp(`\\b${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(line)
    : terms.length > 0 && terms.some((term) => line.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
  if (!mentions.length) return 'unreported'
  const negative = /не\s+(?:запускал|выполнял|проводил)|not\s+(?:run|executed)|skipped/i
  // RU forms (ux7 F-04, ux3 R-09): «прошёл», «зелёный», «пройдены», «упал», «N тестов»; ok and a tick mark.
  const positive = /запустил|выполнил|прошл|прош[её]л|пройден|упал|зел[её]н|passed|failed|\b\d+\s+(?:passed|tests?)\b|\d+\s+тест|green|успеш|готово|\bok\b|[✓✔]/i
  for (const { line, i } of mentions) {
    if (negative.test(line)) return 'not_run'
    if (positive.test(line)) return 'run'
    const context = [lines[i - 1] ?? '', lines[i + 1] ?? ''].join(' ')
    if (negative.test(context)) return 'not_run'
    if (positive.test(context)) return 'run'
  }
  return 'unreported'
}

export function verdictOf(detail: Omit<TaskDetail, 'verdict'> | TaskDetail): Verdict {
  const report = detail.report?.text
  // Evidence written before w1b keeps only the answer's first line as `claimLine`; the full answer is read first.
  const claim = claimOf(detail.evidence?.finalAnswer) ?? claimOf(detail.evidence?.claimLine) ?? claimOf(report)
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
  const run = detail.runs.at(-1)
  if (run?.startedAt && run.finishedAt) {
    const duration = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
    if (Number.isFinite(duration)) facts.push({ code: 'duration', minutes: Math.round(duration / 60000), tone: 'flat' })
  }
  const states = detail.evidence?.checks.map((check) => check.state) ?? (detail.contract ? requiredChecks(detail.contract.text).map((check) => checkState(report ?? '', check)) : [])
  if (states.includes('run')) facts.push({ code: 'checks_run', count: states.filter((state) => state === 'run').length, tone: 'ok' })
  if (states.includes('not_run')) facts.push({ code: 'checks_not_run', count: states.filter((state) => state === 'not_run').length, tone: 'warn' })
  if (states.includes('unreported')) facts.push({ code: 'checks_unreported', count: states.filter((state) => state === 'unreported').length, tone: 'flat' })
  if (states.includes('unreadable')) facts.push({ code: 'checks_unreadable', count: states.filter((state) => state === 'unreadable').length, tone: 'warn' })

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
  return { kind: 'result', ...(claim ? { claim } : {}), facts }
}

/**
 * w1b (B03): what a batch may accept without opening each item — a received result, or a decision the
 * orchestrator prepared (a decision has no verdict). Negative, disputed, unknown and unchecked work is at risk:
 * the batch never pre-selects it and the confirmation counts it.
 */
export function cleanToAccept(task: { kind: Task['kind']; check?: CheckState }, verdict: Pick<Verdict, 'kind'> | null | undefined): boolean {
  if (ownWorkUnchecked(task.kind, task.check)) return false
  return task.kind === 'decision' || verdict?.kind === 'result'
}
