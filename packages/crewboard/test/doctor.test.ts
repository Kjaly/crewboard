import { describe, expect, it } from 'vitest'
import type { Exec } from '@crewboard/core'
import { connectLead } from '../src/connect.js'
import { checkAgents } from '../src/doctor.js'
import { AgentsFileError, builtinAgents } from '../src/workers/agents.js'

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })
/** Every CLI installed, signed in and new enough. */
const installed: Exec = async (cmd, args) => {
  if (args[0] === '--version') return ok({ claude: '2.1.316 (Claude Code)', codex: 'codex-cli 0.160.0', dsh: '0.1.5-rc.1' }[cmd] ?? '1.0.0')
  if (cmd === 'codex' && args.join(' ') === 'login status') return ok('Logged in using ChatGPT')
  if (cmd === 'claude' && args.join(' ') === 'auth status --json') return ok('{"loggedIn":true,"email":"secret@example.com"}')
  return ok('--bare')
}
const missing: Exec = async (cmd) => {
  throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })
}
const dshHangs: Exec = (cmd, args, opts) => (cmd === 'dsh' ? new Promise(() => undefined) : installed(cmd, args, opts))

const env = { DEEPSEEK_API_KEY: 'test-key' }

describe('worker readiness', () => {
  it.each([
    ['every CLI installed', installed, { claude: true, codex: true, deepseek: true }],
    ['no CLI installed', missing, { claude: false, codex: false, deepseek: false }],
    ['a CLI that hangs', dshHangs, { claude: true, codex: true, deepseek: false }],
  ] as const)('%s', async (_n, exec, expected) => {
    const result = await checkAgents({ agents: builtinAgents, env, exec, timeoutMs: 100 })
    expect(Object.fromEntries(result.map((a) => [a.id, a.ok]))).toEqual(expected)
    for (const a of result.filter((r) => !r.ok)) expect(a.checks.find((c) => !c.ok)?.fix ?? a.checks.find((c) => !c.ok)?.detail).toBeTruthy()
  })

  it('reports a broken agent registry as a failed check instead of throwing', async () => {
    const broken = { ...builtinAgents, list: async () => { throw new AgentsFileError('/home/x/.crewboard/agents.json', 'Unexpected token') } }
    const result = await checkAgents({ agents: broken, env, exec: installed, timeoutMs: 100 })
    expect(result).toEqual([expect.objectContaining({ ok: false, checks: [expect.objectContaining({ detail: expect.stringContaining('/home/x/.crewboard/agents.json') })] })])
  })

  it('never shows what the Claude sign-in status says beyond signed in or not', async () => {
    const result = await checkAgents({ agents: builtinAgents, env, exec: installed, timeoutMs: 100 })
    expect(JSON.stringify(result)).not.toContain('secret@example.com')
  })
})

describe('connecting the lead', () => {
  const url = 'http://127.0.0.1:4700/mcp'
  const recording = () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const exec: Exec = async (cmd, args) => {
      calls.push({ cmd, args })
      return { code: 0, stdout: 'Added', stderr: '', timedOut: false }
    }
    return { calls, exec }
  }

  it.each([
    ['claude', ['claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'crewboard', url]]],
    ['codex', ['codex', ['mcp', 'add', 'crewboard', '--url', url]]],
  ] as const)('runs the %s command', async (client, [cmd, args]) => {
    const r = recording()
    const out = await connectLead({ client, url, exec: r.exec })
    expect(r.calls).toEqual([{ cmd, args }])
    expect(out.error).toBeUndefined()
  })

  it.each([
    ['dsh', 'transport: streamable-http'],
    ['other', url],
  ] as const)('prints what to add for %s without running anything', async (client, text) => {
    const r = recording()
    const out = await connectLead({ client, url, exec: r.exec })
    expect(r.calls).toEqual([])
    expect(out.print).toContain(text)
  })

  it('explains a missing client CLI instead of throwing', async () => {
    const out = await connectLead({ client: 'claude', url, exec: missing })
    expect(out.error).toMatch(/claude/)
  })
})
