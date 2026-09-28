import { describe, expect, it } from 'vitest'
import { opencodeTurnState, parseClaudeLine, parseCodexLine, parseCursorLine, parseGeminiOutput, parseGrokLine, parseOpencodeLine } from '../src/runs/cli-parse.js'

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

  it('B01 reads a rejected rate limit with its reset time and the text of a result with is_error', () => {
    const tools = new Map<string, string>()
    const limited = parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790276400}}', tools)
    expect(limited.rateLimited).toEqual({ resetsAt: '2026-09-24T19:00:00.000Z', type: 'five_hour' })
    expect(limited.events).toContainEqual(['rate_limited', { resetsAt: '2026-09-24T19:00:00.000Z', type: 'five_hour' }])
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790276400}}', tools).rateLimited).toBeUndefined()
    const result = parseClaudeLine('{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your usage limit · resets 7pm","usage":{}}', tools)
    expect(result.turnEnd).toMatchObject({ failed: true, error: "You've hit your usage limit · resets 7pm" })
    expect(parseClaudeLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"],"usage":{}}', tools).turnEnd).toMatchObject({ failed: true, error: 'boom' })
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
      usage: { input: 200, output: 50, cacheRead: 800, reasoning: 5 },
    })
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":5,"cache_write_input_tokens":0,"reasoning_output_tokens":1}}').turnEnd?.usage).toHaveProperty('cacheWrite', 0)
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}').turnEnd).toMatchObject({ stopReason: 'failed', failed: true, error: 'boom' })
    expect(parseCodexLine('{"type":"error","message":"Reconnecting 1/5"}').events).toEqual([['warning', 'Reconnecting 1/5']])
  })
})

describe('parseOpencodeLine (rb1; shapes verified against opencode 1.18.30 live output)', () => {
  it('preserves partial cache-write coverage when an error ends a mixed-step turn', () => {
    const turn = opencodeTurnState()
    parseOpencodeLine(JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls', tokens: { cache: { write: 7 } } } }), turn)
    parseOpencodeLine(JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls', tokens: {} } }), turn)
    const ended = parseOpencodeLine(JSON.stringify({ type: 'error', error: { data: { message: 'provider refused' } } }), turn)
    expect(ended.turnEnd?.usage).toMatchObject({ cacheWrite: 7, cacheWritePartial: true })
  })
  it('maps text, tool calls, session id and accumulates tokens/cost across step_finish lines', () => {
    const turn = opencodeTurnState()
    expect(parseOpencodeLine('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start","sessionID":"ses_1"}}', turn)).toEqual({ events: [], sessionId: 'ses_1' })
    expect(parseOpencodeLine('{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"on it","sessionID":"ses_1"}}', turn).events).toEqual([['answer_delta', 'on it']])
    // A tool call already carries its final state: started and completed in one line.
    expect(
      parseOpencodeLine('{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"Write","callID":"c1","sessionID":"ses_1","state":{"status":"completed","input":{"filePath":"/w/f.txt"},"output":"ok"}}}', turn).events,
    ).toEqual([
      ['tool_started', { tool: 'write', status: 'running', input: { filePath: '/w/f.txt' }, callId: 'c1' }],
      ['tool_completed', { tool: 'write', status: 'completed', callId: 'c1', output: 'ok' }],
    ])
    // A mid-turn step boundary (reason "tool-calls") accumulates without ending the turn.
    const mid = parseOpencodeLine('{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls","sessionID":"ses_1","tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":2,"write":0}},"cost":0.01}}', turn)
    expect(mid.turnEnd).toBeUndefined()
    const end = parseOpencodeLine('{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","sessionID":"ses_1","tokens":{"input":20,"output":7,"reasoning":0,"cache":{"read":0,"write":3}},"cost":0.02}}', turn)
    expect(end.turnEnd).toEqual({ stopReason: 'stop', usage: { input: 30, output: 12, cacheRead: 2, cacheWrite: 3, reasoning: 1 }, usdTotal: 0.03 })
  })

  it('fails the turn on an error event with the data message', () => {
    const parsed = parseOpencodeLine('{"type":"error","sessionID":"ses_1","error":{"name":"APIError","data":{"message":"provider refused"}}}', opencodeTurnState())
    expect(parsed.events).toEqual([['warning', 'provider refused']])
    expect(parsed.turnEnd).toMatchObject({ stopReason: 'error', failed: true, error: 'provider refused' })
    expect(parseOpencodeLine('not json', opencodeTurnState())).toEqual({ events: [] })
  })
})

describe('parseCursorLine (rb1; envelope shape cursor-agent documents for --output-format stream-json)', () => {
  it('maps init, assistant text, tool_call started/completed and the closing result', () => {
    const tools = new Map<string, string>()
    expect(parseCursorLine('{"type":"system","subtype":"init","session_id":"chat-1"}', tools)).toEqual({ events: [], sessionId: 'chat-1' })
    expect(parseCursorLine('{"type":"assistant","message":{"content":[{"type":"text","text":"on it"}]}}', tools).events).toEqual([['answer_delta', 'on it']])
    expect(parseCursorLine('{"type":"tool_call","subtype":"started","call_id":"tc1","tool_call":{"bashToolCall":{"args":{"command":"ls"}}}}', tools).events).toEqual([
      ['tool_started', { tool: 'bash', status: 'running', input: { command: 'ls' }, callId: 'tc1' }],
    ])
    expect(parseCursorLine('{"type":"tool_call","subtype":"completed","call_id":"tc1","tool_call":{"bashToolCall":{"result":"ok","success":true}}}', tools).events).toEqual([
      ['tool_completed', { tool: 'bash', status: 'completed', callId: 'tc1', output: 'ok' }],
    ])
    expect(parseCursorLine('{"type":"result","subtype":"success","is_error":false,"session_id":"chat-1"}', tools)).toEqual({
      events: [],
      sessionId: 'chat-1',
      turnEnd: { stopReason: 'success', failed: false, usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0 } },
    })
    // A failed turn is read from is_error, the reason in result — like Claude's result line.
    expect(parseCursorLine('{"type":"result","subtype":"success","is_error":true,"result":"API Error: 529"}', tools).turnEnd).toMatchObject({ failed: true, error: 'API Error: 529' })
  })
})

describe('parseGeminiOutput (rb1; --output-format json shape per gemini-cli docs — not installed here)', () => {
  it('reads response text, per-model token stats and a top-level error', () => {
    const ok = parseGeminiOutput('{"response":"done","stats":{"models":{"gemini-3-pro-preview":{"tokens":{"prompt":10,"candidates":5,"cached":2,"thoughts":1}}}}}')
    expect(ok.events).toEqual([['answer_delta', 'done']])
    expect(ok.turnEnd).toEqual({ stopReason: 'success', usage: { input: 10, output: 5, cacheRead: 2, reasoning: 1 } })
    const failed = parseGeminiOutput('{"error":{"message":"quota"}}')
    expect(failed.turnEnd).toMatchObject({ stopReason: 'error', failed: true, error: 'quota' })
    expect(parseGeminiOutput('not json')).toEqual({ events: [] })
  })
})

describe('parseGrokLine (rb1; streaming-json events the porch adapter verified on Grok Build 0.2.112)', () => {
  it('maps thought/text/tool events and reads stopReason from end', () => {
    expect(parseGrokLine('{"type":"thought","data":"thinking…"}').events).toEqual([['thinking_delta', 'thinking…']])
    expect(parseGrokLine('{"type":"text","data":"on it"}').events).toEqual([['answer_delta', 'on it']])
    expect(parseGrokLine('{"type":"tool_use","toolName":"read_file","callId":"c1","input":{"path":"/w/f.txt"}}').events).toEqual([
      ['tool_started', { tool: 'read_file', status: 'running', input: { path: '/w/f.txt' }, callId: 'c1' }],
    ])
    expect(parseGrokLine('{"type":"tool_call_update","callId":"c1","status":"in_progress"}').events).toEqual([['progress', 'in_progress']])
    expect(parseGrokLine('{"type":"tool_call_update","callId":"c1","status":"completed","result":"ok"}').events).toEqual([
      ['tool_completed', { tool: 'tool', status: 'completed', callId: 'c1', output: 'ok' }],
    ])
    expect(parseGrokLine('{"type":"end","stopReason":"EndTurn","sessionId":"grok-1","usage":{"input":10,"output":5}}')).toEqual({
      events: [],
      sessionId: 'grok-1',
      turnEnd: { stopReason: 'EndTurn', usage: { input: 10, output: 5, cacheRead: 0, reasoning: 0 } },
    })
  })

  it('fails closed on error, max_tokens and an unknown stopReason — partial text never makes it a success', () => {
    expect(parseGrokLine('{"type":"error","message":"boom"}').turnEnd).toMatchObject({ stopReason: 'error', failed: true, error: 'boom' })
    expect(parseGrokLine('{"type":"end","stopReason":"Error"}').turnEnd).toMatchObject({ failed: true })
    expect(parseGrokLine('{"type":"end","stopReason":"MaxTokens"}').turnEnd).toMatchObject({ failed: true, error: 'grok stopped: MaxTokens' })
    expect(parseGrokLine('{"type":"end","stopReason":"WhateverNew"}').turnEnd).toMatchObject({ failed: true, error: 'grok stopped: unknown_stop:whatevernew' })
    expect(parseGrokLine('not json')).toEqual({ events: [] })
  })
})
