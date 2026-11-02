import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectFolder } from '../src/history/paths.js'
import { HISTORY_LIMIT, createHistory } from '../src/history/sessions.js'
import { readTranscript } from '../src/history/transcript.js'

// Lines in the shape Claude Code writes them (checked on a real transcript, 2026-11-02).
let n = 0
const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 10, min)).toISOString()
const base = (session: string, min: number) => ({ uuid: `u${++n}`, parentUuid: null, sessionId: session, timestamp: at(min), isSidechain: false, cwd: '/repo' })
const owner = (s: string, min: number, text: string) => ({ ...base(s, min), type: 'user', message: { role: 'user', content: text } })
const lead = (s: string, min: number, text: string) => ({ ...base(s, min), type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }] } })
const tool = (s: string, min: number, id: string, name: string, input: unknown) => ({ ...base(s, min), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (s: string, min: number, id: string, text: string) => ({ ...base(s, min), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })
const noise = (s: string, min: number) => [
  { ...base(s, min), type: 'attachment', attachment: { kind: 'x' } },
  { ...base(s, min), type: 'system', content: 'compacted' },
  { ...owner(s, min, 'внутренний вопрос субагенту'), isSidechain: true },
]
const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cb-claude-'))
  const repo = '/Users/someone/work/kitchen.app'
  const dir = join(root, projectFolder(repo))
  await mkdir(dir, { recursive: true })
  const A = 'sess-a'
  await writeFile(join(dir, `${A}.jsonl`), lines([
    owner(A, 1, 'Хочу кухню полного цикла <system-reminder>служебное</system-reminder>'),
    ...noise(A, 1),
    lead(A, 2, 'Уточню три вещи.'),
    tool(A, 3, 't1', 'mcp__crewboard__crewboard_start_goal', { project: repo, title: 'Кухня', criteria: [] }),
    result(A, 3, 't1', '{"goalId":"g1"}'),
    tool(A, 4, 't2', 'mcp__crewboard__crewboard_assign', { project: repo, goalId: 'g1', title: 'Панель', criteria: [], resultKind: 'local', provider: 'claude' }),
    result(A, 4, 't2', '{"assignmentId":"a-1"}'),
    tool(A, 5, 't3', 'Bash', { command: 'ls' }),
    result(A, 5, 't3', 'README.md'),
    tool(A, 6, 't4', 'Bash', { command: 'git status' }),
    lead(A, 7, 'Раздал работу.'),
  ]))
  await writeFile(join(dir, 'sess-b.jsonl'), lines([
    owner('sess-b', 30, 'Подхвати кухню'),
    tool('sess-b', 31, 'b1', 'mcp__crewboard__crewboard_adopt_goal', { project: repo, goalId: 'g1' }),
    result('sess-b', 31, 'b1', '{"ok":true}'),
  ]))
  await writeFile(join(dir, 'sess-other.jsonl'), lines([
    owner('sess-other', 20, 'Другая цель'),
    tool('sess-other', 21, 'o1', 'mcp__crewboard__crewboard_start_goal', { project: repo, title: 'Шкаф', criteria: [] }),
    result('sess-other', 21, 'o1', '{"goalId":"g2"}'),
  ]))
  await writeFile(join(dir, 'broken.jsonl'), '{"type":"user","message":{"content":"g1 обрыв\n{не json}\n')
  // Never read the developer's real Codex sessions from tests.
  const noCodex = await mkdtemp(join(tmpdir(), 'cb-codex-none-'))
  return { root, repo, dir, history: createHistory({ env: { CREWBOARD_CLAUDE_PROJECTS: root, CREWBOARD_CODEX_SESSIONS: noCodex, CREWBOARD_DSH_SESSIONS: noCodex } }) }
}

describe('transcripts', () => {
  it('names the project folder the way Claude Code does', () => {
    expect(projectFolder('/private/tmp/x.y/a_b')).toBe('-private-tmp-x-y-a-b')
  })

  it('reads owner and lead words and tool calls, skipping service lines, side chains and thinking', async () => {
    const { dir } = await fixture()
    const { sessionId, items } = await readTranscript(join(dir, 'sess-a.jsonl'))
    expect(sessionId).toBe('sess-a')
    expect(items.map((i) => i.kind)).toEqual(['owner', 'lead', 'tool', 'tool_result', 'tool', 'tool_result', 'tool', 'tool_result', 'tool', 'lead'])
    expect(items[0]).toMatchObject({ kind: 'owner', text: 'Хочу кухню полного цикла' })
  })

  it('collects every session that touched the goal, in time order, with assignment cards', async () => {
    const { history, repo } = await fixture()
    const h = await history.goalHistory(repo, 'g1')
    expect(h.available).toBe(true)
    const sessions = h.items.filter((i) => i.kind === 'session').map((i) => (i.kind === 'session' ? i.sessionId : ''))
    expect(sessions).toEqual(['sess-a', 'sess-b'])
    expect(h.items.some((i) => (i.kind === 'owner' || i.kind === 'lead') && i.text === 'Другая цель')).toBe(false)
    expect(h.items.find((i) => i.kind === 'assignment' && i.tool === 'assign')).toMatchObject({ assignmentId: 'a-1', title: 'Панель' })
    expect(h.items.filter((i) => i.kind === 'actions')).toEqual([expect.objectContaining({ count: 2 })])
  })

  it('says the history is unavailable when the project has no transcripts', async () => {
    const { history } = await fixture()
    expect(await history.goalHistory('/nowhere/at/all', 'g1')).toEqual({ available: false, truncated: false, items: [] })
  })

  it('sees new lines appended to a transcript', async () => {
    const { history, repo, dir } = await fixture()
    await history.goalHistory(repo, 'g1')
    await appendFile(join(dir, 'sess-a.jsonl'), lines([owner('sess-a', 8, 'А теперь сборку')]))
    const h = await history.goalHistory(repo, 'g1')
    expect(h.items.some((i) => i.kind === 'owner' && i.text === 'А теперь сборку')).toBe(true)
  })

  it(`keeps the last ${HISTORY_LIMIT} items of a long conversation`, async () => {
    const { history, repo, dir } = await fixture()
    const many = Array.from({ length: 3000 }, (_, i) => owner('sess-a', 9, `реплика ${i}`))
    await appendFile(join(dir, 'sess-a.jsonl'), lines(many))
    const h = await history.goalHistory(repo, 'g1')
    expect(h.truncated).toBe(true)
    expect(h.items.length).toBe(HISTORY_LIMIT)
    expect(h.items.some((i) => i.kind === 'owner' && i.text === 'реплика 2999')).toBe(true)
  })

  it.each([
    ['a skill body Claude Code injects (isMeta)', { ...owner('sess-a', 1, 'Base directory for this skill: /x\n# Skill'), isMeta: true }],
    ['a compaction summary', { ...owner('sess-a', 1, 'This session is being continued from a previous conversation'), isCompactSummary: true }],
    ['a task notification', owner('sess-a', 1, '<task-notification><task-id>x</task-id></task-notification>')],
    ['a message from another session', owner('sess-a', 1, '<agent-message from="x">report</agent-message>')],
    ['an IDE selection', owner('sess-a', 1, '<ide_selection>code</ide_selection>')],
  ])('never shows %s as the owner speaking', async (_name, row) => {
    const root = await mkdtemp(join(tmpdir(), 'cb-meta-'))
    await writeFile(join(root, 's.jsonl'), lines([row, owner('sess-a', 2, 'настоящая реплика')]))
    const { items } = await readTranscript(join(root, 's.jsonl'))
    expect(items.filter((i) => i.kind === 'owner').map((i) => (i.kind === 'owner' ? i.text : ''))).toEqual(['настоящая реплика'])
  })

  it('finds a lead that ran in a subfolder of the repository', async () => {
    const { root, repo, history } = await fixture()
    const sub = join(root, projectFolder(`${repo}/packages/app`))
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'sess-sub.jsonl'), lines([
      owner('sess-sub', 40, 'из подпапки'),
      tool('sess-sub', 41, 's1', 'mcp__crewboard__crewboard_status', { project: repo, goalId: 'g1' }),
    ]))
    const h = await history.goalHistory(repo, 'g1')
    expect(h.items.some((i) => i.kind === 'owner' && i.text === 'из подпапки')).toBe(true)
  })
})


// Codex rollout lines in the shape Codex CLI 0.160–0.166 writes them (checked on real files, 2026-11-02).
const cx = {
  meta: (min: number, id: string, cwd: string) => ({ timestamp: at(min), type: 'session_meta', payload: { id, cwd, originator: 'codex_cli_rs', cli_version: '0.160.0' } }),
  msg: (min: number, role: 'user' | 'assistant', text: string) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }),
  call: (min: number, id: string, tool: string, args: unknown) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__crewboard', name: `crewboard_${tool}`, arguments: JSON.stringify(args), call_id: id } }),
  out: (min: number, id: string, text: string) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: text } }),
  // Codex in code mode calls MCP tools from JavaScript inside its `exec` tool (seen with Codex CLI 0.160, 2026-11-02).
  exec: (min: number, id: string, code: string) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input: code } }),
  execOut: (min: number, id: string, text: string) => ({ timestamp: at(min), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text }] } }),
}

async function codexFixture(extra?: { claude?: boolean }) {
  const base = await fixture()
  const sessions = await mkdtemp(join(tmpdir(), 'cb-codex-'))
  const day = join(sessions, '2026', '11', '02')
  await mkdir(day, { recursive: true })
  const file = join(day, 'rollout-2026-11-02T10-40-00-codex-1.jsonl')
  await writeFile(file, lines([
    cx.meta(40, 'codex-1', base.repo),
    cx.msg(40, 'user', '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
    cx.msg(41, 'user', 'Нужен раздел Usage'),
    cx.msg(42, 'assistant', 'Поручу черновик Codex.'),
    cx.call(43, 'c1', 'assign', { project: base.repo, goalId: 'g1', title: 'Раздел Usage', criteria: [], resultKind: 'local', provider: 'codex' }),
    cx.out(43, 'c1', '{"assignmentId":"a-2"}'),
    { timestamp: at(44), type: 'turn_context', payload: { cwd: base.repo } },
  ]) + '{не json}\n')
  await writeFile(join(day, 'rollout-elsewhere.jsonl'), lines([cx.meta(45, 'codex-2', '/somewhere/else'), cx.call(45, 'e1', 'assign', { goalId: 'g1', title: 'Чужое' })]))
  const read: string[] = []
  const env = { ...(extra?.claude === false ? {} : { CREWBOARD_CLAUDE_PROJECTS: base.root }), CREWBOARD_CODEX_SESSIONS: sessions, CREWBOARD_DSH_SESSIONS: sessions }
  return { ...base, file, history: createHistory({ env, onRead: (f) => { read.push(f) } }), reads: () => read.length, readFiles: () => read }
}

describe('Codex transcripts', () => {
  it('reads crewboard calls Codex makes from code inside its exec tool', async () => {
    const { repo, root } = await fixture()
    const sessions = await mkdtemp(join(tmpdir(), 'cb-codex-exec-'))
    const day = join(sessions, '2026', '11', '02')
    await mkdir(day, { recursive: true })
    await writeFile(join(day, 'rollout-exec.jsonl'), lines([
      cx.meta(60, 'codex-exec', repo),
      cx.msg(60, 'user', 'Проверь README'),
      cx.exec(61, 'x1', `const result = await tools.mcp__crewboard__crewboard_start_goal({project:"${repo}", title:"Readme check", criteria:["One sentence"]});\ntext(result);`),
      cx.execOut(61, 'x1', '{"content":[{"type":"text","text":"{\\"goalId\\":\\"g9\\"}"}]}'),
      cx.exec(62, 'x2', `text(await tools.mcp__crewboard__crewboard_assign({project:"${repo}", goalId:"g9", provider:"codex", title:"Summarise the README", criteria:["One sentence"]}));`),
      cx.execOut(62, 'x2', '{"content":[{"type":"text","text":"{\\"assignmentId\\":\\"a-9\\"}"}]}'),
    ]))
    const history = createHistory({ env: { CREWBOARD_CLAUDE_PROJECTS: root, CREWBOARD_CODEX_SESSIONS: sessions, CREWBOARD_DSH_SESSIONS: sessions } })
    const h = await history.goalHistory(repo, 'g9')
    expect(h.source).toBe('transcript')
    expect(h.items.find((i) => i.kind === 'assignment' && i.tool === 'assign')).toMatchObject({ assignmentId: 'a-9', title: 'Summarise the README' })
    expect(h.items.some((i) => i.kind === 'owner' && i.text === 'Проверь README')).toBe(true)
  })

  it('reads a Codex conversation into the goal history, without its service messages', async () => {
    const { history, repo } = await codexFixture()
    const h = await history.goalHistory(repo, 'g1')
    const words = h.items.flatMap((i) => (i.kind === 'owner' || i.kind === 'lead' ? [`${i.kind}:${i.text}`] : []))
    expect(words).toEqual(expect.arrayContaining(['owner:Нужен раздел Usage', 'lead:Поручу черновик Codex.']))
    expect(words.some((w) => w.includes('environment_context'))).toBe(false)
    expect(h.items.find((i) => i.kind === 'assignment' && i.title === 'Раздел Usage')).toMatchObject({ assignmentId: 'a-2' })
    expect(h.items.some((i) => i.kind === 'assignment' && i.title === 'Чужое')).toBe(false)
  })

  it('merges a Claude Code and a Codex conversation of one goal in time order', async () => {
    const { history, repo } = await codexFixture()
    const h = await history.goalHistory(repo, 'g1')
    expect(h.items.filter((i) => i.kind === 'session').map((i) => (i.kind === 'session' ? i.sessionId : ''))).toEqual(['sess-a', 'sess-b', 'codex-1'])
  })

  it('does not read a Codex session of another folder in full', async () => {
    const { history, repo, readFiles } = await codexFixture()
    await history.goalHistory(repo, 'g1')
    expect(readFiles().filter((f) => f.includes('rollout-elsewhere'))).toEqual([])
  })

  it('does not read an unchanged Codex file again', async () => {
    const { history, repo, reads } = await codexFixture()
    await history.goalHistory(repo, 'g1')
    const first = reads()
    expect(first).toBeGreaterThan(0)
    await history.goalHistory(repo, 'g1')
    expect(reads()).toBe(first)
  })
})

// dsh session lines in the shape dsh 0.1.5 writes them (session.v3, zstd frames; checked on real sessions, 2026-11-02).
const ms = (min: number) => Date.UTC(2026, 10, 2, 10, min)
const dshRows = (repo: string) => [
  { type: 'session', version: 3, id: 'dsh-1', createdAt: ms(50), cwd: repo },
  { type: 'user/message', seq: 1, time: ms(50), data: { content: [{ type: 'text', text: 'Сделай changelog' }] } },
  { type: 'assistant/message', seq: 2, time: ms(51), data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'думаю' }, { type: 'text', text: 'Поручу Codex.' }] } } },
  { type: 'tool/call', seq: 3, time: ms(52), data: { callId: 'd1', name: 'mcp__crewboard__crewboard_assign', arguments: JSON.stringify({ goalId: 'g1', title: 'Changelog', provider: 'codex' }) } },
  { type: 'tool/result', seq: 4, time: ms(52), data: { message: { source: { kind: 'tool', callId: 'd1' }, content: [{ type: 'tool-result', toolCallId: 'd1', content: [{ type: 'text', text: '{"assignmentId":"a-3"}' }] }] } } },
]

describe('dsh transcripts', () => {
  it('reads a dsh conversation, in several zstd frames with a torn tail, into the goal history', async () => {
    const { repo, root } = await fixture()
    const sessions = await mkdtemp(join(tmpdir(), 'cb-dsh-'))
    const dir = join(sessions, '--work-kitchen-app--', 'dsh-1')
    await mkdir(dir, { recursive: true })
    const rows = dshRows(repo).map((r) => `${JSON.stringify(r)}\n`)
    const { zstdCompressSync } = await import('node:zlib')
    const frames = Buffer.concat([zstdCompressSync(rows.slice(0, 2).join('')), zstdCompressSync(rows.slice(2).join('')), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01])])
    await writeFile(join(dir, 'session.v3.jsonl.zstd'), frames)
    const history = createHistory({ env: { CREWBOARD_CLAUDE_PROJECTS: root, CREWBOARD_CODEX_SESSIONS: sessions, CREWBOARD_DSH_SESSIONS: sessions } })
    const h = await history.goalHistory(repo, 'g1')
    const words = h.items.flatMap((i) => (i.kind === 'owner' || i.kind === 'lead' ? [`${i.kind}:${i.text}`] : []))
    expect(words).toEqual(expect.arrayContaining(['owner:Сделай changelog', 'lead:Поручу Codex.']))
    expect(words.some((w) => w.includes('думаю'))).toBe(false)
    expect(h.items.find((i) => i.kind === 'assignment' && i.title === 'Changelog')).toMatchObject({ assignmentId: 'a-3' })
  })
})
