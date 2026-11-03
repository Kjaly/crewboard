import { BUILTIN_AGENTS } from './agents.js'

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_AGENTS.map((a) => a.id))
import type { ProviderId, ResultKind, SystemText } from '../model/types.js'

export type SplitPart = { title: string; criteria: string[]; provider?: ProviderId }
export type WorkerOutcome =
  | { kind: 'report'; summary: string; code?: SystemText }
  | { kind: 'question'; text: string; options: string[] }
  | { kind: 'split'; summary: string; parts: SplitPart[]; code?: SystemText }

const RESULT_RULE: Record<ResultKind, string> = {
  local: 'Work right in this folder and make no commits: the owner reviews the changes.',
  branch: 'Work in the current branch and commit the finished work.',
  answer: 'Change no files. Your result is the answer in your report.',
  decision: 'Change no files. Your result is a decision with its reasons in your report.',
}

/** The prompt a worker receives: the task, why it exists, what counts as done, and how to hand back. */
export function workerPrompt(a: { title: string; criteria: string[]; resultKind: ResultKind; chain: string[]; resumeNote?: string }): string {
  const lines = [
    `# Assignment: ${a.title}`,
    '',
    a.chain.length ? `This is part of: ${a.chain.join(' → ')}.` : '',
    '',
    '## Done when',
    ...(a.criteria.length ? a.criteria.map((c) => `- ${c}`) : ['- The assignment is done as stated.']),
    '',
    '## Result',
    RESULT_RULE[a.resultKind],
    'Write your report and questions in the language the assignment is written in.',
    'Before each notable step, write one short sentence in the assignment’s language saying what you are doing and why, as normal output outside the handback blocks.',
    '',
    '## How to hand back',
    'End your last message with one of these blocks.',
    '',
    'A report, when the work is done:',
    '<crewboard-report>what was done and how to check it</crewboard-report>',
    '',
    'A question, when you cannot go on without an answer (options are optional, one per line after a blank line):',
    '<crewboard-question>question',
    '',
    '- option 1',
    '- option 2</crewboard-question>',
    '',
    'If the work is worth splitting into independent parts, end with a split block. Each part becomes its own assignment, and you continue once they all finish and their results reach you:',
    '<crewboard-split>',
    '- [codex] Part title | criterion; criterion',
    '- Part title without a provider (yours is used) | criterion',
    '</crewboard-split>',
  ]
  if (a.resumeNote) lines.push('', '## Continuing', a.resumeNote)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

const NO_REPORT: WorkerOutcome = { kind: 'report', summary: 'The worker finished without a report', code: 'no_report' }

const TAG = /<crewboard-(report|question|split)>([\s\S]*?)<\/crewboard-\1>/g

/**
 * The worker's last word as a result or a question. Real CLIs forget the format: an answer with no block is the
 * result, whole, so a run never hangs waiting for a tag.
 */
export function parseOutcome(finalText: string, known: ReadonlySet<string> = BUILTIN_IDS): WorkerOutcome {
  const matches = [...finalText.matchAll(TAG)]
  const last = matches.at(-1)
  if (!last) {
    const summary = finalText.trim()
    return summary ? { kind: 'report', summary } : NO_REPORT
  }
  const body = (last[2] ?? '').trim()
  if (last[1] === 'split') {
    const parts = body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => parsePart(l, known)).filter((p): p is SplitPart => p !== undefined)
    const summary = finalText.slice(0, last.index).replace(TAG, '').trim()
    return summary ? { kind: 'split', summary, parts } : { kind: 'split', summary: 'The work is split into parts', parts, code: 'split' }
  }
  if (last[1] === 'report') return body ? { kind: 'report', summary: body } : NO_REPORT
  const [head = '', ...rest] = body.split(/\n\s*\n/)
  const options = rest.join('\n').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean)
  return { kind: 'question', text: head.trim(), options }
}

/** One split line: `- [provider] Title | criterion; criterion`. An unknown provider is dropped: the parent's applies. */
function parsePart(line: string, known: ReadonlySet<string>): SplitPart | undefined {
  let rest = line.slice(2).trim()
  let provider: ProviderId | undefined
  const tagged = /^\[([a-z0-9][a-z0-9._-]*)\]\s*/i.exec(rest)
  if (tagged) {
    rest = rest.slice(tagged[0].length)
    if (known.has(tagged[1] ?? '')) provider = tagged[1] as ProviderId
  }
  const [title = '', criteria = ''] = rest.split('|')
  if (!title.trim()) return undefined
  return { title: title.trim(), criteria: criteria.split(';').map((c) => c.trim()).filter(Boolean), ...(provider ? { provider } : {}) }
}
