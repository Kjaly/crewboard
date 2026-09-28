import { readFile } from 'node:fs/promises'
import { readDshBillUsage } from './dsh-bill.js'

export type OrchestratorBinding = { sessionId: string; boundAt?: string }
export type OrchestratorSessionUsage = {
  actor: 'orchestrator'
  scope: 'session_lifetime'
  sessionId: string
  boundAt?: string
  metrics?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', { value?: number; state: 'known' | 'partial' | 'unavailable'; source: 'dsh_bill_records' }>>
  calls?: number
  source?: 'dsh_bill_records'
  cash?: { value?: number; state: 'known' | 'partial' | 'unavailable'; source: 'dsh_bill_records'; calls: number }
  state: 'observed' | 'pending'
  reason?: 'bill_not_recorded_yet'
}
export type OrchestratorUsage = {
  actor: 'orchestrator'
  scope: 'session_lifetime'
  availability: 'available' | 'pending' | 'unavailable'
  reason?: 'no_bound_session' | 'bill_not_recorded_yet'
  windowSelection?: 'binding_only'
  sessions: OrchestratorSessionUsage[]
  coverage: { bound: number; observed: number; pending: number }
}

/** Reads only supplied bindings. Lifetime usage is intentionally not apportioned to a plan by boundAt. */
export async function orchestratorUsage(bindings: Record<string, OrchestratorBinding>, billFile: string, planIds?: string[]): Promise<OrchestratorUsage> {
  const selected = planIds ? new Set(planIds) : undefined
  const bySession = new Map<string, OrchestratorBinding>()
  for (const [planId, binding] of Object.entries(bindings)) {
    if (selected && !selected.has(planId)) continue
    if (typeof binding?.sessionId !== 'string' || !binding.sessionId) continue
    if (!bySession.has(binding.sessionId)) bySession.set(binding.sessionId, binding)
  }
  if (!bySession.size) return { actor: 'orchestrator', scope: 'session_lifetime', availability: 'unavailable', reason: 'no_bound_session', sessions: [], coverage: { bound: 0, observed: 0, pending: 0 } }
  const sessions: OrchestratorSessionUsage[] = []
  for (const [sessionId, binding] of bySession) {
    const usage = await readDshBillUsage(billFile, sessionId)
    const metrics = usage.pending ? undefined : {
      input: metric(usage, 'input', usage.inputTokens), output: metric(usage, 'output', usage.outputTokens), cacheRead: metric(usage, 'cacheRead', usage.cacheReadTokens),
      cacheWrite: metric(usage, 'cacheWrite', usage.cacheWriteTokens), reasoning: metric(usage, 'reasoning', usage.reasoningTokens),
    }
    const cashAvailability = usage.availability?.cash
    const cashState = cashAvailability?.state === 'known' ? 'known' : cashAvailability?.state === 'partial' ? 'partial' : 'unavailable'
    sessions.push({ actor: 'orchestrator', scope: 'session_lifetime', sessionId, ...(binding.boundAt ? { boundAt: binding.boundAt } : {}), state: usage.pending ? 'pending' : 'observed', ...(usage.pending ? { reason: 'bill_not_recorded_yet' as const } : { metrics, calls: usage.calls, source: 'dsh_bill_records' as const, cash: { ...(cashAvailability?.value !== undefined ? { value: cashAvailability.value } : {}), state: cashState, source: 'dsh_bill_records' as const, calls: usage.calls } }) })
  }
  const pending = sessions.filter((s) => s.state === 'pending').length
  const observed = sessions.length - pending
  return { actor: 'orchestrator', scope: 'session_lifetime', availability: observed ? 'available' : 'pending', ...(pending ? { reason: 'bill_not_recorded_yet' as const } : {}), sessions, coverage: { bound: sessions.length, observed, pending } }
}
function metric(usage: Awaited<ReturnType<typeof readDshBillUsage>>, key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning', fallback: number | undefined): { value?: number; state: 'known' | 'partial' | 'unavailable'; source: 'dsh_bill_records' } {
  const availability = usage.availability?.[key]
  const state = availability?.state === 'known' || availability?.state === 'partial' ? availability.state : 'unavailable'
  const value = availability?.value ?? fallback
  return { ...(state === 'unavailable' || value === undefined ? {} : { value }), state, source: 'dsh_bill_records' as const }
}

/** Parse the explicit `.orchestration/chats.json` path. No directory or chat discovery is performed. */
export async function readOrchestratorBindings(file: string): Promise<Record<string, OrchestratorBinding>> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, OrchestratorBinding>
  } catch { return {} }
}
