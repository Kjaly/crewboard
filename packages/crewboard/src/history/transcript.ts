import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

export type TranscriptItem =
  | { kind: 'owner'; ts: string; text: string; uuid: string }
  | { kind: 'lead'; ts: string; text: string; uuid: string }
  | { kind: 'tool'; ts: string; name: string; toolUseId: string; input: unknown }
  | { kind: 'tool_result'; ts: string; toolUseId: string; text: string }

// Text Claude Code itself injects into the owner's turn: not the owner's words.
const INJECTED = /<(system-reminder|local-command-[a-z-]+|command-[a-z-]+|task-notification|agent-message|ide_selection|ide_opened_file)\b[^>]*>[\s\S]*?<\/\1>/g
const clean = (text: string) => text.replace(INJECTED, '').trim()

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
const blockText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: Block) => (typeof b?.text === 'string' ? b.text : '')).join('')
  return ''
}

/**
 * One Claude Code transcript, read line by line. The format is undocumented: anything unexpected (a line that is not
 * JSON, an unknown type, an odd content shape) is skipped, never thrown.
 */
export async function readTranscript(file: string): Promise<{ sessionId: string; items: TranscriptItem[] }> {
  const items: TranscriptItem[] = []
  let sessionId = basename(file, '.jsonl')
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    let row: { type?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; timestamp?: string; uuid?: string; sessionId?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    // Side chains are subagents; isMeta lines are text Claude Code injects (skill bodies, images, messages from other
    // sessions); a compact summary restates an earlier conversation. None of them is the owner speaking.
    if (!row || typeof row !== 'object' || row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) continue
    if (typeof row.sessionId === 'string') sessionId = row.sessionId
    const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
    const uuid = typeof row.uuid === 'string' ? row.uuid : ''
    const content = row.message?.content
    if (row.type === 'user') {
      if (typeof content === 'string') {
        const text = clean(content)
        if (text) items.push({ kind: 'owner', ts, text, uuid })
        continue
      }
      if (!Array.isArray(content)) continue
      const words = clean(content.filter((b: Block) => b?.type === 'text').map((b: Block) => b.text ?? '').join('\n'))
      if (words) items.push({ kind: 'owner', ts, text: words, uuid })
      for (const b of content as Block[]) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') items.push({ kind: 'tool_result', ts, toolUseId: b.tool_use_id, text: blockText(b.content) })
      }
      continue
    }
    if (row.type === 'assistant' && Array.isArray(content)) {
      let words = ''
      const flush = () => {
        if (words.trim()) items.push({ kind: 'lead', ts, text: words.trim(), uuid })
        words = ''
      }
      for (const b of content as Block[]) {
        if (b?.type === 'text' && typeof b.text === 'string') words += (words ? '\n' : '') + b.text
        else if (b?.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
          flush()
          items.push({ kind: 'tool', ts, name: b.name, toolUseId: b.id, input: b.input })
        }
      }
      flush()
    }
  }
  return { sessionId, items }
}
