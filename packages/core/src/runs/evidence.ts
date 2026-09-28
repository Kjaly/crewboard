import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Backends } from '../orchestration/backends.js'
import { checkState, claimLineOf, contractPaths, requiredChecks } from '../orchestration/verdict.js'
import type { Run, Task } from '../plan/schema.js'
import { CREWBOARD_DIR } from '../plan/store.js'
import { nodeExec } from '../exec.js'
import { type CrewboardChecks, readCrewboardChecks } from './checks-run.js'
import { uncommittedFiles } from './git-status.js'
import { extractReport, reportedAnswer, type RunReport } from './report.js'

export { uncommittedFiles }

export type EvidenceCheck = { command: string; state: 'run' | 'not_run' | 'unreported' | 'unreadable' }
/** `status` (wk1): added, modified or deleted against the base; absent on older records. */
export type EvidenceFile = { path: string; added: number | null; deleted: number | null; status?: FileStatus }
export type FileStatus = 'A' | 'M' | 'D'
export type RunEvidence = {
  version: 1
  runId: string
  worker: string
  model?: string
  contractPath?: string
  contractRevision?: string
  /** The answer that carries the worker's report (vr2): not a later reply to a direction queued after it. */
  finalAnswer?: string
  /** The worker's last answer when it came after the report — a reply to a direction; shown, not read for the verdict. */
  followUp?: string
  finalAnswerState: 'reported' | 'unreported' | 'unreadable'
  report?: RunReport
  claimLine?: string
  files: EvidenceFile[]
  filesState: 'reported' | 'unreadable'
  checks: EvidenceCheck[]
  checksState: 'reported' | 'unreadable'
  /** The paths the contract's `<paths>` block names (vc1); absent — no block, an unread contract or an older record. */
  paths?: string[]
  /** Files the worker left in its copy without a commit when the run ended (w1d); absent — unknown or an older record. */
  uncommitted?: number
  /** The runner already asked once, in this run, to commit before the final report (cm1); absent — never asked, or an older record. */
  commitNudged?: true
  capturedAt: string
  /**
   * The contract's checks as Crewboard ran them in the copy (ck1): a fact of its own next to the worker's claim, read
   * from `checks.json` beside this file — the first observation above is never rewritten.
   */
  crewboardChecks?: CrewboardChecks
}

export const evidenceRef = (runId: string) => `${CREWBOARD_DIR}/runs/${runId}/evidence.json`

export async function readEvidence(root: string, ref: string | undefined): Promise<RunEvidence | undefined> {
  if (!ref || !/^\.orchestration\/runs\/run_[a-z0-9-]+\/evidence\.json$/.test(ref)) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(root, ref), 'utf8')) as RunEvidence
    if (parsed.version !== 1) return undefined
    const { crewboardChecks: _stored, ...evidence } = parsed
    const ran = await readCrewboardChecks(root, evidence.runId)
    return ran ? { ...evidence, crewboardChecks: ran } : evidence
  } catch { return undefined }
}

async function lineCount(path: string): Promise<number> {
  let count = 0
  let last = 10
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer
    for (const byte of bytes) if (byte === 10) count++
    if (bytes.length) last = bytes[bytes.length - 1]!
  }
  return count + (last === 10 ? 0 : 1)
}

/** git's one-letter status as the Changes tab shows it; a type change or anything unusual reads as modified. */
export function fileStatus(code: string | undefined): FileStatus | undefined {
  if (!code) return undefined
  return code.startsWith('A') ? 'A' : code.startsWith('D') ? 'D' : 'M'
}

async function changedFiles(root: string, wt: string): Promise<{ files: EvidenceFile[]; state: RunEvidence['filesState'] }> {
  try {
    const head = await nodeExec('git', ['-C', root, 'rev-parse', 'HEAD'])
    const base = await nodeExec('git', ['-C', wt, 'merge-base', 'HEAD', head.stdout.trim()])
    if (head.code || base.code) return { files: [], state: 'unreadable' }
    // Renames read as a deletion plus an addition: every path is one file with its own counts and status.
    const [diff, names, others] = await Promise.all([
      nodeExec('git', ['-C', wt, 'diff', '--numstat', '--no-renames', base.stdout.trim(), '--', '.', ':(exclude).orchestration']),
      nodeExec('git', ['-C', wt, 'diff', '--name-status', '--no-renames', base.stdout.trim(), '--', '.', ':(exclude).orchestration']),
      nodeExec('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard']),
    ])
    if (diff.code || others.code) return { files: [], state: 'unreadable' }
    const statusOf = new Map(names.code ? [] : names.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [code, ...path] = line.split('\t')
      return [path.join('\t'), fileStatus(code)] as const
    }))
    const files: EvidenceFile[] = diff.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [a, d, ...rest] = line.split('\t')
      const path = rest.join('\t')
      const status = statusOf.get(path)
      return { path, added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d), ...(status ? { status } : {}) }
    })
    for (const path of others.stdout.trim().split('\n').filter((path) => path && !path.startsWith('.orchestration/'))) {
      const abs = resolve(wt, path)
      const rel = relative(wt, abs)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      files.push({ path, added: await lineCount(abs), deleted: 0, status: 'A' })
    }
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), state: 'reported' }
  } catch { return { files: [], state: 'unreadable' } }
}

/** Called only for newly terminal runs. An exclusive create preserves the first observation. */
export async function writeEvidence(root: string, task: Task, run: Run, backends: Backends, now: Date): Promise<string> {
  const ref = evidenceRef(run.runId)
  const path = join(root, ref)
  const contractPath = run.contractPath ?? task.contract
  let contract: string | undefined
  let contractRevision = run.contractRevision
  if (contractPath) {
    const abs = resolve(root, contractPath)
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      contract = await readFile(abs, 'utf8').catch(() => undefined)
      if (contract && !contractRevision) contractRevision = createHash('sha256').update(contract).digest('hex')
    }
  }
  let finalAnswer: string | undefined
  let followUp: string | undefined
  let finalAnswerState: RunEvidence['finalAnswerState'] = 'unreported'
  let commitNudged = false
  try {
    const raw = await (await backends.forAgent(run.agent, run.runId)).events(run.runId)
    const answer = reportedAnswer(raw)
    finalAnswer = answer.text
    followUp = answer.followUp
    if (finalAnswer) finalAnswerState = 'reported'
    commitNudged = raw.some((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'commit_nudge')
  } catch { finalAnswerState = 'unreadable' }
  const changes = task.worktree ? await changedFiles(root, task.worktree.path) : { files: [], state: 'unreadable' as const }
  const uncommitted = task.worktree ? await uncommittedFiles(task.worktree.path) : undefined
  const contractMatches = !!contract && (!run.contractRevision || createHash('sha256').update(contract).digest('hex') === run.contractRevision)
  const commands = contractMatches ? requiredChecks(contract!) : []
  const checks = contractMatches ? commands.map((command): EvidenceCheck => ({ command, state: finalAnswerState === 'unreadable' ? 'unreadable' : checkState(finalAnswer ?? '', command, commands) })) : []
  const evidence: RunEvidence = {
    version: 1, runId: run.runId, worker: run.agent,
    ...(run.model ? { model: run.model } : {}),
    ...(contractPath ? { contractPath } : {}),
    ...(contractRevision ? { contractRevision } : {}),
    ...(finalAnswer ? { finalAnswer, report: extractReport(run.runId, finalAnswer), claimLine: claimLineOf(finalAnswer) ?? finalAnswer.split(/\r?\n/, 1)[0]?.trim() } : {}),
    ...(followUp ? { followUp } : {}),
    finalAnswerState, files: changes.files, filesState: changes.state,
    checks, checksState: contractMatches ? 'reported' : 'unreadable',
    ...(contractMatches && contract && contractPaths(contract).length ? { paths: contractPaths(contract) } : {}),
    ...(uncommitted !== undefined ? { uncommitted } : {}), ...(commitNudged ? { commitNudged: true as const } : {}), capturedAt: now.toISOString(),
  }
  await mkdir(join(root, CREWBOARD_DIR, 'runs', run.runId), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`)
    try { await link(temporary, path) }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
  } finally { await rm(temporary, { force: true }) }
  return ref
}
