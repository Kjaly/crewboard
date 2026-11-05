import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RESULT_KINDS } from '../model/types.js'
import { leadCall } from './call.js'
import type { LeadClient } from './clients.js'
import type { LeadCommands } from './commands.js'

/** The package version, injected by the build; tests run from source and see 'dev'. */
declare const __CREWBOARD_VERSION__: string | undefined
const VERSION = typeof __CREWBOARD_VERSION__ === 'string' ? __CREWBOARD_VERSION__ : 'dev'

export const LEAD_INSTRUCTIONS = `Crewboard runs work you hand out to other coding agents and shows the owner a live map of it. crewboard_agents lists who you can hand work to. crewboard_goals lists project goals and their progress.
Use presets from crewboard_agents: cheap for routine work, normal for everyday coding, hard for difficult reasoning, review for an independent review. User presets may override or disable these.
How to lead:
1. Agree with the owner on what they want and the criteria for done. Then call crewboard_start_goal, and crewboard_assign for each piece of work, passing the owner's message that asked for it in \`quote\`. Pass \`project\` = the absolute path of the repository you are working in.
2. Keep \`crewboard wait --project <that path>\` running in the background (a background Bash command). When it exits, call crewboard_inbox and act on every event, then start the wait again. crewboard_inbox returns every event you have not confirmed; calling it again confirms the previous batch. When you take over after another lead chat, call crewboard_inbox first.
3. A worker question: answer it yourself with crewboard_answer when you can. When only the owner can decide (taste, scope, money), call crewboard_escalate with \`why\` and tell the owner in chat.
4. A worker result: check it against the criteria. Close it with crewboard_close, or send it back with crewboard_return and a note. The owner does not accept work; you do.
5. The owner may ask for something on a node from the screen (clarify, stop, hand off, start now, reopen, discuss): it arrives in your inbox as owner_requested. Decide with crewboard_decide_request; accepting carries it out, declining needs a reason the owner will read. Withdrawn requests cannot be decided; request_withdrawn and failed request_completed outcomes arrive in your inbox, and execution failure returns an error.
6. When the owner changes course, cancel branches that no longer serve the goal with crewboard_cancel and a reason.
7. When the goal criteria are met, close the goal itself with crewboard_close, assignmentId = goalId and a summary; if the goal is no longer needed, use crewboard_cancel with the same id. A goal_idle inbox event reminds you when all work under the goal is finished: close it if the criteria are met, or assign more work.
Your decision is final; the owner argues with you in chat, not through Crewboard.`

const target = { project: z.string(), goalId: z.string(), assignmentId: z.string() }
type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const wrap = (fn: () => Promise<unknown>) => async (): Promise<Result> => {
  try {
    const value = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(value ?? { ok: true }) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
  }
}

/** One MCP server per lead session, all calling the same commands. */
export function createLeadMcp(commands: LeadCommands, session: string = randomUUID()): McpServer {
  const server = new McpServer({ name: 'crewboard', version: VERSION }, { instructions: LEAD_INSTRUCTIONS })
  // One server per MCP session (server.ts): its inbox batches are confirmed by its own next call and released when it ends.
  // The transport's session id is passed in, so the server can note this session's every request as activity.
  // Who this session's lead is, as its client named itself at `initialize`; unnamed clients stay anonymous.
  const clientOf = (): LeadClient | undefined => {
    const info = server.server.getClientVersion()
    return info?.name ? { client: info.name, ...(info.version ? { version: info.version } : {}) } : undefined
  }
  server.server.onclose = () => commands.releaseSession(session)
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema }, ((args: z.infer<z.ZodObject<S>>) => leadCall.run(clientOf(), () => wrap(() => fn(args))())) as never)

  tool('crewboard_start_goal', 'Start a goal the owner agreed on. Returns its goalId.', { project: z.string(), title: z.string(), criteria: z.array(z.string()), quote: z.string().optional() }, (a) => commands.startGoal(a))
  tool('crewboard_agents', 'Returns { agents, presets }. Each preset names an agent and optional model/effort/access/note; access (network: sandbox plus network, full: no sandbox) is set by the owner and applies to Codex workers that change files. The agents you can hand work to: id (pass it as provider), label, how it runs, its default model, suggested models, catalog (up to 30 models, discovered first; source, discoveredAt, optional not_listed status, USD pricing per million prompt/completion tokens, tools support and effort levels where the CLI reports them), accepted effort levels (empty when it takes none), defaultEffort (null means the CLI default), and whether it can run read-only. readOnlyReason=dsh_unprotected means dsh answer/decision runs can still write files; ACP permission rejection does not protect every tool.', {}, () => commands.agents())
  tool('crewboard_assign', 'Hand a piece of work to a worker. Pass preset instead of provider, or provider: an agent id from crewboard_agents. Explicit model and effort override the preset. model and effort optionally override its defaults; models are suggestions, while effort must be one of that agent’s efforts and must be omitted when the list is empty. parentId defaults to the goal; after lists assignments that must be done first.', {
    project: z.string(), goalId: z.string(), parentId: z.string().optional(), title: z.string(), criteria: z.array(z.string()),
    resultKind: z.enum(RESULT_KINDS), provider: z.string().min(1).optional(), preset: z.string().min(1).optional(), model: z.string().min(1).optional(), effort: z.string().optional(), quote: z.string().optional(), after: z.array(z.string()).optional(), branch: z.string().optional(), writableRoots: z.array(z.string()).optional(),
  }, (a) => commands.assign(a))
  tool('crewboard_inbox', 'Everything workers and the owner sent you that you have not confirmed. Calling it again confirms the previous batch: act on every event first.', { project: z.string() }, (a) => commands.inbox(a, session))
  tool('crewboard_answer', "Answer a worker's question; the worker continues with it.", { ...target, text: z.string() }, (a) => commands.answer(a))
  tool('crewboard_escalate', "Raise a worker's question to the owner. why: why you could not decide yourself.", { ...target, why: z.string(), text: z.string().optional(), options: z.array(z.string()).optional() }, (a) => commands.escalate(a))
  tool('crewboard_steer', 'Add a clarification to work in progress.', { ...target, text: z.string() }, (a) => commands.steer(a))
  tool('crewboard_return', 'Send a result back to its worker with a note.', { ...target, note: z.string() }, (a) => commands.returnWork(a))
  tool('crewboard_close', 'Close work that meets its criteria. assignmentId may be goalId to close the goal itself.', { ...target, summary: z.string() }, (a) => commands.close(a))
  tool('crewboard_cancel', 'Cancel an assignment and everything under it, stopping their runs. assignmentId may be goalId to cancel the goal itself.', { ...target, reason: z.string() }, (a) => commands.cancel(a))
  tool('crewboard_decide_request', "Decide the owner's request on an assignment. Accepting carries it out; declining needs a reason the owner will read. Withdrawn requests cannot be decided; request_withdrawn and failed request_completed outcomes arrive in your inbox, and execution failure returns an error. Your decision is final.", { ...target, requestId: z.string(), decision: z.enum(['accepted', 'declined']), reason: z.string().optional() }, (a) => commands.decideRequest(a))
  tool('crewboard_goals', 'List the project goals and their status counts.', { project: z.string() }, (a) => commands.goals(a))
  tool('crewboard_status', 'The goal as a tree with every assignment status and what it is doing now.', { project: z.string(), goalId: z.string() }, (a) => commands.status(a))
  tool('crewboard_adopt_goal', 'Take over a goal another chat started, for example after the previous lead chat ended.', { project: z.string(), goalId: z.string() }, (a) => commands.adopt(a))
  return server
}
