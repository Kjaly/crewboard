/** Read a renamed Crewboard environment variable, falling back to its ORCH alias. */
export function crewboardEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const suffix = name.startsWith('CREWBOARD_') ? name.slice('CREWBOARD_'.length) : name
  return env[`CREWBOARD_${suffix}`] ?? env[`ORCH_${suffix}`]
}
