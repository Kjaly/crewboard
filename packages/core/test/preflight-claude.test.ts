import { describe, expect, it } from 'vitest'
import type { Exec } from '../src/exec.js'
import { preflightAgent } from '../src/preflight/preflight.js'

// A Claude Code new enough for every check, signed in as the user (no API key in the environment).
const exec: Exec = async (_cmd, args) => ({ code: 0, stdout: args.includes('--version') ? '2.1.316 (Claude Code)' : '--bare  minimal mode', stderr: '', timedOut: false })
const profile = { id: 'claude/sonnet', backend: 'claude-code' as const, model: 'sonnet', enabled: true }

describe('preflight: Claude by sign-in mode', () => {
  it.each([
    ['native: the user\'s own sign-in is enough', {}, true],
    ['isolated: an API key is required', { CREWBOARD_CLAUDE_AUTH: 'isolated' }, false],
  ])('%s', async (_n, env, ok) => {
    const result = await preflightAgent(profile, { exec, env })
    expect(result.checks.every((c) => c.ok)).toBe(ok)
  })
})
