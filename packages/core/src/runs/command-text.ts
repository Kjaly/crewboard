export type CommandPaths = { cwd?: string; repo?: string }

/** Display only: unwrap a shell's single command argument and shorten known local paths, without executing it. */
export function readableCommand(command: string, paths: CommandPaths = {}): string {
  const word = (source: string): string | undefined => {
    let quote = ''
    let text = ''
    for (let i = 0; i < source.length; i++) {
      const c = source.charAt(i)
      if (c === quote) quote = ''
      else if (!quote && (c === "'" || c === '"')) quote = c
      else if (c === '\\' && quote !== "'") {
        const next = source[i + 1]
        if (next === undefined) return undefined
        if (!quote || /[$`"\\\n]/.test(next)) { text += next; i++ }
        else text += c
      } else if (!quote && /\s/.test(c)) return undefined
      else text += c
    }
    return quote ? undefined : text
  }
  let text = command.trim()
  for (;;) {
    const shell = /^(?:\S*\/)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+([\s\S]+)$/.exec(text)
    const inner = shell?.[1] === undefined ? undefined : word(shell[1])
    if (inner === undefined) break
    text = inner.trim()
  }
  const trim = (p: string | undefined) => (p && p !== '/' ? p.replace(/\/$/, '') : undefined)
  const cwd = trim(paths.cwd)
  const repo = trim(paths.repo)
  // The working folder reads as relative paths. The repo is shortened the same way only when it is the working folder:
  // a worker in its own worktree touching the owner's checkout must show as `<repo>/…`, not as its own files.
  const roots: Array<[string, string]> = [...(cwd ? [[cwd, ''] as [string, string]] : []), ...(repo && repo !== cwd ? [[repo, cwd ? '<repo>' : ''] as [string, string]] : [])].sort((a, b) => b[0].length - a[0].length)
  const local = (target: string) => roots.some(([root, label]) => root === target && label === '')
  text = text.replace(/(^|[;&|]\s*)git\s+-C\s+("(?:\\.|[^"\\])*"|'[^']*'|(?:\\.|[^\s;&|])+)\s*/g, (match, prefix: string, path: string) => {
    const target = word(path)?.replace(/\/$/, '')
    return target && (local(target) || (target === '.' && cwd)) ? `${prefix}git ` : match
  })
  for (const [root, label] of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(^|[\\s"'=(:>])${escaped}(/?)(?=$|[\\s"';&|)<]|(?<=/)\\S)`, 'g'), (_match, prefix: string, slash: string, offset: number, all: string) => {
      const rest = all.charAt(offset + _match.length)
      const bare = !slash || rest === '' || /[\s"';&|)<]/.test(rest)
      if (label) return `${prefix}${label}${slash && !bare ? '/' : ''}`
      return `${prefix}${bare ? '.' : ''}`
    })
  }
  return text
}
