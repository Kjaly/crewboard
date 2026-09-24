import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initPlan } from '@crewboard/core'
import type { DshToolDefinition, HostContext, Route, SessionControllerFace } from '../src/host/dsh.js'
import { apply, inject, name } from '../src/host/index.js'

it('registers the prompt section, draft tool and routes, and disposes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-idx-'))
  await initPlan(root, 'goal')
  const tools: DshToolDefinition[] = []
  const routes: Route[] = []
  const sections: string[] = []
  const disposers: Array<() => void> = []
  const remove = <T>(items: T[], item: T) => () => {
    const index = items.indexOf(item)
    if (index >= 0) items.splice(index, 1)
  }
  const fakeSessions: SessionControllerFace = {
    create: async () => ({ sessionId: 'sess' }),
    prompt: async () => ({ accepted: true }),
    inspect: async () => ({}),
  }
  const ctx: HostContext = {
    effect: (fn) => {
      const d = fn()
      if (d) disposers.push(d)
    },
    inject: (names, fn) =>
      fn({
        ...ctx,
        ...(names.includes('webServer')
          ? {
              webServer: {
                register: (r: Route) => {
                  routes.push(r)
                  return remove(routes, r)
                },
              },
            }
          : {}),
        ...(names.includes('sessionController') ? { sessionController: fakeSessions } : {}),
      }),
    tools: {
      register: (d) => {
        tools.push(d)
        return remove(tools, d)
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s.name)
        return remove(sections, s.name)
      },
    },
  }
  expect(name).toBe('crewboard')
  expect(inject).toEqual(['tools', 'systemPrompt'])
  // `apply` reads the dsh workspace registry from $HOME; point it at the empty temp dir while it runs
  // so the test never depends on the developer's real ~/.dsh/storages/workspace.json.
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    apply(ctx, { repos: [root], refreshMs: 60_000, notifications: false })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
  expect(sections).toEqual(['crewboard'])
  expect(tools).toHaveLength(13)
  // Registration order is longest-path-first (see actionRoutes); the set of routes is what is pinned here.
  expect(routes.map((r) => r.path).sort()).toEqual([
    '/crewboard/api/state',
    '/crewboard/api/events',
    '/crewboard/api/notify-presence',
    '/crewboard/api/presets',
    '/crewboard/api/preset-delete',
    '/crewboard/api/repo-preset',
    '/crewboard/api/repo-flag',
    '/crewboard/api/repo-add',
    '/crewboard/api/repo-remove',
    '/crewboard/api/orchestrator-check',
    '/crewboard/api/side-order',
    '/crewboard/api/plan-preset',
    '/crewboard/api/onboarding-workers',
    '/crewboard/api/recipe',
    '/crewboard/api/recipe-save',
    '/crewboard/api/spec-files',
    '/crewboard/api/plan-draft-from',
    '/crewboard/api/spec-upload',
    '/crewboard/api/plan-draft-jobs',
    '/crewboard/api/plan-draft-job',
    '/crewboard/api/plan-draft-job-repair',
    '/crewboard/api/plan-draft-job-discard',
    '/crewboard/api/example-create',
    '/crewboard/api/example-remove',
    '/crewboard/api/task',
    '/crewboard/api/diff',
    '/crewboard/api/file',
    '/crewboard/api/example-file',
    '/crewboard/api/cost',
    '/crewboard/api/run-steps',
    '/crewboard/api/task-review',
    '/crewboard/api/trace',
    '/crewboard/api/workers',
    '/crewboard/api/worktrees',
    '/crewboard/api/worktree-gc',
    '/crewboard/api/worktree-policy',
    '/crewboard/api/worker-check',
    '/crewboard/api/worker-save',
    '/crewboard/api/worker-delete',
    '/crewboard/api/task-upsert',
    '/crewboard/api/task-status',
    '/crewboard/api/worktree-open',
    '/crewboard/api/run',
    '/crewboard/api/relaunch',
    '/crewboard/api/steer',
    '/crewboard/api/stop',
    '/crewboard/api/accept',
    '/crewboard/api/accept-batch',
    '/crewboard/api/reject',
    '/crewboard/api/pos',
    '/crewboard/api/plan-init',
    '/crewboard/api/plan-new',
    '/crewboard/api/plan-drafts',
    '/crewboard/api/plan-draft',
    '/crewboard/api/plan-draft-approve',
    '/crewboard/api/plan-draft-discard',
    '/crewboard/api/plan-use',
    '/crewboard/api/plan-archive',
    '/crewboard/api/plan-rename',
    '/crewboard/api/workers-save',
    '/crewboard/api/chat-open',
    '/crewboard/api/chat-bind',
    '/crewboard/api/chat-wake',
    '/crewboard/api/chat-unbind',
    '/crewboard/api/plan-split',
    '/crewboard/assets/screen-review.js',
    '/crewboard/assets/screen-welcome.js',
    '/crewboard/assets/screen-settings.js',
    '/crewboard/assets/screen-draft.js',
    '/crewboard/assets/screen-ledger.js',
    '/crewboard/assets/screen-trace.js',
    '/crewboard/assets/screen-task.js',
    '/crewboard/assets/preview-structured.js',
    '/crewboard/assets/preview-dxf.js',
    '/crewboard/assets/elk.js',
    '/crewboard/assets/dict-en.js',
    '/crewboard/assets/dict-ru.js',
    '/crewboard/assets/vendors.json',
    '/crewboard/assets/vendor/',
  ].sort())
  for (const d of disposers) d()
  expect({ tools, routes, sections }).toEqual({ tools: [], routes: [], sections: [] })
})
