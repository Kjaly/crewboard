/** Saved aliases for direct workers. */
export const PROFILE_ALIASES: Record<string, string> = {
  codex: 'codex/gpt-6-astra',
  'codex-gpt-6-astra': 'codex/gpt-6-astra',
  'codex-gpt-6-sol': 'codex/gpt-6-sol',
  'codex-gpt-6-luna': 'codex/gpt-6-luna',
  'codex-gpt-5.6-sol': 'codex/gpt-5.6-sol',
  'codex-gpt-5.6-terra': 'codex/gpt-5.6-terra',
  'codex-gpt-5.6-luna': 'codex/gpt-5.6-luna',
  'claude-opus': 'claude/opus',
  'claude-fable': 'claude/fable',
}

export const canonicalWorkerId = (id: string, aliases: Record<string, string> = PROFILE_ALIASES): string => aliases[id] ?? id
export const workerAliases = (id: string, aliases: Record<string, string> = PROFILE_ALIASES): string[] => [id, ...Object.keys(aliases).filter((alias) => aliases[alias] === id)]
