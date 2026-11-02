import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type NormEvent, type RawEvent, type Run, type RunBackend, cliModel, normalize, publicText, usageForRun } from '@crewboard/core'
import type { RunCost } from '../model/types.js'

/** dsh streams its last answer as `answer_delta` chunks and sends no `result`: the last turn's chunks, joined. */
function streamedAnswer(raw: RawEvent[]): string | undefined {
  const turn = raw.findLastIndex((e) => e.type === 'turn_started')
  const chunks = raw.slice(turn + 1).filter((e) => e.type === 'answer_delta').map((e) => publicText(e.data) ?? '')
  return chunks.length ? chunks.join('') : undefined
}

export type BackendFor = (agent: string) => Promise<RunBackend>
export type PollResult = { events: NormEvent[]; nextIndex: number; terminal: boolean; failed: boolean; reason?: string; finalText?: string; usage?: RunCost }
export type Pool = ReturnType<typeof createPool>

/** Launch, read, steer and stop worker runs through core's `RunBackend`, whichever CLI is behind it. */
export function createPool(o: { backendFor: BackendFor; runsDir: string; claudeProjectsDir?: string }) {
  const writePrompt = async (text: string): Promise<string> => {
    await mkdir(o.runsDir, { recursive: true })
    const file = join(o.runsDir, `${randomUUID()}.md`)
    await writeFile(file, text)
    return file
  }
  return {
    async launch(input: { agent: string; cwd: string; prompt: string }): Promise<string> {
      const backend = await o.backendFor(input.agent)
      return backend.launch({ agent: input.agent, cwd: input.cwd, promptFile: await writePrompt(input.prompt) })
    },
    async poll(agent: string, runId: string, sinceIndex: number, meta?: { startedAt: string; cwd: string }): Promise<PollResult> {
      const backend = await o.backendFor(agent)
      const [raw, state] = await Promise.all([backend.events(runId), backend.status(runId)])
      const events = normalize(raw)
      const result: PollResult = { events: events.slice(sinceIndex), nextIndex: events.length, terminal: state.terminal, failed: state.terminal && state.status !== 'completed' }
      if (result.failed) result.reason = state.failure?.reason ?? state.status
      if (state.terminal) {
        // CLI backends close a turn with `result`; dsh and older runners with `final`.
        const final = raw.findLast((e) => e.type === 'result' || e.type === 'final')
        const text = final ? publicText(final.data) : streamedAnswer(raw)
        if (text !== undefined) result.finalText = text
        // Core's rule: the backend's own figures, an API-price estimate for Codex, Claude's transcript as a fallback.
        const model = cliModel(agent)
        const run = { runId, agent, ...(model ? { model } : {}), startedAt: meta?.startedAt ?? '', ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}) } as Run
        const usage = await usageForRun(backend, run, meta?.cwd, o.claudeProjectsDir ?? '').catch(() => undefined)
        if (usage) {
          const cost: RunCost = {
            ...(usage.inputTokens ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens ? { outputTokens: usage.outputTokens } : {}),
            ...(usage.usd !== undefined ? { usd: usage.usd } : {}),
            ...(usage.apiEquivalentUsd !== undefined ? { apiUsd: usage.apiEquivalentUsd } : {}),
          }
          if (Object.keys(cost).length) result.usage = cost
        }
      }
      return result
    },
    async steer(agent: string, runId: string, text: string): Promise<'delivered' | 'ended'> {
      const backend = await o.backendFor(agent)
      if ((await backend.status(runId)).terminal) return 'ended'
      await backend.steer(runId, await writePrompt(text), 'queue')
      return 'delivered'
    },
    async cancel(agent: string, runId: string): Promise<void> {
      await (await o.backendFor(agent)).cancel(runId)
    },
  }
}
