import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, initPlan, newTask, updatePlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
import { OrchestraService } from '../src/host/service.js'
import type { HostLang } from '../src/host/i18n.js'

const now = new Date('2026-09-23T10:00:00Z')
const cases = {
  blocked: { report: 'Результат: заблокирован', expected: ['work is blocked', 'работа заблокирована'] },
  negative: { report: 'Результат: отрицательный', expected: ['a negative result was reported', 'получен отрицательный результат'] },
  run_failed: { report: 'Результат: получен', failed: true, expected: ['last run failed or was cancelled', 'последний запуск завершился с ошибкой'] },
  no_files: { report: 'Результат: получен', expected: ['no files changed', 'изменённых файлов нет'] },
  report_missing: { report: '', expected: ['no report', 'отчёт отсутствует'] },
  claim_missing: { report: 'Work finished.', expected: ['no explicit result claim', 'нет явного заявления о результате'] },
} as const

it.each(Object.entries(cases).flatMap(([code, sample]) => (['en', 'ru'] as const).map((lang) => ({ code, sample, lang }))))(
  'uses words for $code in $lang after computing a real TaskDetail', async ({ code, sample, lang }) => {
    const root = await mkdtemp(join(tmpdir(), 'orch-dialog-'))
    await initPlan(root, 'goal', now)
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'item', title: 'Item' }), status: 'in_review', runs: [
        { runId: 'run_completed', agent: 'dsh', startedAt: now.toISOString(), finishedAt: now.toISOString(), outcome: 'completed' },
        ...('failed' in sample ? [{ runId: 'run_failed', agent: 'dsh', startedAt: now.toISOString(), finishedAt: now.toISOString(), outcome: 'failed' as const }] : []),
      ] })
      return p
    })
    const backend: RunBackend = {
      id: 'dsh', launch: async () => 'run_next',
      events: async (runId) => runId === 'run_completed' && sample.report ? [{ ts: now.toISOString(), type: 'final', data: sample.report }] : [],
      status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
      steer: async () => {}, cancel: async () => {},
    }
    const backends: Backends = { forAgent: async () => backend }
    const messages: string[] = []
    const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => now })
    const route = actionRoutes({ service, repos: [root], backendsFor: () => backends, native: {
      confirm: async (_title, message) => { messages.push(message); return false }, notify: async () => {},
    }, env: {}, home: root, now: () => now, lang: () => lang as HostLang }).find((r) => r.path === '/crewboard/api/accept')!
    const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, task: 'item' }))]) as unknown as IncomingMessage
    Object.assign(req, { method: 'POST', url: route.path, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { writeHead: () => res, end: () => {} } as unknown as ServerResponse
    await route.handler(req, res)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(sample.expected[lang === 'en' ? 0 : 1])
    if (code !== 'blocked' && code !== 'negative') expect(messages[0]).not.toContain(code)
  },
)
