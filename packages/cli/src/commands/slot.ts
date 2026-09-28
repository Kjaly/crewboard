import { acquireSlot, defaultSlots, loadMaxSlots, saveMaxSlots, type Exec } from '@crewboard/core'
import { cliT } from '../i18n.js'
import { homeOf } from '../context.js'
import { type Io, UserError } from '../io.js'

/**
 * `crewboard slot -- <command…>` (ql1): waits for a free machine-wide slot, then runs `command` with its
 * exit code and output unchanged. `slot --set <n>` and a bare `slot` configure and show the slot count;
 * every command here is off-plan (no repository or plan needed), like `preflight`.
 */
export async function cmdSlot(argv: string[], io: Io, exec: Exec): Promise<number> {
  const lang = io.lang ?? 'en'
  const home = homeOf(io)
  if (argv[0] === '--set') {
    const n = Number(argv[1])
    if (argv.length !== 2 || !Number.isInteger(n) || n < 1) throw new UserError(cliT(lang, 'slot.usage'), 2)
    await saveMaxSlots(io.env, home, n)
    io.out(cliT(lang, 'slot.set', { n }))
    return 0
  }
  if (argv.length === 0) {
    io.out(cliT(lang, 'slot.show', { n: await loadMaxSlots(io.env, home), default: defaultSlots() }))
    return 0
  }
  if (argv[0] !== '--' || argv.length < 2) throw new UserError(cliT(lang, 'slot.usage'), 2)
  const [cmd, ...rest] = argv.slice(1)
  const slot = await acquireSlot({ env: io.env, home, onWaiting: (ahead) => io.err(cliT(lang, 'slot.waiting', { ahead })) })
  try {
    const r = await exec(cmd as string, rest, { cwd: io.cwd, env: io.env })
    if (r.stdout) io.out(r.stdout)
    if (r.stderr) io.err(r.stderr)
    return r.code
  } finally {
    await slot.release()
  }
}
