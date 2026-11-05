import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type LaunchInput, type NormEvent, type RawEvent, type Run, type RunBackend, cliModel, normalize, publicText, usageForRun } from '@crewboard/core'
import { failureText } from './failure.js'
import type { RunCost } from '../model/types.js'

/** dsh streams its last answer as `answer_delta` chunks and sends no `result`: the last turn's chunks, joined. */
function streamedAnswer(raw: RawEvent[]): string | undefined {
  const turn = raw.findLastIndex((e) => e.type === 'turn_started')
  const chunks = raw.slice(turn + 1).filter((e) => e.type === 'answer_delta').map((e) => publicText(e.data) ?? '')
  return chunks.length ? chunks.join('') : undefined
}

export type BackendFor = (agent: string) => Promise<RunBackend>
export type PollResult = { events: NormEvent[]; nextIndex: number; terminal: boolean; failed: boolean; narration?: string; reason?: string; text?: string; finalText?: string; usage?: RunCost }
export type Pool = ReturnType<typeof createPool>

/** Launch, read, steer and stop worker runs through core's `RunBackend`, whichever CLI is behind it. */
export function createPool(o: { backendFor: BackendFor; runsDir: string; repo?: string; claudeProjectsDir?: string }) {
  const writePrompt = async (text: string): Promise<string> => {
    await mkdir(o.runsDir, { recursive: true })
    const file = join(o.runsDir, `${randomUUID()}.md`)
    await writeFile(file, text)
    return file
  }
  return {
    async launch(input: Omit<LaunchInput, 'promptFile'> & { prompt: string }): Promise<string> {
      const backend = await o.backendFor(input.agent)
      // A backend that cannot launch read-only is still told so in the prompt.
      const readOnly = input.readOnly === true && backend.readOnlyLaunch === true
      return backend.launch({ agent: input.agent, cwd: input.cwd, promptFile: await writePrompt(input.prompt), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}), ...(readOnly ? { readOnly: true } : {}), ...(input.access && !input.readOnly ? { access: input.access } : {}), ...(input.writableRoots && !input.readOnly ? { writableRoots: input.writableRoots } : {}) })
    },
    async poll(agent: string, runId: string, sinceIndex: number, meta?: { startedAt: string; cwd: string }): Promise<PollResult> {
      const backend = await o.backendFor(agent)
      const [raw, state] = await Promise.all([backend.events(runId), backend.status(runId)])
      const events = normalize(raw, { cwd: meta?.cwd, repo: o.repo })
      // Read narration from the whole feed: later commands and merged streaming chunks must not lose its intent.
      const narration = events.findLast((e) => e.kind === 'message' || e.kind === 'thought')?.text
      const result: PollResult = { events: events.slice(sinceIndex), nextIndex: events.length, terminal: state.terminal, failed: state.terminal && state.status !== 'completed', ...(narration ? { narration } : {}) }
      if (result.failed) {
        result.reason = state.failure?.reason ?? state.status
        if (state.failure?.text) result.text = failureText(state.failure.text)
      }
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
            // On the user's Claude plan, Claude Code's dollar figure is an estimate at API prices, never a charge.
            ...(usage.billing === 'subscription'
              ? { billing: 'subscription' as const, ...(usage.usd !== undefined || usage.apiEquivalentUsd !== undefined ? { apiUsd: usage.apiEquivalentUsd ?? usage.usd } : {}) }
              : {
                  ...(usage.billing === 'api' ? { billing: 'api' as const } : {}),
                  ...(usage.usd !== undefined ? { usd: usage.usd } : {}),
                  ...(usage.apiEquivalentUsd !== undefined ? { apiUsd: usage.apiEquivalentUsd } : {}),
                }),
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
