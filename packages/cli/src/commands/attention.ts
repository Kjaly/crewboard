import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type Exec,
  type NeedsYouItem,
  type NeedsYouKind,
  type NeedsYouRepo,
  buildRepoSnapshot,
  discoverWorktreeRepos,
  folderKey,
  gatherAttention,
  listedRepositories,
  loadRepoPreferences,
  needsYou,
} from '@crewboard/core'
import { homeOf, makeBackends, repoRoot } from '../context.js'
import { cliT } from '../i18n.js'
import { type Io, UserError } from '../io.js'
import { failureText, syncPlan } from './runs.js'

type Named = NeedsYouRepo & { name: string }

const nameOf = (root: string, title?: string) => title || basename(root) || root

/** The current repository as the screen sees it; a missing or broken plan is an error, as before. */
async function currentRepo(io: Io, exec: Exec, planId: string | undefined): Promise<Named[]> {
  const root = await repoRoot(io, exec)
  const backends = makeBackends(io, exec, root)
  const snap = await buildRepoSnapshot(root, backends, io.now(), planId)
  // The snapshot swallows plan errors for the screen; reading the plan again reports them in the CLI's words.
  if (snap.hasPlan === false || snap.error) await syncPlan(root, io, backends, planId)
  if (snap.error) throw new UserError(snap.error)
  return [{ ...snap, name: nameOf(root, snap.title) }]
}

/** Every repository the screen lists (rg1): dsh workspaces, config and Crewboard's list, their plan worktrees. */
async function knownRepos(io: Io, exec: Exec): Promise<Named[]> {
  const home = homeOf(io)
  const listed = listedRepositories(io.env, home)
  const keys = new Set(listed.map((r) => folderKey(r.root)))
  const found = (await discoverWorktreeRepos(listed, exec).catch(() => [])).filter((r) => !keys.has(folderKey(r.root)))
  const prefs = await loadRepoPreferences(io.env, home).catch(() => ({}) as Awaited<ReturnType<typeof loadRepoPreferences>>)
  const refs = [...listed, ...found].filter((ref) => existsSync(ref.root))
  return Promise.all(
    refs.map(async (ref) => {
      const snap = await buildRepoSnapshot(ref.root, makeBackends(io, exec, ref.root), io.now())
      return { ...snap, name: nameOf(ref.root, ref.title), ...(prefs[ref.root]?.hidden ? { hidden: true } : {}) }
    }),
  )
}

const ORDER: NeedsYouKind[] = ['review', 'decision', 'unmerged', 'attention', 'plan']

function line(io: Io, item: NeedsYouItem, repo: string | undefined): string {
  const lang = io.lang ?? 'en'
  const where = repo ? `[${repo}] ` : ''
  const alarm = item.message ? `${item.alert ? '⚠' : '•'} ${item.message}${item.hint ? ` → ${item.hint}` : ''}` : ''
  if (item.background) {
    const waiting = item.count ? cliT(lang, 'attention.planWaiting', { count: item.count }) : ''
    return `  ${where}${item.planId}: ${item.title} — ${[waiting, alarm].filter(Boolean).join(' · ')} (--plan ${item.planId})\n`
  }
  if (item.kind === 'attention') return `  ${where}${item.taskId}: ${alarm}\n`
  if (item.kind === 'unmerged') return `  ${where}${item.taskId}: ${item.title}${item.hint ? ` → ${item.hint}` : ''}\n`
  const checked = item.kind === 'review' ? ` · ${cliT(lang, item.checked ? 'attention.checked' : 'attention.unchecked')}` : ''
  return `  ${where}${item.taskId}: ${item.title}${checked}\n`
}

/**
 * What waits on a person — the screen's «Needs you», from the same core function: reviews (and
 * whether the orchestrator checked them), decisions, accepted work not merged yet (with the merge command), failed or
 * stalled runs, other plans that wait.
 * `--alarms` keeps the old run-alarm list; `--all` covers every repository the screen knows, without
 * the example (ex1).
 */
export async function cmdAttention(argv: string[], io: Io, exec: Exec): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, plan: { type: 'string' }, all: { type: 'boolean' }, alarms: { type: 'boolean' } } })
  const lang = io.lang ?? 'en'
  if (values.alarms) {
    if (values.all) throw new UserError(cliT(lang, 'attention.alarmsAll'))
    const root = await repoRoot(io, exec)
    const backends = makeBackends(io, exec, root)
    const { plan, states } = await syncPlan(root, io, backends, values.plan)
    const alarms = await gatherAttention(plan, states, backends, io.now())
    if (values.json) {
      io.out(`${JSON.stringify(alarms, null, 2)}\n`)
      return 0
    }
    if (alarms.length === 0) io.out(`${cliT(lang, 'runs.quiet')}\n`)
    for (const a of alarms) io.out(`${a.severity === 'alert' ? '⚠' : '•'} ${a.taskId}: ${a.reason ? failureText(lang, a.reason) : a.message}${a.hint ? ` → ${a.hint}` : ''}\n`)
    return 0
  }
  if (values.all && values.plan) throw new UserError(cliT(lang, 'attention.planAll'))
  const repos = values.all ? await knownRepos(io, exec) : await currentRepo(io, exec, values.plan)
  // Example rows only for the repository asked about, when its open plan is the example; `--all` has none.
  const open = values.all ? undefined : repos[0]
  const items = needsYou(repos, open && { root: open.root, planId: open.planId })
  if (values.json) {
    io.out(`${JSON.stringify(items, null, 2)}\n`)
    return 0
  }
  if (items.length === 0) {
    io.out(`${cliT(lang, 'runs.quiet')}\n`)
    return 0
  }
  const names = new Map(repos.map((r) => [r.root, r.name]))
  const repoOf = (item: NeedsYouItem) => (values.all ? names.get(item.root) : undefined)
  const real = items.filter((item) => !item.example)
  for (const kind of ORDER) {
    const group = real.filter((item) => (item.background ? 'plan' : item.kind) === kind)
    if (group.length === 0) continue
    io.out(`${cliT(lang, `attention.head.${kind}`, { count: group.length })}\n`)
    for (const item of group) io.out(line(io, item, repoOf(item)))
  }
  const example = items.filter((item) => item.example)
  if (example.length > 0) {
    io.out(`${cliT(lang, 'attention.head.example')}\n`)
    for (const item of example) io.out(line(io, item, repoOf(item)))
  }
  return 0
}
