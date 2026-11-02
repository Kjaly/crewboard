import type { Strings } from './ru.js'

const s = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Every visible string of the screen in English, in the same shape as the Russian dictionary. */
export const en: Strings = {
  locale: 'en-US',
  switchLang: 'Переключить на русский',
  langCode: 'RU',
  meInitial: 'Me',
  event: {
    goal_started: 'Goal set',
    assigned: 'Assigned',
    run_started: 'Worker started',
    question: (t) => `Question: ${t}`,
    escalated: (why) => `The lead passed the question to you: ${why}`,
    answeredByYou: (t) => `You answered: ${t}`,
    answeredByLead: (t) => `The lead answered: ${t}`,
    steered: (t) => `Clarification: ${t}`,
    reported: (t) => `Result: ${t}`,
    returned: (t) => `Returned: ${t}`,
    failed: (t) => `Run failed: ${t}`,
    closed: (t) => `Closed: ${t}`,
    cancelled: (t) => `Cancelled: ${t}`,
    adopted: 'A new lead took over the goal',
  },
  doing: (d) => {
    switch (d.kind) {
      case 'text': return d.text
      case 'done': return 'Done'
      case 'cancelled': return `Cancelled: ${d.code ? en.system(d.code, d.detail) : d.reason}`.trim()
      case 'system': return en.system(d.code, d.detail)
      case 'abandoned': return 'Abandoned: the owner no longer leads this work'
      case 'paused': return 'Paused: the lead is offline'
      case 'waiting_owner': return 'Waiting for your answer'
      case 'returned': return `Returned: ${d.note}`
      case 'asking': return `Asking: ${d.text}`
      case 'after': return `Starts after: ${d.titles.join(', ')}`
      case 'queued': return 'Queued'
      case 'leading': return 'The lead is leading the goal'
      case 'failed': return `Run failed: ${d.reason ?? 'unknown reason'}`
      case 'reported': return 'Reported a result, awaiting a decision'
      case 'reported_to_parent': return 'Reported; the parent checks it'
      case 'working': return 'Working'
      case 'children': return `Waiting for its assignments: ${d.done} of ${d.total} done`
    }
  },
  system: (code, detail = '') => {
    switch (code) {
      case 'emergency_stop': return 'emergency stop by the owner'
      case 'owner_stop': return "stopped at the owner's request"
      case 'run_failed': return `run failed: ${detail || 'unknown reason'}`
      case 'parent_cancelled': return `a branch above was cancelled: ${detail}`
      case 'no_report': return 'The worker finished without a report'
      case 'split': return 'The work is split into parts'
      case 'split_truncated': return `The split was cut short: ${detail} parts beyond the limit were dropped`
      case 'split_registry': return `Agent tags in the split were ignored, the agent registry cannot be read: ${detail}`
    }
  },
  appTitle: 'Crewboard',
  tabs: { now: 'Now', history: 'History', analytics: 'Analytics', soon: 'Coming in the next update' },
  summary: 'Summary',
  noData: 'no data',
  bySubscription: 'by subscription',
  analyticsHint: 'For looking back after the work: who was busy, what ran in parallel, what it cost.',
  analyticsEmpty: 'No runs yet.',
  costsByProvider: 'Costs by provider',
  costsByAssignment: 'Costs by assignment',
  costCols: { who: 'Provider', what: 'Assignment', runs: 'Runs', money: 'Money', api: 'At API prices', tokens: 'Tokens: in / out' },
  you: 'You',
  openInHistory: 'Open in history',
  historyUnavailable: 'The full conversation is unavailable: no transcript of the lead was found.',
  historyFromJournal: "The lead's conversation is not available: this is the course of the work from Crewboard's journal.",
  historyTruncated: 'Showing the latest part of a long conversation.',
  historySession: (when) => `Conversation with the lead · ${when}`,
  actionsCount: (n) => `${n} ${s(n, 'action', 'actions')}`,
  historyTool: { start_goal: 'Goal set', adopt_goal: 'Goal taken over', close: 'Work closed', cancel: 'Work cancelled', escalate: 'Question passed to you', answer: 'Answer to the worker', steer: 'Clarification to the worker', return: 'Work returned', decide_request: 'Decision on your request', status: 'The lead looked at the tree', inbox: 'The lead read the inbox' },
  sidebar: 'Projects and goals',
  goalsButton: 'Goals',
  waitingN: (n) => `${n} waiting for you`,
  inWork: (n) => `${n} in progress`,
  allFinished: 'all finished',
  leadAway: 'lead is offline',
  waitingYou: (n) => `${n} waiting for you`,
  waitingLead: (n) => `${n} waiting for the lead`,
  running: (n) => `${n} running`,
  queued: (n) => `${n} queued`,
  finished: (n) => `${n} finished`,
  askButton: 'Waiting for you',
  theme: 'Switch theme',
  offline: 'No connection to the server. Reconnecting…',
  loading: 'Loading…',
  projects: 'Projects',
  goals: 'Goals',
  tree: 'Assignments',
  context: 'Assignment context',
  finishedGroup: (n) => `Finished ${n}`,
  close: 'Close',
  origin: 'Where it came from',
  originByWorker: 'The worker split this part of the work off itself.',
  criteria: 'Done when',
  inside: 'Assignments inside',
  history: 'History',
  workdir: 'Working folder',
  assignedBy: 'Assigned by',
  lead: 'Lead',
  emptyTitle: 'Connect your lead',
  emptyText: 'No goals yet. Connect Crewboard to your main agent chat — Claude Code, Codex, dsh or any MCP client — and ask it to set a goal.',
  connectWith: 'Lead client',
  workersTitle: 'Workers',
  workerReady: 'ready',
  workerNotReady: 'not ready:',
  connectClient: { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', other: 'Other client' },
  connectHint: {
    claude: 'Run in a terminal:',
    codex: 'Run in a terminal:',
    dsh: 'Add to your dsh profile (the @deepseek-ai/dsh-mcp-client module):',
    other: 'MCP server address, Streamable HTTP:',
  },
  copy: 'Copy',
  copied: 'Copied',
  question: { via: 'The lead could not decide alone', own: 'Your own answer', send: 'Answer', placeholder: 'Write an answer for the worker', failed: 'The answer was not sent. Check the connection and try again.' },
  status: { queued: 'Queued', running: 'Running', waiting_answer: 'Waiting for the lead', waiting_owner: 'Waiting for you', reported: 'Reported', done: 'Done', cancelled: 'Cancelled', abandoned: 'Abandoned', paused: 'Paused' },
  action: { clarify: 'Clarify', stop: 'Stop', handoff: 'Hand over', start_now: 'Start sooner', cancel: 'Cancel', reopen: 'Reopen', revive: 'Bring back', discuss: 'Discuss with the lead' },
  actionVerb: { clarify: 'clarify', stop: 'stop', handoff: 'hand over', start_now: 'start sooner', cancel: 'cancel', reopen: 'reopen', revive: 'bring back', discuss: 'discuss' },
  emergencyStop: 'Emergency stop',
  emergencyConfirm: 'Yes, stop it now',
  emergencyHint: 'Stops at once, without the lead. The lead hears about it in its inbox.',
  leadAwayHint: 'The lead is offline: there may be no answer to a request; the emergency stop works now.',
  actions: 'Actions',
  actionText: 'What to tell the lead',
  actionSend: 'Send',
  handoffTo: 'Hand over to',
  requestPending: (verb) => `Requested: ${verb}. The lead is deciding`,
  requestDeclined: (reason) => `The lead declined: ${reason}`,
  requestFailed: 'The request was not sent. Check the connection and try again.',
  discussCopied: 'Message for the lead copied',
  discussPrompt: (title, goalId, id) => `Let's discuss the assignment "${title}" (${goalId}/${id}): `,
  provider: { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', lead: 'Lead' },
}
