// Structural shapes of the dsh host APIs this plugin uses (dsh 0.1.5). Declared locally on purpose:
// the host bundle must not import @deepseek-ai/* at runtime or for types (a linked checkout would load
// foreign copies of those packages).
import type { IncomingMessage, ServerResponse } from 'node:http'

export type Disposer = () => void
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
export type Route = { kind: 'exact' | 'prefix'; path: string; handler: RouteHandler }
export type WebServerFace = { register(route: Route): Disposer }
export type ContentBlock = { type: 'text'; text: string }
export type DshToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): ContentBlock[] }
  /** dsh passes the call as the second argument; `agent.id` is the calling session's id. */
  execute(args: Record<string, unknown>, exec?: { agent?: { id?: string } }): Promise<unknown>
}
export type ToolsFace = { register(definition: DshToolDefinition): Disposer }
export type SystemPromptFace = { section(section: { name: string; order: number; text: string }): Disposer }

/** `ctx.sessionController` (@deepseek-ai/dsh-api-session-controller), the face the plan chat uses. */
export type SessionControllerFace = {
  modelCatalog?(): Promise<{ groups: unknown[]; failures: unknown[] }>
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: ContentBlock[] }, signal: AbortSignal): Promise<{ accepted: true }>
  inspect(sessionId: string, signal?: AbortSignal): Promise<unknown>
}

/** Services are optional: they appear only for the injections `apply` requests, each dispose clears its slot. */
export type HostContext = {
  effect(fn: () => Disposer | undefined, label?: string): void
  inject(names: string[], fn: (child: HostContext) => void): void
  tools: ToolsFace
  systemPrompt: SystemPromptFace
  webServer?: WebServerFace
  sessionController?: SessionControllerFace
  /** Host settings service; intentionally distinct from the client-only locale service. */
  settings?: { get?(namespace: string): unknown }
}
