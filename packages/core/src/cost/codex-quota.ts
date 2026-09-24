import { spawn } from 'node:child_process'

export type QuotaWindow = { usedPercent: number; remainingPercent: number; windowDurationMins?: number | null; resetsAt?: string | null }
export type CodexQuota = { ok: true; source: 'codex-app-server:account/rateLimits/read'; takenAt: string; planType?: string | null; limits: Record<string, { name?: string | null; primary: QuotaWindow | null; secondary: QuotaWindow | null }>; resetCreditsAvailable?: number | null } | { ok: false; takenAt: string; reason: string }
type Options = { binary?: string; timeoutMs?: number; now?: () => Date }

function windowOf(value: any): QuotaWindow | null {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null
  return { usedPercent: value.usedPercent, remainingPercent: Math.max(0, 100 - value.usedPercent), windowDurationMins: value.windowDurationMins ?? null, resetsAt: typeof value.resetsAt === 'number' ? new Date(value.resetsAt * 1000).toISOString() : null }
}

export async function readCodexQuota(options: Options = {}): Promise<CodexQuota> {
  const takenAt = (options.now ?? (() => new Date()))().toISOString()
  const fail = (reason: string): CodexQuota => ({ ok: false, takenAt, reason })
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(options.binary ?? 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (error) { resolve(fail(String(error))); return }
    let buffer = ''; let stderr = ''; let settled = false; let initialized = false
    const finish = (value: CodexQuota) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(value) }
    const timer = setTimeout(() => finish(fail('codex app-server timed out')), options.timeoutMs ?? 15_000)
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      for (;;) {
        const i = buffer.indexOf('\n'); if (i < 0) break
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        let msg: any; try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          if (msg.error) { finish(fail(`initialize failed: ${msg.error.message ?? 'protocol error'}`)); return }
          if (!initialized) { initialized = true; child.stdin!.write('{"method":"initialized"}\n{"id":2,"method":"account/rateLimits/read"}\n') }
        } else if (msg.id === 2) {
          if (msg.error) { finish(fail(`quota query failed: ${msg.error.message ?? 'protocol error'}`)); return }
          const result = msg.result
          if (!result || typeof result !== 'object') { finish(fail('quota response missing (not logged in or unsupported protocol)')); return }
          const historical = result.rateLimits ?? {}
          const buckets = result.rateLimitsByLimitId ?? (Object.keys(historical).length ? { codex: historical } : {})
          if (!Object.keys(buckets).length) { finish(fail('no rate limits available (not logged in?)')); return }
          const limits: Record<string, { name?: string | null; primary: QuotaWindow | null; secondary: QuotaWindow | null }> = {}
          for (const [id, snap] of Object.entries(buckets) as [string, any][]) limits[id] = { name: snap.limitName ?? null, primary: windowOf(snap.primary), secondary: windowOf(snap.secondary) }
          finish({ ok: true, source: 'codex-app-server:account/rateLimits/read', takenAt, planType: historical.planType ?? null, limits, resetCreditsAvailable: result.rateLimitResetCredits?.availableCount ?? null }); return
        }
      }
    })
    child.on('error', (error) => finish(fail(`codex app-server unavailable: ${error.message}`)))
    child.on('close', (code) => { if (!settled) finish(fail(`codex app-server exited (${code}): ${stderr.trim()}`)) })
    child.stdin!.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"crewboard","version":"0.2.0"}}}\n')
  })
}

export async function codexQuotaUsedPercent(): Promise<number | undefined> {
  const quota = await readCodexQuota()
  if (!quota.ok) return undefined
  return quota.limits.codex?.primary?.usedPercent ?? Object.values(quota.limits)[0]?.primary?.usedPercent
}
