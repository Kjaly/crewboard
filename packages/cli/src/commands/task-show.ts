import { parseArgs } from 'node:util'
import { type Exec, type TaskShow, checkPassed, getTaskShow, listPaths, orchText } from '@crewboard/core'
import { makeBackends, repoRoot } from '../context.js'
import { cliT, type Lang } from '../i18n.js'
import { type Io, UserError } from '../io.js'
import { conflictLine } from './merge.js'
import { noteUnsaved, syncPlan } from './runs.js'

const MAX_FILES = 10
const MAX_NOTES = 8
const REPORT_LINES = 6
const NOTE_CHARS = 160

const firstLines = (text: string, count: number) => text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()).slice(0, count)
const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > NOTE_CHARS ? `${line.slice(0, NOTE_CHARS - 1)}…` : line
}
const when = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, 'Z')

/**
 * `task show <id> [--plan id] [--json]` (ts1, B26): everything about one task — the task panel's detail plus the
 * diffstat, the merge state with conflicts, the last run and the contract's checks (core `getTaskShow`). `--json`
 * prints the whole structure, the same the orchestrator's `orchestra_task` returns; the text is short and sectioned.
 */
export async function cmdTaskShow(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, plan: { type: 'string' } } })
  const [id] = positionals
  if (!id || positionals.length > 1) throw new UserError(cliT(lang, 'show.usage'), 2)
  const root = await repoRoot(io, exec)
  const backends = makeBackends(io, exec, root)
  // Finished runs and merges done by hand are recorded first, as `status` does, so the answer is today's.
  const { unsaved } = await syncPlan(root, io, backends, values.plan)
  noteUnsaved(io, unsaved)
  const show = await getTaskShow(root, id, backends, exec, values.plan)
  io.out(values.json ? `${JSON.stringify(show, null, 2)}\n` : renderShow(lang, show))
  return 0
}

export function renderShow(lang: Lang, s: TaskShow): string {
  const t = (key: string, vars: Record<string, string | number> = {}) => cliT(lang, key, vars)
  const out: string[] = []
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push('', title, ...lines.map((line) => `  ${line}`))
  }

  out.push(`${s.id} · ${s.title}`)
  out.push(`  ${[t('show.kind', { kind: s.kind }), s.class ? t('show.class', { class: s.class }) : undefined, t('show.status', { status: s.status }), s.worker ? t('show.worker', { worker: s.worker }) : t('show.noWorker'), s.lane ? t('show.lane', { lane: s.lane }) : undefined].filter(Boolean).join(' · ')}`)
  // What waits for a merge is named apart from work not done yet (w1d), as `status` does.
  const waitingWork = (s.blockedBy ?? []).filter((dep) => !s.waitingMerge?.includes(dep))
  const links = [
    s.deps.length ? t('show.deps', { ids: s.deps.join(', ') }) : undefined,
    s.dependents.length ? t('show.dependents', { ids: s.dependents.join(', ') }) : undefined,
    waitingWork.length ? t('show.blockedBy', { ids: waitingWork.join(', ') }) : undefined,
    s.waitingMerge?.length ? t('plan.waitingMerge', { ids: s.waitingMerge.join(', ') }) : undefined,
  ].filter(Boolean)
  if (links.length) out.push(`  ${links.join(' · ')}`)

  const copy: string[] = []
  if (s.worktree) {
    copy.push(t('show.path', { path: s.worktree.path }))
    copy.push(t('show.branch', { branch: s.worktree.branch, base: s.diffstat?.base ?? s.worktree.base ?? s.merge?.into ?? '?' }))
  }
  // bs1: the recorded base drifted from the repository's current default — said once, with the fix.
  if (s.baseDrift) copy.push(`⚠ ${orchText(lang, 'base_drift', { id: s.id, base: s.baseDrift.base, default: s.baseDrift.default, path: s.baseDrift.path })}`)
  if (s.diffstat) {
    const stat = { count: s.diffstat.files.length, insertions: s.diffstat.insertions, deletions: s.diffstat.deletions, base: s.diffstat.base ?? '' }
    copy.push(t(s.diffstat.source === 'git' ? 'show.diffstat' : 'show.diffstatEvidence', stat))
    for (const file of s.diffstat.files.slice(0, MAX_FILES)) copy.push(`  ${file.path}${file.added === null ? '' : `  +${file.added} −${file.deleted ?? 0}`}`)
    if (s.diffstat.files.length > MAX_FILES) copy.push(`  ${t('show.more', { count: s.diffstat.files.length - MAX_FILES })}`)
  }
  if (s.uncommitted) copy.push(t('show.uncommitted', { count: s.uncommitted }))
  section(t('show.worktree'), copy.length ? copy : [t('show.noWorktree')])

  const merge: string[] = []
  const m = s.mergeState
  if (m.state === 'merged') merge.push(t('show.merged', { into: m.into, at: when(m.at), commit: m.mergeCommit ?? m.commit ? ` (${(m.mergeCommit ?? m.commit ?? '').slice(0, 12)})` : '' }))
  if (m.state === 'unmerged') {
    merge.push(t('show.unmerged', { into: m.into }), ...m.commands.map((line) => `  ${line}`))
    merge.push(m.conflicts.length ? `⚠ ${t('show.mergeConflicts', { into: m.into, count: m.conflicts.length, paths: listPaths(m.conflicts) })}` : t('show.orMerge', { id: s.id }))
  }
  if (m.state === 'in_review') merge.push(...(m.conflicts.length ? m.conflicts.map((c) => `⚠ ${conflictLine(lang, c)}`) : [t('show.reviewClean')]))
  section(t('show.merge'), merge)

  const run: string[] = []
  const last = s.lastRun
  if (last) {
    run.push(last.outcome
      ? t('show.runEnded', { run: last.runId, agent: last.agent, outcome: t(`show.outcome.${last.outcome}`), at: when(last.finishedAt ?? last.startedAt) })
      : t('show.running', { run: last.runId, agent: last.agent, at: when(last.startedAt) }))
    if (last.reason?.code === 'problem') run.push(t('show.reason.problem', { text: oneLine(last.reason.text) }))
    else if (last.reason) run.push(t(`show.reason.${last.reason.code}`, { count: last.reason.uncommitted, id: s.id }))
    if (s.runs.length > 1) run.push(t('show.runCount', { count: s.runs.length }))
  }
  section(t('show.run'), run.length ? run : [t('show.noRuns')])

  const report: string[] = []
  if (s.report) {
    report.push(...firstLines(s.report.text, REPORT_LINES))
    report.push(s.reportFile ? t('show.reportFile', { path: s.reportFile }) : t('show.reportEvents', { id: s.id }))
  }
  section(t('show.report'), report.length ? report : [t('show.noReport')])

  if (s.verdict) {
    const reason = s.verdict.why ?? s.verdict.mismatch
    section(t('show.verdict'), [`${t(`verify.verdict.${s.verdict.kind}`)}${reason ? ` — ${t(`verify.reason.${reason}`)}` : ''}`, ...checkLines(lang, s)])
  }

  if (s.check) {
    const who = { by: s.check.by ?? '?', at: when(s.check.at) }
    section(t('show.check'), [t(`show.check.${s.check.state}`, who), ...(s.check.note ? firstLines(s.check.note, REPORT_LINES) : [])])
  }

  const notes = s.notes.slice(-MAX_NOTES).map((note) => `${when(note.at)}  ${note.type}: ${oneLine(note.text)}`)
  if (s.notes.length > MAX_NOTES) notes.unshift(t('show.earlierNotes', { count: s.notes.length - MAX_NOTES }))
  section(t('show.notes'), notes.length ? notes : [t('show.noNotes')])

  const contract: string[] = []
  if (s.contract) {
    contract.push(s.contract.path)
    contract.push(...(s.checks.length ? [t('show.checks'), ...s.checks.map((check) => `  - ${check}`)] : [t('show.noChecks')]))
  }
  section(t('show.contract'), contract.length ? contract : [t('show.noContract')])
  return `${out.join('\n')}\n`
}

/**
 * The contract's checks beside the verdict (ck1): what the worker's report names as run, and — apart from it — what
 * Crewboard saw when it ran them itself, with each failure's output file and last lines; a mismatch is marked.
 */
function checkLines(lang: Lang, s: TaskShow): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}) => cliT(lang, key, vars)
  const lines: string[] = []
  const worker = s.evidence?.checks ?? []
  if (worker.length) lines.push(t('show.workerChecks', { run: worker.filter((check) => check.state === 'run').length, total: worker.length }))
  const ran = s.evidence?.crewboardChecks
  if (ran?.checks.length) {
    lines.push(t('show.crewboardChecks', { passed: ran.checks.filter(checkPassed).length, total: ran.checks.length, at: when(ran.ranAt), by: ran.by }))
    for (const check of ran.checks.filter((item) => !checkPassed(item))) {
      const outcome = check.timedOut ? t('show.crewboardTimeout', { seconds: ran.timeoutSec }) : t('show.crewboardExit', { code: check.exitCode })
      lines.push(t('show.crewboardFailed', { command: check.command, outcome, path: check.output }), ...check.tail.split('\n').map((line) => `    ${line}`))
    }
  } else if (s.evidence && s.checks.length && s.status === 'in_review') lines.push(t('show.crewboardNone', { id: s.id }))
  const mismatch = s.verdict?.facts.find((fact) => fact.code === 'checks_mismatch')
  if (mismatch?.commands) lines.push(t('show.checksMismatch', { commands: mismatch.commands.join(', ') }))
  return lines
}
