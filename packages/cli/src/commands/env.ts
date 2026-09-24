import { cliT } from '../i18n.js'
import { parseArgs } from 'node:util'
import {
  type BaselineRecord,
  EMPTY_RECIPE,
  type Exec,
  type GcCandidate,
  KEEP_REASON,
  type PreflightResult,
  gcCandidates,
  gcRecheckAccepted,
  worktreeConfigPath,
  gcRemove,
  listOrchWorktrees,
  loadPlan,
  loadRecipe,
  preflightAgent,
  codexQuotaUsedPercent,
  workerCommands,
  prepareWorktree,
  removeWorktree,
  updatePlan,
} from '@crewboard/core'
import { findProfile, homeOf, loadProfiles, repoRoot } from '../context.js'
import { type Io, UserError, confirmHuman } from '../io.js'

const formatSize = (bytes: number, lang: 'en' | 'ru'): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ${cliT(lang, 'env.gb')}`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} ${cliT(lang, 'env.mb')}`
  return `${Math.max(1, Math.round(bytes / 1024))} ${cliT(lang, 'env.kb')}`
}

/** `baseline ✓ 1a2b3c4 2026-09-24 10:00` — the copy's last baseline, or that there is none on record. */
const baselineLabel = (record: BaselineRecord | undefined, io: Io): string =>
  record
    ? cliT(io.lang ?? 'en', record.ok ? 'env.baselineGreen' : 'env.baselineRed', { commit: record.commit.slice(0, 7), at: record.at.slice(0, 16).replace('T', ' ') })
    : cliT(io.lang ?? 'en', 'env.baselineUnknown')

const keepReason = (reason: string, io: Io): string => {
  const entry = Object.entries(KEEP_REASON).find(([, text]) => text === reason)
  return entry ? cliT(io.lang ?? 'en', `env.keep.${entry[0]}`) : reason
}

/** `gc --yes` that removed nothing says so and why the rest stays (ux8 P14): «Nothing removed: 3 kept as …». */
function nothingRemoved(kept: GcCandidate[], io: Io): string {
  const lang = io.lang ?? 'en'
  if (kept.length === 0) return `${cliT(lang, 'env.noWorktrees')}\n`
  const counts = new Map<string, number>()
  for (const c of kept) if (c.keep) counts.set(c.keep, (counts.get(c.keep) ?? 0) + 1)
  const parts = [...counts].map(([reason, count]) => cliT(lang, 'env.keptCount', { count, reason: cliT(lang, `env.keep.${reason}`) }))
  return cliT(lang, 'env.nothingRemoved', { parts: parts.join(', ') })
}

export async function cmdPreflight(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { agent: { type: 'string', short: 'a' }, probe: { type: 'boolean' }, json: { type: 'boolean' } } })
  const profiles = values.agent ? [await findProfile(io, values.agent)] : (await loadProfiles(io)).filter((p) => p.enabled)
  const results: PreflightResult[] = []
  const env = { ...io.env, HOME: homeOf(io) }
  for (const p of profiles) results.push(await preflightAgent(p, { exec, codexUsedPercent: codexQuotaUsedPercent, lang: io.lang ?? 'en', env, commands: workerCommands(env) }, { probe: values.probe }))
  if (values.json) io.out(`${JSON.stringify(results, null, 2)}\n`)
  else {
    for (const r of results) {
      io.out(`${r.ok ? '✓' : '✗'} ${r.agent}\n`)
      for (const c of r.checks) io.out(`   ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${!c.ok && c.fix ? ` → ${c.fix}` : ''}\n`)
    }
  }
  return results.every((r) => r.ok) ? 0 : 1
}

export async function cmdWorktree(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, ...rest] = argv
  const root = await repoRoot(io, exec)

  if (sub === 'prepare') {
    const [id, ...flags] = rest
    const { values } = parseArgs({ args: flags, options: { scope: { type: 'string' }, plan: { type: 'string' } } })
    if (!id) throw new UserError(cliT(io.lang ?? 'en', 'env.usagePrepare'), 2)
    const task = (await loadPlan(root, values.plan)).tasks.find((t) => t.id === id)
    if (!task) throw new UserError(cliT(io.lang ?? 'en', 'env.noTask', { id }))
    const wt = await prepareWorktree({ repoRoot: root, taskId: id, title: task.title, recipe: (await loadRecipe(root)) ?? EMPTY_RECIPE, scope: values.scope, exec, env: io.env, lang: io.lang })
    await updatePlan(root, (next) => {
      const t = next.tasks.find((x) => x.id === id)
      if (t) t.worktree = { path: wt.path, branch: wt.branch }
      return next
    }, 5, values.plan)
    for (const s of wt.steps) {
      io.out(`${s.ok ? '✓' : '✗'} ${s.step} (${Math.round(s.durationMs / 1000)} ${cliT(io.lang ?? 'en', 'env.sec')})\n`)
      // Only the refresh can fail without throwing: say why the copy stayed behind.
      if (!s.ok && s.output) io.out(`  ${s.output.trim().replaceAll('\n', '\n  ')}\n`)
    }
    if (wt.baseline) io.out(`${wt.baseline.ok ? '✓' : '✗'} baseline: ${wt.baseline.step}\n`)
    else if (wt.record) io.out(cliT(io.lang ?? 'en', 'env.baselineKept', { command: wt.record.command, commit: wt.record.commit.slice(0, 7), at: wt.record.at.slice(0, 16).replace('T', ' ') }))
    io.out(`${wt.path} · ${wt.branch}${wt.reused ? cliT(io.lang ?? 'en', 'env.reused') : ''}\n`)
    return wt.baseline && !wt.baseline.ok ? 1 : 0
  }

  if (sub === 'list') {
    const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' } } })
    const infos = await listOrchWorktrees(await loadPlan(root, values.plan), exec)
    const hasBaseline = !!(await loadRecipe(root))?.baseline
    for (const w of infos) {
      const baseline = w.exists && (hasBaseline || w.baseline) ? ` · ${baselineLabel(w.baseline, io)}` : ''
      io.out(`${w.taskId}  ${w.path}  ${w.exists ? (w.dirty ? cliT(io.lang ?? 'en', 'env.dirty') : cliT(io.lang ?? 'en', 'env.clean')) : cliT(io.lang ?? 'en', 'env.absent')} · ${w.accepted ? cliT(io.lang ?? 'en', 'env.accepted') : cliT(io.lang ?? 'en', 'env.notAccepted')}${baseline}\n`)
    }
    return 0
  }

  if (sub === 'gc') {
    const { values } = parseArgs({ args: rest, options: { yes: { type: 'boolean' }, force: { type: 'string' }, plan: { type: 'string' } } })
    // `--force` is the human escape hatch: it removes one copy even with changes in it.
    if (values.force) {
      const info = (await listOrchWorktrees(await loadPlan(root, values.plan), exec)).find((w) => w.taskId === values.force)
      if (!info) throw new UserError(cliT(io.lang ?? 'en', 'env.noWorktree', { id: values.force }))
      if (!(await confirmHuman(io, cliT(io.lang ?? 'en', 'env.forceQuestion', { path: info.path })))) return 1
      const r = await removeWorktree(root, info, exec, { force: true })
      io.out(cliT(io.lang ?? 'en', 'env.deleted', { path: info.path, branchNote: r.branchDeleted ? '' : cliT(io.lang ?? 'en', 'env.branchKept', { branch: info.branch }) }))
      return 0
    }
    // B06: without --yes nothing is removed — the accepted re-check (which removes) runs only with --yes.
    if (!values.yes) {
      const candidates = await gcCandidates(root, { exec, now: io.now })
      if (candidates.length === 0) io.out(`${cliT(io.lang ?? 'en', 'env.noWorktrees')}\n`)
      for (const c of candidates) {
        const size = c.sizeBytes !== undefined ? ` · ${formatSize(c.sizeBytes, io.lang ?? 'en')}` : ''
        const dirty = c.keep === 'dirty' ? ` · ${cliT(io.lang ?? 'en', 'env.dirtyDetails', { modified: c.modifiedCount ?? 0, untracked: c.untrackedCount ?? 0, paths: c.dirtyPaths?.join(', ') ?? '', artefacts: cliT(io.lang ?? 'en', c.artefactOnly ? 'env.artifactsOnly' : 'env.notArtifactsOnly') })}` : ''
        const orphan = c.orphan ? cliT(io.lang ?? 'en', c.registeredWorktree ? 'env.orphanRegistered' : 'env.orphanUnknown') : ''
        io.out(`${c.keep ? '·' : '✓'} ${c.planId ? `${c.planId}/` : ''}${c.taskId}: ${c.keep ? cliT(io.lang ?? 'en', 'env.kept', { reason: cliT(io.lang ?? 'en', `env.keep.${c.keep}`) }) : cliT(io.lang ?? 'en', 'env.removable')}${size}${dirty}${orphan}\n`)
      }
      return 0
    }
    // The re-check also notes the removal in the task feed; whatever it left (another policy) goes by the same rules.
    const rechecked = await gcRecheckAccepted(root, { exec, now: io.now, policyPath: worktreeConfigPath(io.env, homeOf(io)), force: true })
    const candidates = await gcCandidates(root, { exec, now: io.now })
    const ids = candidates.filter((c) => !c.keep).map((c) => c.planId ? `${c.planId}:${c.taskId}` : c.taskId)
    const { removed, failed } = await gcRemove(root, ids, { exec })
    const all = [...rechecked.removed, ...removed]
    for (const id of all) io.out(cliT(io.lang ?? 'en', 'env.copyRemovedLine', { id }))
    for (const f of [...rechecked.failed, ...failed]) io.out(cliT(io.lang ?? 'en', 'env.failed', { id: f.taskId, reason: keepReason(f.reason, io) }))
    if (all.length === 0 && failed.length === 0 && rechecked.failed.length === 0) io.out(nothingRemoved(candidates, io))
    return failed.length + rechecked.failed.length > 0 ? 1 : 0
  }
  throw new UserError(cliT(io.lang ?? 'en', 'env.usage'), 2)
}
