import { homedir } from 'node:os'
import { TASK_CLASSES, type TaskClass } from '../plan/schema.js'
import { loadProfileStore, profileStorePath, updateProfileStore } from './profile-store.js'

export const CLASS_LABEL: Record<TaskClass, string> = {
  code: 'Code', design: 'Design and UI', review: 'Review', research: 'Research',
}
export const CLASS_LABEL_RU: Record<TaskClass, string> = {
  code: 'По готовому коду', design: 'Проектирование и UI', review: 'Ревью', research: 'Исследование',
}
export type Routing = { classes: Record<TaskClass, string[]>; disabled: Record<string, string> }
export const DEFAULT_ROUTING: Routing = {
  classes: { code: ['dsh/deepseek-flash', 'devin'], design: ['devin', 'codex/gpt-6-sol'], review: ['codex', 'devin'], research: ['devin', 'dsh/deepseek-flash'] },
  disabled: {},
}
export { profileStorePath }

export function classOfTask(task: { kind: string; class?: TaskClass }): TaskClass {
  if (task.class) return task.class
  if (task.kind === 'review') return 'review'
  if (task.kind === 'research') return 'research'
  return 'code'
}
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
export async function loadRouting(path: string, env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): Promise<Routing> {
  return (await loadProfileStore({ ...env, CREWBOARD_PROFILES_FILE: path }, home)).routing
}
export async function saveRouting(path: string, routing: Routing, env: NodeJS.ProcessEnv = process.env, home = env.HOME ?? homedir()): Promise<void> {
  for (const cls of TASK_CLASSES) if (!isStringList(routing.classes?.[cls])) throw new TypeError(`routing.classes.${cls} must be a list of worker ids`)
  if (!routing.disabled || typeof routing.disabled !== 'object' || Object.values(routing.disabled).some((v) => typeof v !== 'string')) throw new TypeError('routing.disabled must map worker ids to reasons')
  await updateProfileStore({ ...env, CREWBOARD_PROFILES_FILE: path }, home, (store) => ({ ...store, routing }))
}
export function candidates(routing: Routing, cls: TaskClass): string[] {
  return routing.classes[cls].filter((id) => !(id in routing.disabled))
}
