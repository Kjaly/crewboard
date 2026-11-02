import type { ProviderId } from '../model/types.js'

/**
 * The core agent id each provider runs as: Claude and Codex through their own CLIs, DeepSeek through dsh, its
 * native agent harness. A model is always named: an unregistered id without one resolves to the CLI model
 * `default`, which Codex on a ChatGPT account refuses (found in the live check, 2026-11-02).
 */
const PREFIX: Record<ProviderId, string> = { claude: 'claude', codex: 'codex', deepseek: 'dsh' }
const DEFAULT_MODEL: Record<ProviderId, string> = { claude: 'sonnet', codex: 'gpt-6.1-sol', deepseek: 'deepseek-flash' }

export const agentFor = (provider: ProviderId, model?: string): string => `${PREFIX[provider]}/${model || DEFAULT_MODEL[provider]}`
