import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requiredChecks } from '../orchestration/verdict.js'
import { CREWBOARD_DIR } from './store.js'

export type ContractLang = 'en' | 'ru'

/**
 * What a contract says, whoever writes it (ct1, B21): draft approval, a follow-up or a superseding task,
 * `task add --template` and the orchestrator's tools all fill this one shape and get the same sections.
 */
export type ContractBrief = {
  /** The task in one line: the contract's title. */
  goal: string
  /** Why the task exists and what it builds on. */
  context?: string
  /** What must be true when the work is done: files, behaviour, where. */
  result?: string
  /** Commands (or observable checks) a reviewer runs; they fill `<checks>`, which the verdict reads. */
  checks?: readonly string[]
  outOfScope?: readonly string[]
  /** Specification sections or files the task comes from. */
  sources?: readonly string[]
  lang?: ContractLang
}

const TEXT = {
  en: {
    context: 'Context',
    result: 'Result',
    checks: 'Checks',
    checksHint: 'One command per line between the tags. Run each before you report and name every one in the report with its outcome.',
    outOfScope: 'Not in scope',
    sources: 'Sources',
    report: 'Report',
    reportBody: 'Start your final answer with one line: `Result: received`, `Result: negative` or `Result: blocked` — pick one by the facts. Then 3–6 short points: what changed, the checks you ran with their outcome, what to look at on review, and any deviation from this contract.',
    planContext: 'Part of the plan: {goal}.',
    buildsOn: 'Builds on: {deps}.',
    followUp: 'Follow-up to {id}: {title}.',
    supersedes: 'Replaces {id}: {title}. Start from what it left.',
    parentReport: 'Its report',
    parentVerdict: 'Its verdict: {verdict}.',
    parentFindings: 'Open findings',
    skeletonContext: 'Why this task exists and what it builds on.',
    skeletonResult: 'What must be true when the work is done: which files change, what behaves differently.',
    skeletonOutOfScope: 'What the worker must leave alone.',
    options: 'Options',
  },
  ru: {
    context: 'Контекст',
    result: 'Результат',
    checks: 'Проверки',
    checksHint: 'По одной команде в строке между тегами. Запусти каждую перед отчётом и назови каждую в отчёте с исходом.',
    outOfScope: 'Вне задачи',
    sources: 'Источники',
    report: 'Отчёт',
    reportBody: 'Начни финальный ответ одной строкой: `Результат: получен`, `Результат: отрицательный` или `Результат: заблокирован` — выбери по фактам. Затем 3–6 коротких пунктов: что изменено, какие проверки запущены и с каким исходом, на что смотреть при приёмке, отклонения от этого контракта.',
    planContext: 'Часть плана: {goal}.',
    buildsOn: 'Опирается на: {deps}.',
    followUp: 'Продолжение {id}: {title}.',
    supersedes: 'Заменяет {id}: {title}. Начни с того, что осталось от неё.',
    parentReport: 'Её отчёт',
    parentVerdict: 'Её вердикт: {verdict}.',
    parentFindings: 'Открытые находки',
    skeletonContext: 'Зачем эта задача и на что она опирается.',
    skeletonResult: 'Что должно быть верно, когда работа закончена: какие файлы меняются, что работает иначе.',
    skeletonOutOfScope: 'Что воркер не трогает.',
    options: 'Варианты',
  },
} as const satisfies Record<ContractLang, Record<string, string>>

type Key = keyof typeof TEXT.en
export const contractText = (lang: ContractLang | undefined, key: Key, vars: Record<string, string> = {}): string =>
  TEXT[lang === 'ru' ? 'ru' : 'en'][key].replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)

const items = (list: readonly string[] | undefined): string[] => (list ?? []).map((item) => item.trim()).filter(Boolean)
const bullets = (list: readonly string[]): string => list.map((item) => `- ${item}`).join('\n')

/**
 * The one contract layout, sections in a fixed order: title, context, result, checks, not in scope, sources,
 * report. Checks and the report are always there — the verdict reads `<checks>` and the result line the report
 * section asks for (orchestration/verdict.ts); the other sections appear only with content.
 */
export function contractTemplate(brief: ContractBrief): string {
  const t = (key: Key) => contractText(brief.lang, key)
  const checks = items(brief.checks)
  const outOfScope = items(brief.outOfScope)
  const sources = items(brief.sources)
  const sections = [
    `# ${brief.goal.trim()}`,
    brief.context?.trim() ? `## ${t('context')}\n\n${brief.context.trim()}` : '',
    brief.result?.trim() ? `## ${t('result')}\n\n${brief.result.trim()}` : '',
    `## ${t('checks')}\n\n${t('checksHint')}\n\n<checks>\n${checks.length ? `${bullets(checks)}\n` : ''}</checks>`,
    outOfScope.length ? `## ${t('outOfScope')}\n\n${bullets(outOfScope)}` : '',
    sources.length ? `## ${t('sources')}\n\n${bullets(sources)}` : '',
    `## ${t('report')}\n\n${t('reportBody')}`,
  ]
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

/**
 * A decision's brief (op1, B36): the question, why it is asked, and the options as a checklist — the lines the
 * decision panel lets the person tick. No checks and no report: no worker runs a decision.
 */
export function decisionTemplate(brief: { goal: string; context?: string; options?: readonly string[]; lang?: ContractLang }): string {
  const options = items(brief.options)
  const sections = [
    `# ${brief.goal.trim()}`,
    brief.context?.trim() ? `## ${contractText(brief.lang, 'context')}\n\n${brief.context.trim()}` : '',
    options.length ? `## ${contractText(brief.lang, 'options')}\n\n${options.map((option) => `- [ ] ${option}`).join('\n')}` : '',
  ]
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

/** The skeleton `task add --template` writes: every section present, with a line saying what goes there. */
export function contractSkeleton(goal: string, lang?: ContractLang): string {
  return contractTemplate({
    goal,
    lang,
    context: contractText(lang, 'skeletonContext'),
    result: contractText(lang, 'skeletonResult'),
    outOfScope: [contractText(lang, 'skeletonOutOfScope')],
  })
}

/** «Part of the plan: …. Builds on: a, b.» — the context of a task approved from a draft. */
export function planContext(goal: string, deps: readonly string[], lang?: ContractLang): string {
  return [goal.trim() ? contractText(lang, 'planContext', { goal: goal.trim() }) : '', deps.length ? contractText(lang, 'buildsOn', { deps: deps.join(', ') }) : ''].filter(Boolean).join(' ')
}

/**
 * The context of a follow-up or a superseding task: the parent, its report, verdict and open findings, so
 * the new worker starts from what the previous one handed in.
 */
export function followUpContext(parent: { id: string; title: string; report?: string; verdict?: string; findings: readonly string[] }, replace: boolean, lang?: ContractLang): string {
  const lead = contractText(lang, replace ? 'supersedes' : 'followUp', { id: parent.id, title: parent.title })
  const report = parent.report?.trim() ? `${contractText(lang, 'parentReport')}:\n\n${parent.report.trim().split(/\r?\n/).map((line) => `> ${line}`).join('\n')}` : ''
  const verdict = parent.verdict ? contractText(lang, 'parentVerdict', { verdict: parent.verdict }) : ''
  const findings = parent.findings.length ? `${contractText(lang, 'parentFindings')}:\n\n${bullets(parent.findings)}` : ''
  return [lead, report, verdict, findings].filter(Boolean).join('\n\n')
}

/**
 * Soft checks of a contract (ct1): `run` and the tools warn, never refuse. Without checks the report cannot be
 * compared with anything; without the result line every honest report reads as disputed (ux7).
 */
export type ContractWarning = 'no_checks' | 'no_result_instruction'
/** The instruction the verdict relies on: «Result: received …» / «Результат: получен …», in any dressing. */
const RESULT_INSTRUCTION = /(?:result|результат)\s*:\s*(?:received|получен)/iu
export function contractWarnings(text: string): ContractWarning[] {
  const plain = text.replace(/[`*«»"]/g, '')
  const warnings: ContractWarning[] = []
  if (!requiredChecks(text).length) warnings.push('no_checks')
  if (!RESULT_INSTRUCTION.test(plain)) warnings.push('no_result_instruction')
  return warnings
}

/** The body of a `## <heading>` section: every line up to the next `## ` heading or the end of the text. `undefined` when the heading is not there at all. */
function sectionBody(text: string, headings: string[]): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => headings.some((heading) => line.trim() === `## ${heading}`))
  if (start === -1) return undefined
  const body: string[] = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i] ?? ''); i++) body.push(lines[i] ?? '')
  return body.join('\n')
}

/**
 * A contract nobody has touched since `task add --template` wrote it (rq1): every skeleton placeholder
 * still in place, or a `## Result` / `<checks>` section left present but empty — a worker started on it
 * would read the template's own instructions back, not a real brief.
 */
export function contractIsUnfilled(text: string): boolean {
  const markers = [TEXT.en.skeletonContext, TEXT.en.skeletonResult, TEXT.en.skeletonOutOfScope, TEXT.ru.skeletonContext, TEXT.ru.skeletonResult, TEXT.ru.skeletonOutOfScope]
  if (markers.some((marker) => text.includes(marker))) return true
  const result = sectionBody(text, ['Result', 'Результат'])
  if (result !== undefined && !result.trim()) return true
  if (/<checks>[\s\S]*?<\/checks>/i.test(text) && !requiredChecks(text).length) return true
  return false
}

/** Where Crewboard writes a new task's contract: one folder per plan, relative to the repository root. */
export const contractPathFor = (planId: string, taskId: string): string => `${CREWBOARD_DIR}/contracts/${planId}/${taskId}.md`

/** Writes a new contract; an existing file is never overwritten (EEXIST reaches the caller). */
export async function writeNewContract(root: string, relPath: string, text: string): Promise<void> {
  const path = join(root, relPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { flag: 'wx' })
}
