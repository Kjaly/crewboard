import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunUsage } from '../backend/types.js'
import type { RunState } from './graph.js'
import type { RawEvent } from '../runs/raw-event.js'
import { evidenceRef, type RunEvidence } from '../runs/evidence.js'
import { extractReport } from '../runs/report.js'
import { PNG, PNG_RU } from './example-images.js'
import { type Plan, type Run, type Task, newTask } from './schema.js'
import { CREWBOARD_DIR, loadPlan, savePlan } from './store.js'
import { createPlan, removeExamplePlan } from './plans.js'

export const EXAMPLE_ID = 'orchestra-example'
export const EXAMPLE_VERSION = 2
/** Every synthetic run id starts with this prefix, so example data can never be mistaken for a real run. */
export const EXAMPLE_RUN_PREFIX = 'run_example-'
/** Where the example keeps its files, the synthetic run store and the contracts. */
export const EXAMPLE_DIR = join(CREWBOARD_DIR, 'example')
/** Marks every synthetic usage and cost figure; real accounting never uses this source. */
export const EXAMPLE_SOURCE = 'example_fixture'
export const exampleFilePath = (root: string, taskId: string, file: string) => join(root, EXAMPLE_DIR, 'files', taskId, file)

/** One synthetic run, as the example backend serves it. */
export type ExampleRun = { events: RawEvent[]; state: RunState; usage?: RunUsage }
export type ExampleRuns = { version: 1; synthetic: true; runs: Record<string, ExampleRun> }

type ExampleLang = 'en' | 'ru'
type TaskId = 'research' | 'decide-flow' | 'outline' | 'copy' | 'hero' | 'build' | 'api' | 'analytics' | 'tests' | 'release-review' | 'release' | 'localize'
type Copy = {
  goal: string
  lanes: [string, string, string, string, string]
  titles: Record<TaskId, string>
  done: Partial<Record<TaskId, string>>
  claim: string
  report: string
  checks: string
  accepted: Partial<Record<TaskId, string>>
  returnedCopy: string
  returnedHero: string
  decision: string
  failed: string
  running: string
  files: { research: string; outline: string; copy: string; hero: string; build: string }
}

const COPY: Record<ExampleLang, Copy> = {
  en: {
    goal: 'Explore a plan in action',
    lanes: ['Discovery', 'Design', 'Build', 'Quality', 'Release'],
    titles: {
      research: 'Compare onboarding patterns', 'decide-flow': 'Choose the first-run flow', outline: 'Outline the first screen', copy: 'Write the welcome copy',
      hero: 'Draw the hero illustration', build: 'Build the welcome screen', api: 'Store onboarding progress', analytics: 'Track onboarding events',
      tests: 'Cover the flow with tests', 'release-review': 'Review the release', release: 'Ship behind a flag', localize: 'Localize for more languages',
    },
    done: {
      research: 'Compared five products; a short checklist plus a guided example works best.',
      outline: 'Outlined the first screen: setup checklist on the left, three ways to start on the right.',
      copy: 'Wrote the welcome copy: one heading, one sentence, three clear actions.',
      hero: 'Drew the hero illustration with the plan graph, workers and a review queue.',
      build: 'Built the welcome screen and checked both layouts.',
    },
    claim: 'Result: received', report: 'Report', checks: 'Checks: pnpm test passed.',
    accepted: {
      research: 'Clear comparison, accepted.', 'decide-flow': 'Chosen: a setup checklist plus a guided tour on a read-only example.',
      outline: 'Approved after checking the wireframe.', copy: 'Second version is short and names the action. Accepted.',
    },
    returnedCopy: 'Too long: shorten the heading and name the action.',
    returnedHero: 'Too busy: keep one focal point and drop the background grid.',
    decision: '# Choose the first-run flow\n\nOptions from the research:\n\n1. Empty screen with a single «Create plan» button.\n2. Setup checklist plus a guided tour on a read-only example.\n3. Video walkthrough.\n\n- [x] Works without any configured worker\n- [x] Shows review and costs before the first real run\n- [ ] Needs no network\n',
    failed: 'Run failed: the analytics SDK key is missing in the sandbox.',
    running: 'Adding a progress table and an endpoint that reads it.',
    files: {
      research: '# Onboarding patterns\n\n| Product | First screen | Example data |\n| --- | --- | --- |\n| A | Checklist | Yes |\n| B | Empty state | No |\n| C | Video | No |\n\nChecklist plus a live example wins.\n',
      outline: '# First screen\n\n- Left: setup checklist (workers, preset, repository).\n- Right: three ways to start.\n- Footer: CLI hint.\n',
      copy: '# Welcome copy\n\n**Plan the work, let workers do it, review the result.**\n\nStart from a spec, a chat or an example.\n',
      hero: '# Hero illustration (returned)\n\nGraph of tasks, three worker avatars, review queue, background grid.\n',
      build: '# Welcome screen\n\nBreak work into tasks and hand them to workers.\n\n## Review checklist\n\n- Check the layout at 1440 and 1100 pixels.\n- Open the image preview.\n',
    },
  },
  ru: {
    goal: 'Посмотрите, как работает план',
    lanes: ['Исследование', 'Дизайн', 'Разработка', 'Проверка', 'Выпуск'],
    titles: {
      research: 'Сравнить способы знакомства с продуктом', 'decide-flow': 'Выбрать сценарий первого запуска', outline: 'Наметить первый экран', copy: 'Написать текст приветствия',
      hero: 'Нарисовать главную иллюстрацию', build: 'Собрать экран приветствия', api: 'Сохранять прогресс знакомства', analytics: 'Отслеживать события знакомства',
      tests: 'Покрыть сценарий тестами', 'release-review': 'Проверить выпуск', release: 'Выпустить под флагом', localize: 'Перевести на другие языки',
    },
    done: {
      research: 'Сравнили пять продуктов: лучше всего работает короткий список шагов и живой пример.',
      outline: 'Первый экран: слева список настройки, справа три способа начать.',
      copy: 'Текст приветствия: один заголовок, одно предложение, три понятных действия.',
      hero: 'Нарисована иллюстрация: граф плана, воркеры и очередь проверки.',
      build: 'Экран приветствия собран и проверен при обеих ширинах.',
    },
    claim: 'Результат: получен', report: 'Отчёт', checks: 'Проверки: pnpm test прошёл.',
    accepted: {
      research: 'Понятное сравнение, принято.', 'decide-flow': 'Выбрано: список настройки и тур по примеру только для чтения.',
      outline: 'Макет проверен и принят.', copy: 'Вторая версия короткая и называет действие. Принято.',
    },
    returnedCopy: 'Слишком длинно: сократить заголовок и яснее назвать действие.',
    returnedHero: 'Слишком пёстро: оставить один главный элемент и убрать фоновую сетку.',
    decision: '# Выбрать сценарий первого запуска\n\nВарианты из исследования:\n\n1. Пустой экран с одной кнопкой «Создать план».\n2. Список настройки и тур по примеру только для чтения.\n3. Видеообзор.\n\n- [x] Работает без настроенных воркеров\n- [x] Показывает проверку и расходы до первого настоящего запуска\n- [ ] Не требует сети\n',
    failed: 'Запуск упал: в песочнице нет ключа SDK аналитики.',
    running: 'Добавляю таблицу прогресса и обработчик, который её читает.',
    files: {
      research: '# Способы знакомства\n\n| Продукт | Первый экран | Пример |\n| --- | --- | --- |\n| A | Список шагов | Да |\n| B | Пустой экран | Нет |\n| C | Видео | Нет |\n\nЛучше всего — список шагов и живой пример.\n',
      outline: '# Первый экран\n\n- Слева: список настройки (воркеры, набор, репозиторий).\n- Справа: три способа начать.\n- Внизу: подсказка про CLI.\n',
      copy: '# Текст приветствия\n\n**Разбейте работу, поручите её воркерам, проверьте результат.**\n\nНачните со спецификации, чата или примера.\n',
      hero: '# Иллюстрация (возвращена)\n\nГраф задач, три аватара воркеров, очередь проверки, фоновая сетка.\n',
      build: '# Экран приветствия\n\nРазбейте работу на задачи и поручите их воркерам.\n\n## Что проверить\n\n- Проверить экран при ширине 1440 и 1100 пикселей.\n- Открыть изображение.\n',
    },
  },
}

type TaskSpec = { id: TaskId; lane: number; class: NonNullable<Task['class']>; kind?: Task['kind']; worker?: string; deps: TaskId[]; status: Task['status'] }
/** Critical path: research → decide-flow → outline → build → tests → release-review → release. */
const TASKS: TaskSpec[] = [
  { id: 'research', lane: 0, class: 'research', worker: 'dsh/deepseek-flash', deps: [], status: 'accepted' },
  { id: 'decide-flow', lane: 0, class: 'research', kind: 'decision', deps: ['research'], status: 'accepted' },
  { id: 'outline', lane: 1, class: 'design', worker: 'claude/opus', deps: ['decide-flow'], status: 'accepted' },
  { id: 'copy', lane: 1, class: 'design', worker: 'dsh/deepseek-flash', deps: ['decide-flow'], status: 'accepted' },
  { id: 'hero', lane: 1, class: 'design', worker: 'claude/opus', deps: ['decide-flow'], status: 'rejected' },
  { id: 'build', lane: 2, class: 'code', worker: 'codex/gpt-6-astra', deps: ['outline', 'copy'], status: 'in_review' },
  { id: 'api', lane: 2, class: 'code', worker: 'claude/fable', deps: ['decide-flow'], status: 'ready' },
  { id: 'analytics', lane: 2, class: 'code', worker: 'devin', deps: ['decide-flow'], status: 'ready' },
  { id: 'tests', lane: 3, class: 'code', worker: 'codex/gpt-6-astra', deps: ['build', 'api'], status: 'ready' },
  { id: 'release-review', lane: 3, class: 'review', kind: 'review', worker: 'claude/opus', deps: ['tests', 'hero'], status: 'ready' },
  { id: 'release', lane: 4, class: 'code', worker: 'dsh/deepseek-flash', deps: ['release-review', 'analytics'], status: 'ready' },
  { id: 'localize', lane: 4, class: 'design', deps: ['release'], status: 'backlog' },
]

type Tokens = { input: number; output: number; cache: number }
/** Start and length in minutes before `now`; no `minutes` means the run is still going. */
type RunSpec = {
  task: TaskId; id: string; agent: string; provider: string; billingMode: NonNullable<Run['billingMode']>; start: number; minutes?: number
  outcome?: 'completed' | 'failed'; attempt: number; parent?: string; trigger: NonNullable<Run['attemptTrigger']>
  tokens?: Tokens; cashUsd?: number; equivalentUsd?: number; files?: string[]; decided?: { at: number; decision: 'accepted' | 'rejected'; text: 'accepted' | 'returnedCopy' | 'returnedHero' }
}
const RUNS: RunSpec[] = [
  { task: 'research', id: 'research-1', agent: 'dsh/deepseek-flash', provider: 'deepseek', billingMode: 'api', start: 360, minutes: 9, outcome: 'completed', attempt: 1, trigger: 'initial', tokens: { input: 48_200, output: 6_100, cache: 21_000 }, cashUsd: 0.18, files: ['research.md'], decided: { at: 338, decision: 'accepted', text: 'accepted' } },
  { task: 'outline', id: 'outline-1', agent: 'claude/opus', provider: 'anthropic', billingMode: 'subscription', start: 312, minutes: 14, outcome: 'completed', attempt: 1, trigger: 'initial', tokens: { input: 61_400, output: 9_800, cache: 40_200 }, equivalentUsd: 1.42, files: ['outline.md'], decided: { at: 272, decision: 'accepted', text: 'accepted' } },
  { task: 'copy', id: 'copy-1', agent: 'dsh/deepseek-flash', provider: 'deepseek', billingMode: 'api', start: 310, minutes: 6, outcome: 'completed', attempt: 1, trigger: 'initial', tokens: { input: 18_300, output: 2_400, cache: 9_000 }, cashUsd: 0.07, files: ['copy.md'], decided: { at: 291, decision: 'rejected', text: 'returnedCopy' } },
  { task: 'copy', id: 'copy-2', agent: 'dsh/deepseek-flash', provider: 'deepseek', billingMode: 'api', start: 286, minutes: 5, outcome: 'completed', attempt: 2, parent: 'copy-1', trigger: 'human_relaunch', tokens: { input: 16_900, output: 1_900, cache: 12_300 }, cashUsd: 0.06, files: ['copy.md'], decided: { at: 262, decision: 'accepted', text: 'accepted' } },
  { task: 'hero', id: 'hero-1', agent: 'claude/opus', provider: 'anthropic', billingMode: 'subscription', start: 300, minutes: 18, outcome: 'completed', attempt: 1, trigger: 'initial', tokens: { input: 70_100, output: 12_600, cache: 38_000 }, equivalentUsd: 2.1, files: ['hero.md'], decided: { at: 241, decision: 'rejected', text: 'returnedHero' } },
  { task: 'build', id: 'build-1', agent: 'codex/gpt-6-astra', provider: 'openai', billingMode: 'subscription', start: 250, minutes: 22, outcome: 'completed', attempt: 1, trigger: 'initial', tokens: { input: 92_500, output: 14_200, cache: 55_700 }, equivalentUsd: 1.85, files: ['welcome.md', 'welcome.png'] },
  { task: 'analytics', id: 'analytics-1', agent: 'devin', provider: 'cognition', billingMode: 'unknown', start: 205, minutes: 12, outcome: 'failed', attempt: 1, trigger: 'initial' },
  { task: 'api', id: 'api-1', agent: 'claude/fable', provider: 'anthropic', billingMode: 'subscription', start: 26, attempt: 1, trigger: 'initial', tokens: { input: 22_000, output: 3_100, cache: 14_500 }, equivalentUsd: 0.46 },
]

const CODE_TASKS = new Set<TaskId>(['build', 'api', 'analytics', 'tests', 'release'])
const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

/** A believable, deterministic run: read, think, edit, check, report — or fail at the check. */
function scriptFor(spec: RunSpec, copy: Copy, startedAt: string, end: string, reportText: string | undefined): RawEvent[] {
  const from = Date.parse(startedAt)
  const span = Date.parse(end) - from
  const at = (share: number) => new Date(from + Math.round(span * share)).toISOString()
  const title = copy.titles[spec.task]
  const file = spec.files?.[0] ?? (CODE_TASKS.has(spec.task) ? 'src/onboarding.ts' : 'notes.md')
  const tokens = spec.tokens
  const half = (n: number) => Math.round(n / 2)
  const usage = (share: number) => tokens ? [{ ts: at(share), type: 'usage', data: { inputTokens: half(tokens.input), outputTokens: half(tokens.output), cacheReadTokens: half(tokens.cache), ...(spec.cashUsd !== undefined ? { costUsd: Math.round(spec.cashUsd * 50) / 100 } : {}), used: half(tokens.input), size: 200_000 } }] : []
  const events: RawEvent[] = [
    { ts: at(0), type: 'turn_started', data: { turn: 1, text: title } },
    { ts: at(0.04), type: 'answer_delta', data: title },
    ...usage(0.08),
    { ts: at(0.1), type: 'tool_started', data: { tool: 'read', status: 'running', callId: 'read-1', input: { filePath: 'SPEC.md' } } },
    { ts: at(0.18), type: 'tool_completed', data: { callId: 'read-1', status: 'completed', output: 'SPEC.md' } },
    { ts: at(0.3), type: 'tool_started', data: { tool: 'write', status: 'running', callId: 'write-1', input: { filePath: file } } },
    { ts: at(0.5), type: 'tool_completed', data: { callId: 'write-1', status: 'completed', output: file } },
  ]
  if (!spec.outcome) return [...events, { ts: at(0.6), type: 'answer_delta', data: copy.running }, { ts: at(0.7), type: 'tool_started', data: { tool: 'bash', status: 'running', callId: 'check-1', input: { command: 'pnpm test' } } }]
  const failed = spec.outcome === 'failed'
  events.push(
    { ts: at(0.6), type: 'tool_started', data: { tool: 'bash', status: 'running', callId: 'check-1', input: { command: 'pnpm test' } } },
    { ts: at(0.85), type: 'tool_completed', data: { callId: 'check-1', status: failed ? 'error' : 'completed', output: failed ? copy.failed : 'pnpm test: 42 passed' } },
    ...usage(0.9),
  )
  if (failed) return [...events, { ts: at(1), type: 'run_failed', data: copy.failed }]
  return [...events, { ts: at(0.97), type: 'final', data: reportText ?? title }, { ts: at(1), type: 'turn_ended', data: { stopReason: 'end_turn' } }]
}

function usageFor(spec: RunSpec, observedAt: string): RunUsage | undefined {
  if (!spec.tokens) return undefined
  const cash = spec.cashUsd !== undefined
  return {
    calls: spec.outcome ? 2 : 1, inputTokens: spec.tokens.input, outputTokens: spec.tokens.output, cacheReadTokens: spec.tokens.cache, reasoningTokens: 0,
    ...(cash ? { usd: spec.cashUsd } : {}), ...(spec.equivalentUsd !== undefined ? { apiEquivalentUsd: spec.equivalentUsd, rateDate: observedAt.slice(0, 10) } : {}),
    observedAt, source: EXAMPLE_SOURCE, final: !!spec.outcome,
    availability: { cash: { state: cash ? 'known' : 'notApplicable', source: EXAMPLE_SOURCE }, ...(spec.equivalentUsd !== undefined ? { apiEquivalent: { state: 'known', value: spec.equivalentUsd, source: EXAMPLE_SOURCE } } : {}) },
  }
}

/** Creates a read-only tour fixture; no backend, network or worktree is touched. */
export async function createExamplePlan(root: string, now = new Date(), lang: ExampleLang = 'en'): Promise<Plan> {
  const existing = await loadPlan(root, EXAMPLE_ID).catch(() => undefined)
  if (existing) {
    if (!existing.example) throw new Error('The example plan id is already in use')
    if (existing.exampleLang === lang && existing.exampleVersion === EXAMPLE_VERSION) {
      const { setCurrentPlan } = await import('./plans.js')
      await setCurrentPlan(root, EXAMPLE_ID)
      return existing
    }
    await removeExample(root)
  }
  const copy = COPY[lang]
  const dir = join(root, EXAMPLE_DIR)
  const contract = (name: string) => `${EXAMPLE_DIR}/contracts/${name}.md`
  const tasks = new Map<TaskId, Task>(TASKS.map((spec) => [spec.id, newTask({
    id: spec.id, title: copy.titles[spec.id], lane: copy.lanes[spec.lane], class: spec.class, deps: spec.deps,
    ...(spec.kind ? { kind: spec.kind } : {}), ...(spec.worker ? { worker: spec.worker } : {}), status: spec.status === 'backlog' ? 'backlog' : 'ready',
  })]))
  const task = (id: TaskId) => tasks.get(id)!
  for (const spec of TASKS) task(spec.id).status = spec.status
  task('decide-flow').contract = contract('decide-flow')
  task('decide-flow').notes.push({ at: minutesBefore(now, 322), type: 'accept', text: copy.accepted['decide-flow']!, verdict: { kind: 'result' } })
  task('build').contract = contract('build')

  const store: ExampleRuns = { version: 1, synthetic: true, runs: {} }
  const evidence: RunEvidence[] = []
  for (const spec of RUNS) {
    const runId = `${EXAMPLE_RUN_PREFIX}${spec.id}`
    const startedAt = minutesBefore(now, spec.start)
    const finishedAt = spec.minutes === undefined ? undefined : minutesBefore(now, spec.start - spec.minutes)
    const done = copy.done[spec.task]
    const reportText = spec.outcome === 'completed' && done ? [copy.claim, `# ${copy.report}`, done, ...(CODE_TASKS.has(spec.task) ? [copy.checks] : [])].join('\n') : undefined
    const run: Run = {
      runId, agent: spec.agent, ...(spec.agent.includes('/') ? { model: spec.agent.split('/')[1] } : {}), startedAt, ...(finishedAt ? { finishedAt, outcome: spec.outcome } : {}), provider: spec.provider, billingMode: spec.billingMode,
      canonicalWorkerId: spec.agent, identityResolution: 'launch_snapshot', attemptIndex: spec.attempt, attemptTrigger: spec.trigger,
      ...(spec.parent ? { attemptParentRunId: `${EXAMPLE_RUN_PREFIX}${spec.parent}` } : {}), ...(reportText ? { evidence: evidenceRef(runId) } : {}),
    }
    const target = task(spec.task)
    target.runs.push(run)
    // Complete review history: a run that never reached review still has an (empty) interval list.
    target.reviewIntervals ??= []
    const events = scriptFor(spec, copy, startedAt, finishedAt ?? minutesBefore(now, 3), reportText)
    const usage = usageFor(spec, finishedAt ?? minutesBefore(now, 3))
    store.runs[runId] = {
      events,
      state: finishedAt ? { status: spec.outcome!, terminal: true, exitCode: spec.outcome === 'completed' ? 0 : 1, finishedAt } : { status: 'running', terminal: false, exitCode: null },
      ...(usage ? { usage } : {}),
    }
    if (finishedAt && spec.outcome === 'completed') {
      const decidedAt = spec.decided ? minutesBefore(now, spec.decided.at) : undefined
      target.reviewIntervals ??= []
      target.reviewIntervals.push({ id: `review:${runId}`, enteredAt: finishedAt, runId, source: 'human', association: 'exact', ...(decidedAt ? { decidedAt, decision: spec.decided!.decision } : {}) })
      if (spec.decided && decidedAt) {
        const text = spec.decided.text === 'accepted' ? copy.accepted[spec.task]! : copy[spec.decided.text]
        target.notes.push({ at: decidedAt, type: spec.decided.decision === 'accepted' ? 'accept' : 'reject', text, ...(spec.decided.decision === 'accepted' ? { verdict: { kind: 'result' as const } } : {}) })
      }
    }
    if (reportText) evidence.push({
      version: 1, runId, worker: spec.agent, finalAnswer: reportText, finalAnswerState: 'reported',
      report: extractReport(runId, reportText), claimLine: copy.claim,
      files: (spec.files ?? []).map((path) => ({ path, added: path.endsWith('.png') ? null : copy.files[spec.task as keyof Copy['files']].split('\n').length - 1, deleted: path.endsWith('.png') ? null : 0 })),
      filesState: 'reported', checks: CODE_TASKS.has(spec.task) ? [{ command: 'pnpm test', state: 'run' }] : [], checksState: 'reported', capturedAt: finishedAt!,
    })
  }

  const created = await createPlan(root, EXAMPLE_ID, copy.goal, now)
  const plan = await savePlan(root, { ...created, example: true, exampleLang: lang, exampleVersion: EXAMPLE_VERSION, tasks: [...tasks.values()] }, created.rev, now, EXAMPLE_ID)
  await mkdir(join(dir, 'contracts'), { recursive: true })
  await writeFile(join(dir, 'contracts', 'decide-flow.md'), copy.decision)
  await writeFile(join(dir, 'contracts', 'build.md'), copy.files.build)
  for (const [taskId, text] of Object.entries(copy.files)) {
    await mkdir(join(dir, 'files', taskId), { recursive: true })
    await writeFile(exampleFilePath(root, taskId, taskId === 'build' ? 'welcome.md' : `${taskId}.md`), text)
  }
  await writeFile(exampleFilePath(root, 'build', 'welcome.png'), Buffer.from(lang === 'ru' ? PNG_RU : PNG, 'base64'))
  await writeFile(join(dir, 'runs.json'), `${JSON.stringify(store, null, 2)}\n`)
  for (const item of evidence) {
    await mkdir(join(root, CREWBOARD_DIR, 'runs', item.runId), { recursive: true })
    await writeFile(join(root, CREWBOARD_DIR, 'runs', item.runId, 'evidence.json'), `${JSON.stringify(item, null, 2)}\n`)
  }
  return plan
}

/** Removes the example plan and everything it created: its files, synthetic runs and their evidence. */
export async function removeExample(root: string): Promise<void> {
  await removeExamplePlan(root, EXAMPLE_ID)
  await rm(join(root, EXAMPLE_DIR), { recursive: true, force: true })
  const runs = await readdir(join(root, CREWBOARD_DIR, 'runs')).catch(() => [] as string[])
  for (const name of runs) if (name.startsWith(EXAMPLE_RUN_PREFIX)) await rm(join(root, CREWBOARD_DIR, 'runs', name), { recursive: true, force: true })
}
