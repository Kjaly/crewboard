import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PROVIDERS, RESULT_KINDS } from '../model/types.js'
import type { LeadCommands } from './commands.js'

/** The package version, injected by the build; tests run from source and see 'dev'. */
declare const __CREWBOARD_VERSION__: string | undefined
const VERSION = typeof __CREWBOARD_VERSION__ === 'string' ? __CREWBOARD_VERSION__ : 'dev'

export const LEAD_INSTRUCTIONS = `Crewboard runs work you hand out to other coding agents (Claude, Codex, DeepSeek) and shows the owner a live map of it.
How to lead:
1. Agree with the owner on what they want and the criteria for done. Then call crewboard_start_goal, and crewboard_assign for each piece of work, passing the owner's message that asked for it in \`quote\`. Pass \`project\` = the absolute path of the repository you are working in.
2. Keep \`crewboard wait --project <that path>\` running in the background (a background Bash command). When it exits, call crewboard_inbox and act on every event, then start the wait again.
3. A worker question: answer it yourself with crewboard_answer when you can. When only the owner can decide (taste, scope, money), call crewboard_escalate with \`why\` and tell the owner in chat.
4. A worker result: check it against the criteria. Close it with crewboard_close, or send it back with crewboard_return and a note. The owner does not accept work; you do.
5. The owner may ask for something on a node from the screen (clarify, stop, hand off, start now, reopen, discuss): it arrives in your inbox as owner_requested. Decide with crewboard_decide_request; accepting carries it out, declining needs a reason the owner will read.
6. When the owner changes course, cancel branches that no longer serve the goal with crewboard_cancel and a reason.
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
export function createLeadMcp(commands: LeadCommands): McpServer {
  const server = new McpServer({ name: 'crewboard', version: VERSION }, { instructions: LEAD_INSTRUCTIONS })
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema }, ((args: z.infer<z.ZodObject<S>>) => wrap(() => fn(args))()) as never)

  tool('crewboard_start_goal', 'Start a goal the owner agreed on. Returns its goalId.', { project: z.string(), title: z.string(), criteria: z.array(z.string()), quote: z.string().optional() }, (a) => commands.startGoal(a))
  tool('crewboard_assign', 'Hand a piece of work to a worker. parentId defaults to the goal; after lists assignments that must be done first.', {
    project: z.string(), goalId: z.string(), parentId: z.string().optional(), title: z.string(), criteria: z.array(z.string()),
    resultKind: z.enum(RESULT_KINDS), provider: z.enum(PROVIDERS), model: z.string().optional(), quote: z.string().optional(), after: z.array(z.string()).optional(),
  }, (a) => commands.assign(a))
  tool('crewboard_inbox', 'Read and acknowledge everything workers and the owner sent you since the last call.', { project: z.string() }, (a) => commands.inbox(a))
  tool('crewboard_answer', "Answer a worker's question; the worker continues with it.", { ...target, text: z.string() }, (a) => commands.answer(a))
  tool('crewboard_escalate', "Raise a worker's question to the owner. why: why you could not decide yourself.", { ...target, why: z.string(), text: z.string().optional(), options: z.array(z.string()).optional() }, (a) => commands.escalate(a))
  tool('crewboard_steer', 'Add a clarification to work in progress.', { ...target, text: z.string() }, (a) => commands.steer(a))
  tool('crewboard_return', 'Send a result back to its worker with a note.', { ...target, note: z.string() }, (a) => commands.returnWork(a))
  tool('crewboard_close', 'Close work that meets its criteria.', { ...target, summary: z.string() }, (a) => commands.close(a))
  tool('crewboard_cancel', 'Cancel an assignment and everything under it, stopping their runs.', { ...target, reason: z.string() }, (a) => commands.cancel(a))
  tool('crewboard_decide_request', "Decide the owner's request on an assignment. Accepting carries it out; declining needs a reason the owner will read. Your decision is final.", { ...target, requestId: z.string(), decision: z.enum(['accepted', 'declined']), reason: z.string().optional() }, (a) => commands.decideRequest(a))
  tool('crewboard_status', 'The goal as a tree with every assignment status and what it is doing now.', { project: z.string(), goalId: z.string() }, (a) => commands.status(a))
  tool('crewboard_adopt_goal', 'Take over a goal another chat started, for example after the previous lead chat ended.', { project: z.string(), goalId: z.string() }, (a) => commands.adopt(a))
  return server
}
