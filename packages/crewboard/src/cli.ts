/** The value after `--<name>` in the command line, if any. */
export const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** `--port`: the fallback when absent, undefined when it is not a TCP port, so the command can refuse it plainly. */
export const portOf = (args: string[], fallback: number): number | undefined => {
  // `--port=5000` is refused rather than ignored: the user named a port.
  if (args.some((a) => a.startsWith('--port='))) return undefined
  if (!args.includes('--port')) return fallback
  const text = flag(args, 'port') ?? ''
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN
  return port >= 1 && port <= 65_535 ? port : undefined
}

/** `10m`, `30s`, `500ms`, `1h` or bare seconds; anything else is the fallback. */
export const duration = (text: string | undefined, fallbackMs: number): number => {
  const m = text ? /^(\d+)(ms|s|m|h)?$/.exec(text) : null
  if (!m) return fallbackMs
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']
}
