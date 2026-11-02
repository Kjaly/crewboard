import type { GoalEvent } from '../model/types.js'
import type { HistoryItem } from './sessions.js'

/** What the lead did, as the history's milestone tools name it. */
const LEAD_TOOL: Partial<Record<GoalEvent['type'], string>> = {
  escalated: 'escalate', closed: 'close', cancelled: 'cancel', returned: 'return', steered: 'steer', answered: 'answer', request_decided: 'decide_request',
}

/**
 * The course of a goal from Crewboard's own journal, for a lead whose conversation cannot be read: the owner's words
 * Crewboard saw (the goal's quote, answers, requests), the lead's assignments and decisions, and each takeover.
 */
export function journalHistory(events: GoalEvent[]): HistoryItem[] {
  const titles = new Map<string, string>()
  const items: HistoryItem[] = []
  for (const e of events) {
    if (e.type === 'assigned') titles.set(e.assignmentId, e.title)
    const title = titles.get(e.assignmentId)
    const card = (tool: string): HistoryItem => ({ kind: 'assignment', ts: e.ts, tool, goalId: e.goalId, assignmentId: e.assignmentId, ...(title ? { title } : {}) })
    if (e.type === 'goal_started' && e.quote) items.push({ kind: 'owner', ts: e.ts, text: e.quote })
    else if (e.type === 'assigned' && e.actor === 'lead') items.push(card('assign'))
    else if (e.type === 'adopted') items.push({ kind: 'session', ts: e.ts, sessionId: e.client ?? 'lead' })
    else if (e.actor === 'owner' && e.type === 'answered') items.push({ kind: 'owner', ts: e.ts, text: e.text })
    else if (e.actor === 'owner' && e.type === 'owner_requested' && e.text) items.push({ kind: 'owner', ts: e.ts, text: e.text })
    else if (e.actor === 'lead' && LEAD_TOOL[e.type]) items.push(card(LEAD_TOOL[e.type] as string))
  }
  return items
}
