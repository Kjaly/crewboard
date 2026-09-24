import type { TaskClass, WorkerSource } from '../plan/schema.js'
import { canonicalWorkerId } from './identity.js'
import { loadProfileStore } from './profile-store.js'
import { type EffectiveRouting, resolveRouting } from './presets.js'
import { CLASS_LABEL, CLASS_LABEL_RU, classOfTask } from './routing.js'

/**
 * The preset is the owner's decision. A person may assign any worker; an agent may only choose among
 * the workers the effective preset routes the task's class to, or leave the choice to the preset.
 */
/** Who is asking for a worker. The same two values a task stores as its `workerSource`. */
export type Caller = WorkerSource
/** How a request arrived. */
export type CallerChannel =
  /** `orch` in a terminal: a person only with an interactive TTY on stdin and stdout — the test `orch accept` uses. */
  | { kind: 'cli'; isTTY: boolean }
  /** A dsh screen action: the host already requires the client header on every POST. */
  | { kind: 'ui' }
  /** A chat tool (`orchestra_*`) — always a model. */
  | { kind: 'tool' }

/** The one place that decides whether a request comes from a person or from an agent. */
export function callerOf(channel: CallerChannel): Caller {
  if (channel.kind === 'ui') return 'person'
  if (channel.kind === 'cli') return channel.isTTY ? 'person' : 'agent'
  return 'agent'
}

/** `--worker auto`, `-a auto` and the screen's «Auto» clear the assignment: the preset decides. */
export const AUTO_WORKER = 'auto'
export const isAutoWorker = (worker: string | undefined): boolean => worker?.trim().toLowerCase() === AUTO_WORKER

/** The workers an agent may choose for a class: the effective preset's list after machine prohibitions. */
export const presetWorkers = (routing: EffectiveRouting, cls: TaskClass): string[] => routing.routing[cls]

export function presetAllows(routing: EffectiveRouting, cls: TaskClass, worker: string, aliases: Record<string, string> = {}): boolean {
  const canonical = (id: string) => canonicalWorkerId(canonicalWorkerId(id, aliases))
  return presetWorkers(routing, cls).some((id) => canonical(id) === canonical(worker))
}

type Lang = 'en' | 'ru'
export const presetName = (routing: EffectiveRouting, lang: Lang): string => (routing.preset.builtin ? (lang === 'ru' ? 'Все воркеры' : 'All workers') : routing.preset.label)

export class PresetAuthorityError extends Error {
  readonly code = 'outside_preset'
  constructor(
    readonly preset: string,
    readonly taskClass: TaskClass,
    readonly worker: string,
    readonly allowed: string[],
    lang: Lang,
  ) {
    super(presetRefusal(lang, { preset, taskClass, worker, allowed }))
    this.name = 'PresetAuthorityError'
  }
}

export function presetRefusal(lang: Lang, o: { preset: string; taskClass: TaskClass; worker: string; allowed: string[] }): string {
  if (lang === 'ru') {
    const allowed = o.allowed.length ? o.allowed.join(', ') : 'нет ни одного включённого воркера'
    return `Воркер ${o.worker} не входит в пресет «${o.preset}» для класса «${CLASS_LABEL_RU[o.taskClass]}» (${o.taskClass}). Агент может выбрать только: ${allowed} — или не указывать воркера, тогда решает пресет. Попросите человека выбрать другого воркера или сменить пресет.`
  }
  const allowed = o.allowed.length ? o.allowed.join(', ') : 'no enabled worker'
  return `Worker ${o.worker} is not in the preset “${o.preset}” for the class “${CLASS_LABEL[o.taskClass]}” (${o.taskClass}). An agent may choose only: ${allowed} — or name no worker and let the preset decide. Ask the person to choose another worker or change the preset.`
}

/** A person may assign anything; an agent outside the preset is refused with the allowed list. */
export function assertWorkerChoice(o: { caller: Caller; routing: EffectiveRouting; taskClass: TaskClass; worker: string; aliases?: Record<string, string>; lang: Lang }): void {
  if (o.caller === 'person') return
  if (presetAllows(o.routing, o.taskClass, o.worker, o.aliases)) return
  throw new PresetAuthorityError(presetName(o.routing, o.lang), o.taskClass, o.worker, presetWorkers(o.routing, o.taskClass), o.lang)
}

/** The effective routing and saved aliases a worker choice is checked against (task add/set, chat tools). */
export async function loadPresetAuthority(o: { root: string; planId?: string; env: NodeJS.ProcessEnv; home: string }): Promise<{ routing: EffectiveRouting; aliases: Record<string, string> }> {
  const env = { ...o.env, HOME: o.home }
  return { routing: await resolveRouting(o.root, o.planId, env), aliases: (await loadProfileStore(env, o.home)).aliases }
}

/**
 * Writes one worker request onto a task: `auto` (or nothing) clears the assignment and its source,
 * any other name is stored with who chose it. A task never holds a worker without a source.
 */
export function assignWorker(task: { worker?: string; workerSource?: WorkerSource }, worker: string | undefined, caller: Caller): void {
  if (worker === undefined || !worker.trim() || isAutoWorker(worker)) {
    delete task.worker
    delete task.workerSource
    return
  }
  task.worker = worker
  task.workerSource = caller
}

// Finished work never launches again, so an old assignment on it is history, not a deviation.
const FINISHED = new Set(['accepted', 'closed', 'superseded'])

/** Marks open tasks whose assigned worker the current preset does not route their class to. */
export function markOutsidePreset<T extends { kind: string; class?: TaskClass; worker?: string; workerSource?: WorkerSource; status?: string }>(tasks: T[], routing: EffectiveRouting, aliases: Record<string, string> = {}): Array<T & { outsidePreset?: boolean }> {
  return tasks.map((task) => (task.workerSource && task.worker && !(task.status && FINISHED.has(task.status)) && !presetAllows(routing, classOfTask(task), task.worker, aliases) ? { ...task, outsidePreset: true } : task))
}

/**
 * Who picked an attempt's worker. Runs launched before `workerChoice` existed: the old «outside the
 * preset» note at the run's start marks an explicit pick of unknown origin — an agent's, like the
 * task migration (plan/schema.ts `legacyWorkerSource`); anything else followed the preset.
 */
const LEGACY_OUTSIDE = /Launched by hand outside the preset|Запущено вручную вне пресета/
export function runWorkerChoice(run: { startedAt: string; workerChoice?: 'preset' | 'person' | 'agent' }, notes: ReadonlyArray<{ at: string; text: string }>): 'preset' | 'person' | 'agent' {
  if (run.workerChoice) return run.workerChoice
  return notes.some((note) => note.at === run.startedAt && LEGACY_OUTSIDE.test(note.text)) ? 'agent' : 'preset'
}
