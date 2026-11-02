import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import type { TranscriptItem } from './transcript.js'

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const textOf = (content: unknown): string => list(content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
const parseArgs = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v) as unknown
  } catch {
    return {}
  }
}

const FRAME = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Everything a session file decodes to. dsh appends one zstd frame per write, and Node's decoders stop after the first
 * frame, so the file is cut at frame signatures and each piece decoded on its own. A piece that fails to decode is
 * either a signature that occurred inside compressed data (decoded together with the next piece) or a last frame still
 * being written (dropped).
 */
async function decode(file: string, firstOnly = false): Promise<string> {
  const buf = await readFile(file)
  const starts: number[] = []
  for (let i = buf.indexOf(FRAME); i !== -1; i = buf.indexOf(FRAME, i + FRAME.length)) starts.push(i)
  let out = ''
  for (let k = 0; k < starts.length && !(firstOnly && out); ) {
    let next = k + 1
    for (; next <= starts.length; next++) {
      try {
        out += zstdDecompressSync(buf.subarray(starts[k], starts[next] ?? buf.length)).toString('utf8')
        break
      } catch {
        // Not a whole frame yet: take the next piece too.
      }
    }
    k = next
  }
  return out
}

/**
 * One dsh session (`session.v3.jsonl.zstd`), read into the same items as a Claude Code transcript. The format is
 * undocumented (checked on dsh 0.1.5, 2026-11-02): a `session` line names it and its working folder; `user/message`,
 * `assistant/message`, `tool/call` and `tool/result` carry the conversation, with MCP tools named
 * `mcp__<server>__<tool>`. Anything unexpected is skipped, never thrown.
 */
export async function readDshSession(file: string): Promise<{ sessionId: string; cwd?: string; items: TranscriptItem[] }> {
  let sessionId = ''
  let cwd: string | undefined
  const items: TranscriptItem[] = []
  for (const line of (await decode(file)).split('\n')) {
    let e: Json
    try {
      e = obj(JSON.parse(line))
    } catch {
      continue
    }
    const d = obj(e.data)
    const ts = typeof e.time === 'number' ? new Date(e.time).toISOString() : ''
    if (e.type === 'session') {
      if (typeof e.id === 'string') sessionId = e.id
      if (typeof e.cwd === 'string') cwd = e.cwd
    } else if (e.type === 'user/message') {
      const text = textOf(d.content).trim()
      if (text) items.push({ kind: 'owner', ts, text, uuid: `${sessionId}:${String(e.seq ?? items.length)}` })
    } else if (e.type === 'assistant/message') {
      const text = textOf(obj(d.message).content).trim()
      if (text) items.push({ kind: 'lead', ts, text, uuid: `${sessionId}:${String(e.seq ?? items.length)}` })
    } else if (e.type === 'tool/call' && typeof d.name === 'string') {
      items.push({ kind: 'tool', ts, name: d.name, toolUseId: String(d.callId ?? ''), input: parseArgs(d.arguments) })
    } else if (e.type === 'tool/result') {
      const message = obj(d.message)
      const callId = String(obj(message.source).callId ?? '')
      const text = list(message.content).map((r) => textOf(r.content)).join('')
      items.push({ kind: 'tool_result', ts, toolUseId: callId, text })
    }
  }
  return { sessionId: sessionId || file, ...(cwd ? { cwd } : {}), items }
}

/** The working folder a dsh session belongs to, from its first frame alone: enough to skip other folders' sessions. */
export async function dshSessionCwd(file: string): Promise<string | undefined> {
  try {
    // Only the first frame: some Node releases refuse a buffer whose last frame is still being written.
    const first = (await decode(file, true)).split('\n', 1)[0] ?? ''
    const e = obj(JSON.parse(first))
    return e.type === 'session' && typeof e.cwd === 'string' ? e.cwd : undefined
  } catch {
    return undefined
  }
}
