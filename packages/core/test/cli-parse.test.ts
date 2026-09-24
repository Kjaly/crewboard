import { describe, expect, it } from 'vitest'
import { parseClaudeLine, parseCodexLine } from '../src/runs/cli-parse.js'

describe('parseClaudeLine', () => {
  it('maps init, text, tool use/result, rate limits and results', () => {
    const tools = new Map<string, string>()
    expect(parseClaudeLine('{"type":"system","subtype":"init","session_id":"s-1"}', tools)).toEqual({ events: [], sessionId: 's-1' })
    expect(
      parseClaudeLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}', tools).events,
    ).toEqual([
      ['answer_delta', 'Hi'],
      ['tool_started', { tool: 'bash', status: 'running', input: { command: 'ls' }, callId: 't1' }],
    ])
    expect(parseClaudeLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true}]}}', tools).events).toEqual([
      ['tool_completed', { tool: 'bash', status: 'error', callId: 't1' }],
    ])
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}', tools).events).toEqual([['rate_limit', { status: 'allowed' }]])
    expect(
      parseClaudeLine(
        '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.13,"usage":{"input_tokens":18,"output_tokens":870,"cache_read_input_tokens":21322,"cache_creation_input_tokens":63255}}',
        tools,
      ).turnEnd,
    ).toEqual({ stopReason: 'success', failed: false, usdTotal: 0.13, usage: { input: 18, output: 870, cacheRead: 21322, cacheWrite: 63255, reasoning: 0 } })
  })

  it('reads a replayed stdin message (the shape claude 2026-09 emits with --replay-user-messages)', () => {
    const line = '{"type":"user","message":{"role":"user","content":"Also reply with DONE2."},"session_id":"s-1","parent_tool_use_id":null,"uuid":"u1","timestamp":"2026-09-24T13:00:00Z","isReplay":true}'
    expect(parseClaudeLine(line, new Map())).toEqual({ events: [], replay: 'Also reply with DONE2.' })
    expect(parseClaudeLine('{"type":"user","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},"isReplay":true}', new Map()).replay).toBe('ab')
  })

  it('ignores noise and broken lines', () => {
    const tools = new Map<string, string>()
    expect(parseClaudeLine('{"type":"system","subtype":"thinking_tokens"}', tools)).toEqual({ events: [] })
    expect(parseClaudeLine('not json', tools)).toEqual({ events: [] })
  })
})

describe('parseCodexLine', () => {
  it('maps threads, commands, file changes, messages and usage', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"th-9"}')).toEqual({ events: [], sessionId: 'th-9' })
    expect(parseCodexLine(`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"/bin/zsh -lc 'cat b.txt'"}}`).events).toEqual([
      ['tool_started', { tool: 'bash', status: 'running', input: { command: 'cat b.txt' }, callId: 'i1' }],
    ])
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i1","type":"command_execution","exit_code":2}}').events).toEqual([
      ['tool_completed', { tool: 'bash', status: 'error', callId: 'i1' }],
    ])
    expect(parseCodexLine('{"type":"item.started","item":{"id":"i2","type":"file_change","changes":[{"path":"/w/b.txt","kind":"add"}]}}').events).toEqual([
      ['tool_started', { tool: 'edit', status: 'running', input: { path: '/w/b.txt' }, callId: 'i2' }],
    ])
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"done"}}').events).toEqual([['answer_delta', 'done\n']])
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i0","type":"error","message":"skills budget"}}').events).toEqual([['warning', 'skills budget']])
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50,"reasoning_output_tokens":5}}').turnEnd).toEqual({
      stopReason: 'completed',
      usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, reasoning: 5 },
    })
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}').turnEnd).toMatchObject({ stopReason: 'failed', failed: true, error: 'boom' })
    expect(parseCodexLine('{"type":"error","message":"Reconnecting 1/5"}').events).toEqual([['warning', 'Reconnecting 1/5']])
  })
})
