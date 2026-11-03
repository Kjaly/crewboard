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

/** `--open`: open the screen once the server listens. */
export const openRequested = (args: string[]): boolean => args.includes('--open')

/** The command that opens `url` in the default browser; `cmd` takes the empty title `start` expects. */
export const openerFor = (platform: NodeJS.Platform, url: string): [string, string[]] =>
  platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]

/**
 * Node's fetch (undici) aborts a response that has not started within 300 s: keep each long-poll slice below it.
 * The server starts answering only when the wait has news or its slice ends, so a longer slice never reaches us.
 */
export const WAIT_SLICE_MS = 240_000

/** The next slice of `crewboard wait`: what is left of the timeout, capped below the fetch response timeout. */
export const waitSlice = (remainingMs: number): number => Math.max(0, Math.min(remainingMs, WAIT_SLICE_MS))

/** `10m`, `30s`, `500ms`, `1h` or bare seconds; anything else is the fallback. */
export const duration = (text: string | undefined, fallbackMs: number): number => {
  const m = text ? /^(\d+)(ms|s|m|h)?$/.exec(text) : null
  if (!m) return fallbackMs
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']
}
