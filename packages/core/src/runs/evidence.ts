import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Backends } from '../orchestration/backends.js'
import { checkState, claimLineOf, requiredChecks } from '../orchestration/verdict.js'
import type { Run, Task } from '../plan/schema.js'
import { CREWBOARD_DIR } from '../plan/store.js'
import { nodeExec } from '../exec.js'
import { extractReport, finalMessage, type RunReport } from './report.js'

export type EvidenceCheck = { command: string; state: 'run' | 'not_run' | 'unreported' | 'unreadable' }
export type EvidenceFile = { path: string; added: number | null; deleted: number | null }
export type RunEvidence = {
  version: 1
  runId: string
  worker: string
  model?: string
  contractPath?: string
  contractRevision?: string
  finalAnswer?: string
  finalAnswerState: 'reported' | 'unreported' | 'unreadable'
  report?: RunReport
  claimLine?: string
  files: EvidenceFile[]
  filesState: 'reported' | 'unreadable'
  checks: EvidenceCheck[]
  checksState: 'reported' | 'unreadable'
  /** Files the worker left in its copy without a commit when the run ended (w1d); absent — unknown or an older record. */
  uncommitted?: number
  capturedAt: string
}

export const evidenceRef = (runId: string) => `${CREWBOARD_DIR}/runs/${runId}/evidence.json`

export async function readEvidence(root: string, ref: string | undefined): Promise<RunEvidence | undefined> {
  if (!ref || !/^\.orchestration\/runs\/run_[a-z0-9-]+\/evidence\.json$/.test(ref)) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(root, ref), 'utf8')) as RunEvidence
    return parsed.version === 1 ? parsed : undefined
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

async function changedFiles(root: string, wt: string): Promise<{ files: EvidenceFile[]; state: RunEvidence['filesState'] }> {
  try {
    const head = await nodeExec('git', ['-C', root, 'rev-parse', 'HEAD'])
    const base = await nodeExec('git', ['-C', wt, 'merge-base', 'HEAD', head.stdout.trim()])
    if (head.code || base.code) return { files: [], state: 'unreadable' }
    const [diff, others] = await Promise.all([
      nodeExec('git', ['-C', wt, 'diff', '--numstat', base.stdout.trim(), '--', '.', ':(exclude).orchestration']),
      nodeExec('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard']),
    ])
    if (diff.code || others.code) return { files: [], state: 'unreadable' }
    const files: EvidenceFile[] = diff.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [a, d, ...path] = line.split('\t')
      return { path: path.join('\t'), added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) }
    })
    for (const path of others.stdout.trim().split('\n').filter((path) => path && !path.startsWith('.orchestration/'))) {
      const abs = resolve(wt, path)
      const rel = relative(wt, abs)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      files.push({ path, added: await lineCount(abs), deleted: 0 })
    }
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), state: 'reported' }
  } catch { return { files: [], state: 'unreadable' } }
}

/** Changed, added and deleted files in the copy that are not committed (Crewboard's own files aside); undefined when git cannot tell. */
export async function uncommittedFiles(wt: string): Promise<number | undefined> {
  const status = await nodeExec('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).orchestration']).catch(() => undefined)
  if (!status || status.code) return undefined
  return status.stdout.split('\n').filter(Boolean).length
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
  let finalAnswerState: RunEvidence['finalAnswerState'] = 'unreported'
  try {
    finalAnswer = finalMessage(await (await backends.forAgent(run.agent, run.runId)).events(run.runId))
    if (finalAnswer) finalAnswerState = 'reported'
  } catch { finalAnswerState = 'unreadable' }
  const changes = task.worktree ? await changedFiles(root, task.worktree.path) : { files: [], state: 'unreadable' as const }
  const uncommitted = task.worktree ? await uncommittedFiles(task.worktree.path) : undefined
  const contractMatches = !!contract && (!run.contractRevision || createHash('sha256').update(contract).digest('hex') === run.contractRevision)
  const checks = contractMatches ? requiredChecks(contract!).map((command): EvidenceCheck => ({ command, state: finalAnswerState === 'unreadable' ? 'unreadable' : checkState(finalAnswer ?? '', command) })) : []
  const evidence: RunEvidence = {
    version: 1, runId: run.runId, worker: run.agent,
    ...(run.model ? { model: run.model } : {}),
    ...(contractPath ? { contractPath } : {}),
    ...(contractRevision ? { contractRevision } : {}),
    ...(finalAnswer ? { finalAnswer, report: extractReport(run.runId, finalAnswer), claimLine: claimLineOf(finalAnswer) ?? finalAnswer.split(/\r?\n/, 1)[0]?.trim() } : {}),
    finalAnswerState, files: changes.files, filesState: changes.state,
    checks, checksState: contractMatches ? 'reported' : 'unreadable',
    ...(uncommitted !== undefined ? { uncommitted } : {}), capturedAt: now.toISOString(),
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
