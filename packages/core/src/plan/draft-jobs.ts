import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as z from '../util/zod.js'
import type { Backends } from '../orchestration/backends.js'
import { finalMessage } from '../runs/report.js'
import { checkDraftAnswer, draftPrompt, repairPrompt } from './draft-from.js'
import { DraftSourceSchema, draftPath, saveDraft, sourceHash } from './draft.js'
import { CREWBOARD_DIR, planPath } from './store.js'

/**
 * A draft from a spec is a background job, not a request: its state lives in
 * `.orchestration/draft-runs/<job>/job.json` next to every prompt and every raw worker answer, so a page
 * reload, a timeout or a host restart loses nothing. Any process may advance a job (the host on each
 * refresh, `orch plan draft job --wait`); advancing is idempotent, the same answer makes the same draft.
 */
export const DRAFT_JOB_ID = /^dj-[a-z0-9]+(?:-[a-z0-9]+)*$/
export const DRAFT_JOB_STATUSES = ['running', 'completed', 'needs_repair', 'failed', 'discarded'] as const
const AnswerFindingSchema = z.object({ path: z.string(), code: z.string(), message: z.string() })
const DraftAttemptSchema = z.object({
  runId: z.string(), kind: z.enum(['draft', 'repair']), agent: z.string(),
  startedAt: z.string(), finishedAt: z.optional(z.string()), outcome: z.optional(z.string()),
})
export const DraftJobSchema = z.object({
  id: z.string().check(z.regex(DRAFT_JOB_ID)),
  status: z.enum(DRAFT_JOB_STATUSES),
  source: DraftSourceSchema,
  /** Repository-relative spec path; absent on a recovered orphan whose request did not record it. */
  spec: z.optional(z.string()),
  agent: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attempts: z.array(DraftAttemptSchema),
  draftId: z.optional(z.string()),
  findings: z.optional(z.array(AnswerFindingSchema)),
  error: z.optional(z.string()),
  /** The pre-job run this job was recovered from (see recoverDraftOrphans). */
  recoveredFrom: z.optional(z.string()),
})
export type DraftJob = z.infer<typeof DraftJobSchema>
export type DraftJobStatus = DraftJob['status']

/** What a panel or the chat agent needs of a job: its state and the current attempt, without file paths. */
export const summarizeDraftJob = (job: DraftJob) => ({
  id: job.id, status: job.status, source: job.source, agent: job.attempts.at(-1)?.agent ?? job.agent, attempts: job.attempts.length,
  startedAt: job.attempts.at(-1)?.startedAt ?? job.createdAt, updatedAt: job.updatedAt,
  ...(job.spec ? { spec: job.spec } : {}), ...(job.draftId ? { draftId: job.draftId } : {}), ...(job.findings ? { findings: job.findings } : {}),
  ...(job.error ? { error: job.error } : {}), ...(job.recoveredFrom ? { recoveredFrom: job.recoveredFrom } : {}),
})
export type DraftJobSummary = ReturnType<typeof summarizeDraftJob>

export class DraftJobError extends Error {
  constructor(readonly reason: 'invalid_id' | 'not_found' | 'bad_spec' | 'not_repairable', readonly id: string) {
    super(`${reason}: ${id}`)
    this.name = 'DraftJobError'
  }
}

export const draftRunsDir = (root: string) => join(root, CREWBOARD_DIR, 'draft-runs')
const jobDir = (root: string, id: string) => {
  if (!DRAFT_JOB_ID.test(id)) throw new DraftJobError('invalid_id', id)
  return join(draftRunsDir(root), id)
}
const promptFile = (root: string, id: string, n: number) => join(jobDir(root, id), `prompt-${n}.md`)
const answerFile = (root: string, id: string, n: number) => join(jobDir(root, id), `answer-${n}.txt`)
const exists = (path: string) => stat(path).then(() => true, () => false)

async function saveJob(root: string, job: DraftJob): Promise<DraftJob> {
  const file = join(jobDir(root, job.id), 'job.json')
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try { await writeFile(tmp, `${JSON.stringify(DraftJobSchema.parse(job), null, 2)}\n`); await rename(tmp, file) } finally { await rm(tmp, { force: true }) }
  return job
}

export async function loadDraftJob(root: string, id: string): Promise<DraftJob> {
  try { return DraftJobSchema.parse(JSON.parse(await readFile(join(jobDir(root, id), 'job.json'), 'utf8'))) }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DraftJobError('not_found', id); throw err }
}

/** Newest first; a job directory with a broken job.json is skipped rather than hiding every other job. */
export async function listDraftJobs(root: string): Promise<DraftJob[]> {
  const entries = await readdir(draftRunsDir(root), { withFileTypes: true }).catch(() => [])
  const jobs = await Promise.all(entries.filter((e) => e.isDirectory() && DRAFT_JOB_ID.test(e.name)).map((e) => loadDraftJob(root, e.name).catch(() => undefined)))
  return jobs.filter((job): job is DraftJob => job !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The latest raw answer a worker gave in this job, if any attempt answered. */
export async function draftJobAnswer(root: string, job: DraftJob): Promise<string | undefined> {
  for (let n = job.attempts.length; n >= 1; n--) {
    const text = await readFile(answerFile(root, job.id, n), 'utf8').catch(() => undefined)
    if (text !== undefined) return text
  }
  return undefined
}

async function launchAttempt(root: string, job: DraftJob, kind: 'draft' | 'repair', prompt: string, agent: string, backends: Backends, now: Date): Promise<DraftJob> {
  const n = job.attempts.length + 1
  const file = promptFile(root, job.id, n)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, prompt)
  const runId = await (await backends.forAgent(agent)).launch({ agent, promptFile: file, cwd: root })
  const { findings: _f, error: _e, ...rest } = job
  return saveJob(root, { ...rest, status: 'running', agent, updatedAt: now.toISOString(), attempts: [...job.attempts, { runId, kind, agent, startedAt: now.toISOString() }] })
}

/** Starts a draft worker on a repository file and returns the job at once; the answer is ingested later by advanceDraftJob. */
export async function startDraftJob(o: { root: string; spec: string; agent: string; backends: Backends; now: Date }): Promise<DraftJob> {
  const file = resolve(o.root, o.spec)
  const rel = relative(o.root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new DraftJobError('bad_spec', o.spec)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > 256 * 1024) throw new DraftJobError('bad_spec', o.spec)
  const text = await readFile(file, 'utf8')
  const source = { name: basename(file), hash: sourceHash(text) }
  const id = `dj-${o.now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job: DraftJob = { id, status: 'running', source, spec: rel, agent: o.agent, createdAt: o.now.toISOString(), updatedAt: o.now.toISOString(), attempts: [] }
  // Nothing ran yet when the launch itself fails: leave no job behind and let the caller report the error.
  try { return await launchAttempt(o.root, job, 'draft', draftPrompt(text, source), o.agent, o.backends, o.now) }
  catch (err) { await rm(jobDir(o.root, id), { recursive: true, force: true }); throw err }
}

/** Turns one finished answer into a stored draft, or keeps it as «needs repair» with the validator findings. */
async function ingest(root: string, job: DraftJob, answer: string | undefined, now: Date, failure?: string): Promise<DraftJob> {
  const base = { ...job, updatedAt: now.toISOString() }
  delete base.findings
  delete base.error
  if (answer === undefined) return saveJob(root, { ...base, status: 'failed', error: failure ?? 'no_final_answer' })
  await writeFile(answerFile(root, job.id, job.attempts.length), answer)
  const check = checkDraftAnswer(answer, job.source)
  if (!check.ok) return saveJob(root, { ...base, status: 'needs_repair', findings: check.findings })
  const draft = await saveDraft(root, check.draft)
  return saveJob(root, { ...base, status: 'completed', draftId: draft.id })
}

/** One step: a running job whose worker finished becomes completed, needs_repair or failed. Other jobs come back unchanged. */
export async function advanceDraftJob(root: string, id: string, backends: Backends, now: Date): Promise<DraftJob> {
  const job = await loadDraftJob(root, id)
  const attempt = job.attempts.at(-1)
  if (job.status !== 'running' || !attempt) return job
  const backend = await backends.forAgent(attempt.agent, attempt.runId)
  const state = await backend.status(attempt.runId)
  if (!state.terminal) return job
  const answer = finalMessage(await backend.events(attempt.runId))
  const finished = { ...job, attempts: [...job.attempts.slice(0, -1), { ...attempt, finishedAt: state.finishedAt ?? now.toISOString(), outcome: state.status }] }
  // A failed or cancelled run that still answered is judged by its answer: the answer is what must not be lost.
  return ingest(root, finished, answer, now, state.status === 'completed' ? 'no_final_answer' : `worker_${state.status}`)
}

/** Advances every running job; one job's backend error never stops the others. */
export async function advanceDraftJobs(root: string, backends: Backends, now: Date): Promise<DraftJob[]> {
  const jobs = await listDraftJobs(root)
  return Promise.all(jobs.map((job) => job.status === 'running' ? advanceDraftJob(root, job.id, backends, now).catch(() => job) : job))
}

/** Follows a job until its worker finishes (the CLI's `--wait`). */
export async function waitDraftJob(root: string, id: string, backends: Backends, o: { now(): Date; intervalMs?: number; onTick?(job: DraftJob): void }): Promise<DraftJob> {
  for (;;) {
    const job = await advanceDraftJob(root, id, backends, o.now())
    o.onTick?.(job)
    if (job.status !== 'running') return job
    await new Promise((done) => setTimeout(done, o.intervalMs ?? 1000))
  }
}

/**
 * A follow-up run for a job that did not produce a draft: with a stored answer the worker gets the answer
 * and the validator findings to fix; without one (the worker failed) the original request runs again.
 */
export async function repairDraftJob(o: { root: string; id: string; backends: Backends; now: Date; agent?: string }): Promise<DraftJob> {
  const job = await loadDraftJob(o.root, o.id)
  if (job.status !== 'needs_repair' && job.status !== 'failed') throw new DraftJobError('not_repairable', o.id)
  const agent = o.agent ?? job.agent
  const answer = await draftJobAnswer(o.root, job)
  if (answer !== undefined) return launchAttempt(o.root, job, 'repair', repairPrompt(answer, job.findings ?? [], job.source, job.spec), agent, o.backends, o.now)
  const original = await readFile(promptFile(o.root, job.id, 1), 'utf8').catch(() => undefined)
  if (original === undefined) throw new DraftJobError('not_repairable', o.id)
  return launchAttempt(o.root, job, 'draft', original, agent, o.backends, o.now)
}

/** Hides a job from the lists and stops its worker; the prompts and answers stay on disk. */
export async function discardDraftJob(root: string, id: string, backends: Backends, now: Date): Promise<DraftJob> {
  const job = await loadDraftJob(root, id)
  const attempt = job.attempts.at(-1)
  if (job.status === 'running' && attempt) await (await backends.forAgent(attempt.agent, attempt.runId)).cancel(attempt.runId).catch(() => undefined)
  return saveJob(root, { ...job, status: 'discarded', updatedAt: now.toISOString() })
}

/**
 * Before jobs, a draft run wrote `.orchestration/draft-runs/request-*.md` and its answer lived only in
 * memory: a refused or interrupted answer was dropped. This finds such completed runs and turns each into
 * a job once — «needs repair» with findings when the answer is invalid, a stored draft when it is valid
 * but was never saved. A run that already has a job, or whose draft or plan exists, is left alone.
 */
export async function recoverDraftOrphans(root: string, backends: Backends, now: Date): Promise<DraftJob[]> {
  const runsDir = join(root, CREWBOARD_DIR, 'runs')
  const known = new Set((await listDraftJobs(root)).map((job) => job.recoveredFrom).filter(Boolean))
  const recovered: DraftJob[] = []
  for (const runId of (await readdir(runsDir).catch(() => [] as string[])).sort()) {
    if (known.has(runId)) continue
    const args = await readFile(join(runsDir, runId, 'args.json'), 'utf8').then((raw) => JSON.parse(raw) as { promptFile?: unknown; agent?: unknown }).catch(() => undefined)
    const request = typeof args?.promptFile === 'string' ? args.promptFile : undefined
    if (!request || typeof args?.agent !== 'string' || basename(dirname(request)) !== 'draft-runs' || !basename(request).startsWith('request-')) continue
    const agent = args.agent
    const backend = await backends.forAgent(agent, runId).catch(() => undefined)
    const state = await backend?.status(runId).catch(() => undefined)
    if (!backend || !state?.terminal || state.status !== 'completed') continue
    const answer = finalMessage(await backend.events(runId).catch(() => []))
    if (answer === undefined) continue
    const prompt = await readFile(request, 'utf8').catch(() => undefined)
    const recorded = prompt?.match(/Source must be (\{.*?\})\./)?.[1]
    const parsed = recorded ? DraftSourceSchema.safeParse(JSON.parse(recorded)) : undefined
    const source = parsed?.success ? parsed.data : { name: basename(request), hash: 'unknown' }
    const check = checkDraftAnswer(answer, source)
    if (check.ok && ((await exists(draftPath(root, check.draft.id))) || (await exists(planPath(root, check.draft.id))))) continue
    const at = state.finishedAt ?? now.toISOString()
    const id = `dj-${now.getTime().toString(36)}-${runId.replace(/^run_/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
    const job: DraftJob = { id, status: 'running', source, agent, createdAt: at, updatedAt: now.toISOString(), attempts: [{ runId, kind: 'draft', agent, startedAt: at, finishedAt: at, outcome: state.status }], recoveredFrom: runId }
    await mkdir(jobDir(root, id), { recursive: true })
    if (prompt !== undefined) await writeFile(promptFile(root, id, 1), prompt)
    recovered.push(await ingest(root, job, answer, now))
  }
  return recovered
}
