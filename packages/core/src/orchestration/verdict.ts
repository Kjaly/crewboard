import type { TaskDetail } from './detail.js'

export type VerdictKind = 'result' | 'negative' | 'disputed'
export type VerdictFact = { code: 'files_changed' | 'no_changes' | 'tests' | 'journal' | 'duration' | 'checks_run' | 'checks_not_run' | 'checks_unreported' | 'checks_unreadable'; count?: number; minutes?: number; text?: string; tone: 'ok' | 'flat' | 'warn'; sourceLine?: number }
export type VerdictCode = 'blocked' | 'negative' | 'run_failed' | 'no_files' | 'report_missing' | 'claim_missing'
export type Verdict = { kind: VerdictKind; claim?: 'result' | 'negative' | 'blocked'; why?: 'blocked' | 'negative'; facts: VerdictFact[]; mismatch?: Exclude<VerdictCode, 'blocked' | 'negative'> }
export const RISK_WORDS: readonly string[] = ['не удалось', 'заблокирован', 'отклонение', 'не проверено']

function claimOf(text: string | undefined): Verdict['claim'] {
  const first = text?.split(/\r?\n/, 1)[0]?.trim().toLocaleLowerCase('ru')
  const prefix = first?.startsWith('результат:') ? 'результат:' : first?.startsWith('result:') ? 'result:' : undefined
  if (!first || !prefix) return undefined
  const value = first.slice(prefix.length).trim()
  if (value === 'получен' || value === 'received') return 'result'
  if (value === 'отрицательный' || value === 'negative') return 'negative'
  if (value === 'заблокирован' || value === 'blocked') return 'blocked'
  return undefined
}

export function requiredChecks(contract: string): string[] {
  const block = contract.match(/<checks>([\s\S]*?)<\/checks>/i)?.[1]
  return (block ?? '').split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s*/, '')).filter(Boolean)
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
  const positive = /запустил|выполнил|прошл|passed|failed|\b\d+\s+(?:passed|tests?)\b|green|успеш|готово/i
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
  const claim = claimOf(detail.evidence?.claimLine ?? report)
  const facts: VerdictFact[] = []
  if (detail.changedFiles.length) facts.push({ code: 'files_changed', count: detail.changedFiles.length, tone: 'ok' })
  else if (detail.runs.length) facts.push({ code: 'no_changes', tone: 'flat' })
  const reportLines = report?.split(/\r?\n/) ?? []
  const testIndex = reportLines.findIndex((line) => /тест|провер|test|check/i.test(line))
  if (testIndex >= 0) {
    const testLine = reportLines[testIndex]!.trim()
    // At 11px, roughly 48 characters fill a chip in the narrow review panel.
    const failed = /fail|не прош/i.test(testLine) || (/ошиб/i.test(testLine) && !/без ошибок|0 ошибок/i.test(testLine))
    facts.push({ code: 'tests', ...(testLine.length <= 48 ? { text: testLine } : {}), tone: failed ? 'warn' : 'ok', sourceLine: testIndex })
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

  let mismatch: Verdict['mismatch']
  if (claim === 'result' && ['failed', 'cancelled'].includes(run?.outcome ?? '')) mismatch = 'run_failed'
  else if (claim === 'result' && detail.changedFiles.length === 0) mismatch = 'no_files'
  else if (detail.runs.length && !detail.report) mismatch = 'report_missing'
  else if (!claim) mismatch = 'claim_missing'
  if (mismatch) return { kind: 'disputed', ...(claim ? { claim } : {}), mismatch, facts }
  if (claim === 'negative' || claim === 'blocked') return { kind: 'negative', claim, why: claim, facts }
  return { kind: 'result', ...(claim ? { claim } : {}), facts }
}
