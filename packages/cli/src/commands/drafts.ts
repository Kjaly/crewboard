import { isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type Backends, type DraftJob, type Exec, type PlanDraft, approveDraft, checkDraft, discardDraft, discardDraftJob, isBlocking,
  advanceDraftJob, listDraftJobs, listDrafts, loadDraft, recoverDraftOrphans, repairDraftJob, resolveRouting, startDraftJob, waitDraftJob,
} from '@crewboard/core'
import { makeBackends, repoRoot } from '../context.js'
import { cliT } from '../i18n.js'
import { type Io, UserError, confirmHuman } from '../io.js'

function showFindings(draft: PlanDraft, io: Io): void {
  for (const finding of checkDraft(draft)) {
    const data = finding.data
    io.out(`  ! ${cliT(io.lang ?? 'en', `draft.finding.${finding.code}`, {
      task: String(data.task ?? ''), dependency: String(data.dependency ?? ''),
      tasks: Array.isArray(data.tasks) ? data.tasks.join(' → ') : '', file: String(data.file ?? ''),
    })}\n`)
  }
}

/** Prints where a job stands; a stored draft is shown with its findings, a refused answer with the validator's. */
async function reportJob(root: string, job: DraftJob, io: Io): Promise<number> {
  const lang = io.lang ?? 'en'
  if (job.status === 'completed' && job.draftId) {
    io.out(cliT(lang, 'draft.saved', { id: job.draftId }))
    showFindings(await loadDraft(root, job.draftId), io)
    return 0
  }
  if (job.status === 'running') { io.out(cliT(lang, 'draft.running', { job: job.id, run: job.attempts.at(-1)?.runId ?? '' })); return 0 }
  if (job.status === 'needs_repair') {
    io.out(cliT(lang, 'draft.needsRepair', { job: job.id }))
    for (const finding of job.findings ?? []) io.out(`  ! ${finding.path || '(answer)'}: ${finding.message}\n`)
    return 1
  }
  if (job.status === 'failed') { io.out(cliT(lang, 'draft.failed', { job: job.id, error: job.error ?? '' })); return 1 }
  io.out(cliT(lang, 'draft.jobDropped', { job: job.id }))
  return 0
}

export async function cmdPlanDraft(argv: string[], io: Io, exec: Exec, backendsFor: (root: string) => Backends = (root) => makeBackends(io, exec, root)): Promise<number> {
  const [sub, ...rest] = argv
  const root = await repoRoot(io, exec)
  if (sub === 'draft') {
    if (rest[0] === 'show') {
      if (!rest[1]) throw new UserError(cliT(io.lang ?? 'en', 'draft.usage'), 2)
      const draft = await loadDraft(root, rest[1])
      io.out(`${JSON.stringify(draft, null, 2)}\n`)
      showFindings(draft, io)
      return 0
    }
    const backends = backendsFor(root)
    const follow = (id: string, wait: boolean | undefined) => wait ? waitDraftJob(root, id, backends, { now: () => io.now() }) : advanceDraftJob(root, id, backends, io.now())
    if (rest[0] === 'jobs') {
      const jobs = (await listDraftJobs(root)).filter((job) => job.status !== 'discarded')
      if (!jobs.length) io.out(cliT(io.lang ?? 'en', 'draft.noJobs'))
      for (const job of jobs) io.out(`${job.id}  ${job.status}  ${job.source === 'chat' ? 'chat' : job.source.name}${job.draftId ? `  → ${job.draftId}` : ''}\n`)
      return 0
    }
    if (rest[0] === 'recover') {
      const recovered = await recoverDraftOrphans(root, backends, io.now())
      io.out(cliT(io.lang ?? 'en', 'draft.recovered', { count: recovered.length }))
      for (const job of recovered) await reportJob(root, job, io)
      return 0
    }
    if (rest[0] === 'job' || rest[0] === 'repair' || rest[0] === 'drop') {
      const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true, options: { wait: { type: 'boolean' }, agent: { type: 'string', short: 'a' } } })
      const id = positionals[0]
      if (!id) throw new UserError(cliT(io.lang ?? 'en', 'draft.usage'), 2)
      if (rest[0] === 'drop') return reportJob(root, await discardDraftJob(root, id, backends, io.now()), io)
      if (rest[0] === 'repair') await repairDraftJob({ root, id, backends, now: io.now(), ...(values.agent ? { agent: values.agent } : {}) })
      return reportJob(root, await follow(id, values.wait), io)
    }
    const { values } = parseArgs({ args: rest, options: { from: { type: 'string' }, agent: { type: 'string', short: 'a' }, wait: { type: 'boolean' } } })
    if (!values.from) throw new UserError(cliT(io.lang ?? 'en', 'draft.usage'), 2)
    const file = isAbsolute(values.from) ? values.from : resolve(io.cwd, values.from)
    const agent = values.agent ?? (await resolveRouting(root, undefined, io.env)).routing.research[0]
    if (!agent) throw new UserError(cliT(io.lang ?? 'en', 'draft.noWorker'))
    const job = await startDraftJob({ root, spec: relative(root, file), agent, backends, now: io.now() })
    io.out(cliT(io.lang ?? 'en', 'draft.started', { job: job.id, agent }))
    return reportJob(root, await follow(job.id, values.wait), io)
  }
  if (sub === 'drafts') {
    for (const draft of await listDrafts(root)) io.out(`${draft.id}  ${draft.goal}\n`)
    return 0
  }
  const id = rest[0]
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'draft.usage'), 2)
  if (sub === 'approve') {
    const draft = await loadDraft(root, id)
    showFindings(draft, io)
    // A cycle or a missing dependency cannot become a plan: refuse before asking the human.
    if (checkDraft(draft).some(isBlocking)) throw new UserError(cliT(io.lang ?? 'en', 'draft.blocked', { id }), 1)
    if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'draft.approveQuestion', { id })))) return 1
    await approveDraft(root, id, io.now())
    io.out(cliT(io.lang ?? 'en', 'draft.approved', { id }))
    return 0
  }
  if (sub === 'discard') {
    await discardDraft(root, id)
    io.out(cliT(io.lang ?? 'en', 'draft.discarded', { id }))
    return 0
  }
  throw new UserError(cliT(io.lang ?? 'en', 'draft.usage'), 2)
}
