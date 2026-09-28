// First-load and steady-refresh measurement of the dsh host (pf1).
//
// Builds a fixture of N git repositories (default 15), each with a current plan of T tasks (default 60) and two
// background plans: accepted work merged and not merged, tasks in review with branches that conflict, failed
// attempts with their event logs. Then it starts the REAL host (`packages/plugin/lib/index.js`, run
// `pnpm build` first) with HOME pointed at the fixture, and measures:
//   - cold: time until the first snapshot that carries every repository, and what `GET /state` and the SSE
//     stream answer when the screen opens while the host is still reading;
//   - the cost of each snapshot phase (summed over repositories) and the git calls it made;
//   - steady: a refresh of the unchanged host — its time and its git calls, merge-tree among them;
//   - warm: `GET /state` and the first SSE message while a refresh runs, and the event-loop delay.
// Every git call goes through a logging shim put first on PATH, so the counts are the real processes.
//
//   node scripts/bench-first-load.mjs [--repos 15] [--tasks 60] [--dir <fixture dir>] [--json]
//   node scripts/bench-first-load.mjs --fixture-only --dir <dir>   prints the env and repositories for the stand
//
// Nothing outside the fixture directory is read or written: HOME, the repositories and the git log live there.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback)
const REPOS = Number(opt('repos', 15))
const TASKS = Number(opt('tasks', 60))
const dir = opt('dir', undefined) ?? mkdtempSync(join(tmpdir(), 'crewboard-bench-'))
const asJson = args.includes('--json')
const fixtureOnly = args.includes('--fixture-only')

const home = join(dir, 'home')
const bin = join(dir, 'bin')
const gitLog = join(dir, 'git.log')
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim()

function shim() {
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  // One line per git process: the arguments, as the host passed them.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
}

const git = (cwd, ...a) => execFileSync(realGit, ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-20T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-20T10:00:00Z' } }).trim()

/** A commit on `branch` (made from `from`) that writes `files` — without a checkout. */
function branchWith(root, branch, from, files, message) {
  const index = join(dir, `index-${process.pid}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  execFileSync(realGit, ['-C', root, 'read-tree', from], { env })
  for (const [path, text] of Object.entries(files)) {
    const blob = execFileSync(realGit, ['-C', root, 'hash-object', '-w', '--stdin'], { input: text }).toString().trim()
    execFileSync(realGit, ['-C', root, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env })
  }
  const tree = execFileSync(realGit, ['-C', root, 'write-tree'], { env }).toString().trim()
  const commit = execFileSync(realGit, ['-C', root, 'commit-tree', tree, '-p', from, '-m', message]).toString().trim()
  git(root, 'update-ref', `refs/heads/${branch}`, commit)
  return commit
}

const EVENTS = Array.from({ length: 300 }, (_, i) => JSON.stringify({ ts: new Date(Date.parse('2026-09-20T10:00:00Z') + i * 1000).toISOString(), type: i % 3 ? 'text' : 'tool_call', backend: 'claude', data: { text: `step ${i}: ${'reading the code and writing the change '.repeat(4)}` } })).join('\n') + '\n'

async function fixture(core) {
  const { initPlan, updatePlan, newTask } = core
  const now = new Date('2026-09-20T12:00:00Z')
  const roots = []
  for (let r = 0; r < REPOS; r++) {
    const root = join(dir, `repo-${String(r).padStart(2, '0')}`)
    roots.push(root)
    if (existsSync(join(root, '.orchestration'))) continue
    mkdirSync(root, { recursive: true })
    execFileSync(realGit, ['init', '-q', '-b', 'main', root])
    git(root, 'config', 'user.email', 'bench@example.com')
    git(root, 'config', 'user.name', 'Bench')
    writeFileSync(join(root, 'README.txt'), 'bench\n')
    writeFileSync(join(root, 'shared.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(root, '.gitignore'), '.orchestration/\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')
    const runs = (id, n, outcome) => {
      const out = []
      for (let k = 0; k < n; k++) {
        const runId = `run_${id}-${r}-${k}`
        const runDir = join(root, '.orchestration', 'runs', runId)
        mkdirSync(runDir, { recursive: true })
        writeFileSync(join(runDir, 'events.jsonl'), EVENTS)
        writeFileSync(join(runDir, 'evidence.json'), JSON.stringify({ version: 1, runId, worker: 'claude', finalAnswerState: 'reported', finalAnswer: 'Result: done, tests green.', files: [{ path: `src/${id}.ts`, added: 10, deleted: 2 }], filesState: 'reported', checks: [], checksState: 'reported', capturedAt: now.toISOString() }))
        const last = k === n - 1
        out.push({ runId, agent: 'claude', startedAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-20T10:30:00Z', outcome: last ? outcome : 'failed', evidence: `.orchestration/runs/${runId}/evidence.json` })
      }
      return out
    }
    const tasks = (prefix, count) => {
      const list = []
      const accepted = Math.round(count * 0.5)
      for (let i = 0; i < count; i++) {
        const id = `${prefix}${String(i).padStart(2, '0')}`
        const branch = `orch/${prefix}-${r}-${i}`
        const base = { id, title: `Task ${id} of repo ${r}`, lane: `lane-${i % 4}`, deps: i > 0 && i % 5 ? [`${prefix}${String(i - 1).padStart(2, '0')}`] : [] }
        if (i < accepted) {
          const unmerged = i >= accepted - 4
          const tip = unmerged ? branchWith(root, branch, 'main', { [`src/${id}.ts`]: `export const ${id} = ${i}\n` }, `work ${id}`) : undefined
          list.push({ ...newTask(base), status: 'accepted', worktree: { path: join(dir, 'copies', `${r}-${prefix}-${i}`), branch, base: 'main' }, runs: runs(id, 1, 'completed'), notes: [{ at: now.toISOString(), type: 'accept', text: 'accepted' }], ...(unmerged ? {} : { merged: { at: now.toISOString(), into: 'main', commit: tip ?? 'x' } }) })
        } else if (prefix === 't' && i < accepted + 6) {
          // In review, each on its own branch; the first two change the same lines and conflict.
          const k = i - accepted
          const files = k < 2 ? { 'shared.txt': `one\n${k ? 'dos' : 'deux'}\nthree\n` } : { [`src/${id}.ts`]: `export const ${id} = ${i}\n` }
          branchWith(root, branch, 'main', files, `review ${id}`)
          const path = join(dir, 'copies', `${r}-${prefix}-${i}`)
          execFileSync(realGit, ['-C', root, 'worktree', 'add', '-q', path, branch])
          list.push({ ...newTask(base), status: 'in_review', worktree: { path, branch, base: 'main' }, runs: runs(id, 2, 'completed') })
        } else if (prefix === 't' && i < accepted + 10) {
          list.push({ ...newTask(base), status: 'ready', runs: runs(id, 1, 'failed') })
        } else {
          list.push({ ...newTask(base), status: i % 3 ? 'ready' : 'backlog' })
        }
      }
      return list
    }
    await initPlan(root, `Bench repository ${r}`, now)
    await updatePlan(root, (p) => ({ ...p, tasks: tasks('t', TASKS) }))
    for (const side of ['side-a', 'side-b']) {
      await initPlan(root, `Background ${side} of ${r}`, now, side)
      await updatePlan(root, (p) => ({ ...p, tasks: tasks(side === 'side-a' ? 'a' : 'b', Math.round(TASKS / 2)) }), 5, side)
    }
    git(root, 'worktree', 'prune')
  }
  return roots
}

const lines = () => (existsSync(gitLog) ? readFileSync(gitLog, 'utf8').split('\n').filter(Boolean) : [])
const sub = (line) => {
  const a = line.split(' ')
  let i = 0
  while (a[i] === '-C') i += 2
  return a[i] ?? '?'
}
const bySub = (list) => {
  const counts = {}
  for (const line of list) counts[sub(line)] = (counts[sub(line)] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
}

function request(port, path) {
  return new Promise((resolve) => {
    const t = performance.now()
    get({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ ms: performance.now() - t, body }))
    })
  })
}

/** Opens the SSE stream; resolves with the time to the first snapshot and to the first one that has every repository. */
function sse(port, full) {
  return new Promise((resolve) => {
    const t = performance.now()
    const out = {}
    const req = get({ host: '127.0.0.1', port, path: '/crewboard/api/events' }, (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d
        for (let end = buf.indexOf('\n\n'); end >= 0; end = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, end)
          buf = buf.slice(end + 2)
          if (!chunk.startsWith('event: snapshot')) continue
          const data = JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6))
          out.first ??= { ms: performance.now() - t, repos: data.repos.length }
          if (data.repos.length >= full) {
            out.full = { ms: performance.now() - t }
            req.destroy()
            resolve(out)
            return
          }
        }
      })
    })
  })
}

const round = (n) => Math.round(n)

async function main() {
  shim()
  process.env.HOME = home
  process.env.PATH = `${bin}:${process.env.PATH}`
  const core = await import(join(here, '..', 'packages', 'core', 'dist', 'index.js'))
  const roots = await fixture(core)
  if (fixtureOnly) {
    console.log(JSON.stringify({ dir, home, path: `${bin}:$PATH`, repos: roots }))
    return
  }
  writeFileSync(gitLog, '')
  const { apply } = await import(join(here, '..', 'packages', 'plugin', 'lib', 'index.js'))
  const phases = {}
  let profileOn = true
  const profile = (_root, name, ms) => { if (profileOn) phases[name] = (phases[name] ?? 0) + ms }
  const routes = []
  let service
  const ctx = {
    effect: (fn) => { fn() },
    inject: (names, fn) => fn({ ...ctx, ...(names.includes('webServer') ? { webServer: { register: (r) => { routes.push(r); return () => {} } } } : {}) }),
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    const route = routes.find((r) => (r.kind === 'exact' ? r.path === path : path.startsWith(r.path)))
    if (!route) { res.writeHead(404).end(); return }
    await route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const lag = monitorEventLoopDelay({ resolution: 10 })

  // Cold: the host starts and the screen opens 50 ms later.
  lag.enable()
  const t0 = performance.now()
  let firstFull
  apply(ctx, { repos: roots, refreshMs: 3_600_000, notifications: false }, { native: { confirm: async () => false, notify: async () => {} }, onService: (s) => { service = s; s.subscribe((snap) => { if (!firstFull && snap.repos.length >= roots.length && snap.repos.every((r) => r.tasks.length)) firstFull = performance.now() - t0 }) }, profile })
  await new Promise((r) => setTimeout(r, 50))
  const [coldState, coldSse] = await Promise.all([request(port, '/crewboard/api/state').then((r) => ({ ms: r.ms, repos: JSON.parse(r.body).value.repos.length })), sse(port, roots.length)])
  await service.idle()
  // A refresh of every repository may still be finishing its follow-up facts: wait for the host to settle.
  if (service.settled) await service.settled()
  const coldMs = performance.now() - t0
  lag.disable()
  const cold = { firstFullMs: round(firstFull ?? coldMs), settledMs: round(coldMs), state: { ms: round(coldState.ms), repos: coldState.repos }, sse: { firstMs: round(coldSse.first.ms), firstRepos: coldSse.first.repos, fullMs: round(coldSse.full.ms) }, loopMaxMs: round(lag.max / 1e6), loopP99Ms: round(lag.percentile(99) / 1e6), git: lines().length, gitBySub: bySub(lines()), phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, round(v)])) }

  // Steady: nothing changed; a full refresh, and the screen opening while it runs.
  const steadyRuns = []
  for (let i = 0; i < 2; i++) {
    writeFileSync(gitLog, '')
    for (const k of Object.keys(phases)) delete phases[k]
    lag.reset()
    lag.enable()
    const t = performance.now()
    const refresh = service.refresh()
    const [state, stream] = await Promise.all([request(port, '/crewboard/api/state'), sse(port, roots.length)])
    await refresh
    if (service.settled) await service.settled()
    lag.disable()
    const log = lines()
    steadyRuns.push({ ms: round(performance.now() - t), stateMs: round(state.ms), sseFirstMs: round(stream.first.ms), loopMaxMs: round(lag.max / 1e6), git: log.length, mergeTree: log.filter((l) => sub(l) === 'merge-tree').length, gitBySub: bySub(log), phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, round(v)])) })
  }

  // What the review centre's poll of /state costs while no stream is live (every 25 s).
  const stateReads = []
  for (let i = 0; i < 5; i++) stateReads.push(await request(port, '/crewboard/api/state'))
  const statePoll = { bytes: stateReads[0].body.length, ms: round(stateReads.reduce((sum, r) => sum + r.ms, 0) / stateReads.length) }

  // Per-phase git calls of one repository, refreshed alone (steady).
  profileOn = false
  writeFileSync(gitLog, '')
  const perPhaseGit = {}
  const perRepoMs = []
  service.deps.profile = (_root, name) => { perPhaseGit[name] = (perPhaseGit[name] ?? 0) + lines().length - (perPhaseGit.__seen ?? 0); perPhaseGit.__seen = lines().length }
  for (const root of roots) {
    const t = performance.now()
    await service.refresh(root)
    if (service.settled) await service.settled()
    perRepoMs.push(performance.now() - t)
  }
  delete perPhaseGit.__seen
  const result = { fixture: { repos: roots.length, tasksPerCurrentPlan: TASKS, plansPerRepo: 3, dir }, cold, steady: steadyRuns, statePoll, steadyPerRepo: { avgMs: round(perRepoMs.reduce((a, b) => a + b, 0) / perRepoMs.length), maxMs: round(Math.max(...perRepoMs)), gitPerPhase: Object.fromEntries(Object.entries(perPhaseGit).map(([k, v]) => [k, round(v / roots.length * 10) / 10])) } }
  console.log(asJson ? JSON.stringify(result) : JSON.stringify(result, null, 2))
  server.close()
  process.exit(0)
}

await main()
