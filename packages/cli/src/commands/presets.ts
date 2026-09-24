import { parseArgs } from 'node:util'
import { BUILTIN_PRESET_ID, TASK_CLASSES, currentPlanId, deletePreset, listPresets, resolveRouting, savePreset, setPlanPreset, setRepositoryPreset, type Exec, type TaskClass } from '@crewboard/core'
import { repoRoot } from '../context.js'
import { cliT } from '../i18n.js'
import { type Io, UserError } from '../io.js'
import { cmdRepoAdd, cmdRepoList, cmdRepoRm } from './repos.js'

const language = (io: Io) => io.lang ?? 'en'

export async function cmdPresets(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub = 'list', ...rest] = argv
  const root = await repoRoot(io, exec)
  if (sub === 'list') {
    const effective = await resolveRouting(root, undefined, io.env)
    io.out(`${cliT(language(io), 'presets.active', { label: effective.preset.builtin ? cliT(language(io), 'presets.builtin') : effective.preset.label, source: cliT(language(io), `presets.source.${effective.source}`) })}\n`)
    for (const preset of await listPresets(io.env)) io.out(`${preset.id} — ${preset.label}\n`)
    return 0
  }
  if (sub === 'add' || sub === 'set') {
    const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { label: { type: 'string' }, code: { type: 'string' }, design: { type: 'string' }, review: { type: 'string' }, research: { type: 'string' } } })
    const id = positionals[0]
    if (!id || !values.label || TASK_CLASSES.some((cls) => values[cls] === undefined)) throw new UserError(cliT(language(io), 'presets.usage'), 2)
    const routing = Object.fromEntries(TASK_CLASSES.map((cls) => [cls, (values[cls] ?? '').split(',').map((s) => s.trim()).filter(Boolean)])) as Record<TaskClass, string[]>
    await savePreset({ id, label: values.label, routing }, io.env)
    io.out(`${cliT(language(io), 'presets.saved', { id })}\n`)
    return 0
  }
  if (sub === 'rm') {
    if (!rest[0]) throw new UserError(cliT(language(io), 'presets.usage'), 2)
    const { usedIn } = await deletePreset(rest[0], [root], io.env)
    io.out(`${cliT(language(io), 'presets.removed', { id: rest[0], places: usedIn.join(', ') || '—' })}\n`)
    return 0
  }
  throw new UserError(cliT(language(io), 'presets.usage'), 2)
}

export async function cmdRepo(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'add') return cmdRepoAdd(rest, io, exec)
  if (sub === 'list' || sub === 'ls') return cmdRepoList(io, exec)
  if (sub === 'rm' || sub === 'remove') return cmdRepoRm(rest, io)
  if (sub !== 'preset' || !argv[1]) throw new UserError(cliT(language(io), 'repo.usage'), 2)
  const root = await repoRoot(io, exec)
  await setRepositoryPreset(root, argv[1], io.env)
  io.out(`${cliT(language(io), 'presets.selected', { id: argv[1] })}\n`)
  return 0
}

export async function cmdPlanPreset(argv: string[], io: Io, exec: Exec): Promise<number> {
  const root = await repoRoot(io, exec)
  const id = argv[0] === '--clear' ? undefined : argv[0]
  if (!id && argv[0] !== '--clear') throw new UserError(cliT(language(io), 'presets.planUsage'), 2)
  await setPlanPreset(root, currentPlanId(root), id, io.env)
  io.out(`${cliT(language(io), 'presets.selected', { id: id ?? BUILTIN_PRESET_ID })}\n`)
  return 0
}
