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
  return { root, repo, dir, history: createHistory({ env: { CREWBOARD_CLAUDE_PROJECTS: root } }) }
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

