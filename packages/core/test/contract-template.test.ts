import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approveDraft, claimOf, contractIsUnfilled, contractSkeleton, contractTemplate, contractWarnings, deriveViews, loadPlan, requiredChecks, saveDraft } from '../src/index.js'

const now = new Date('2026-09-24T12:00:00Z')
const brief = {
  goal: 'Add the greet command',
  context: 'Part of the plan: Greeting CLI.',
  result: 'Add `src/greet.ts` exporting `greet(name)` and wire it into the CLI.',
  checks: ['pnpm test', '`cli greet Ann` prints Hello, Ann'],
  outOfScope: ['Localisation'],
  sources: ['## Greeting'],
}

/** ct1 (B21): the one contract layout, golden in both languages. */
describe('contract template', () => {
  it('renders every section in the fixed order (en)', () => {
    expect(contractTemplate({ ...brief, lang: 'en' })).toBe(`# Add the greet command

## Context

Part of the plan: Greeting CLI.

## Result

Add \`src/greet.ts\` exporting \`greet(name)\` and wire it into the CLI.

## Checks

One command per line between the tags. Run each before you report and name every one in the report with its outcome.

<checks>
- pnpm test
- \`cli greet Ann\` prints Hello, Ann
</checks>

## Not in scope

- Localisation

## Sources

- ## Greeting

## Report

Start your final answer with one line: \`Result: received\`, \`Result: negative\` or \`Result: blocked\` — pick one by the facts. Then 3–6 short points: what changed, the checks you ran with their outcome, what to look at on review, and any deviation from this contract.
`)
  })

  it('renders every section in the fixed order (ru)', () => {
    expect(contractTemplate({ ...brief, context: 'Часть плана: CLI.', lang: 'ru' })).toBe(`# Add the greet command

## Контекст

Часть плана: CLI.

## Результат

Add \`src/greet.ts\` exporting \`greet(name)\` and wire it into the CLI.

## Проверки

По одной команде в строке между тегами. Запусти каждую перед отчётом и назови каждую в отчёте с исходом.

<checks>
- pnpm test
- \`cli greet Ann\` prints Hello, Ann
</checks>

## Вне задачи

- Localisation

## Источники

- ## Greeting

## Отчёт

Начни финальный ответ одной строкой: \`Результат: получен\`, \`Результат: отрицательный\` или \`Результат: заблокирован\` — выбери по фактам. Затем 3–6 коротких пунктов: что изменено, какие проверки запущены и с каким исходом, на что смотреть при приёмке, отклонения от этого контракта.
`)
  })

  it('keeps checks and the report section even when nothing else is given', () => {
    const text = contractTemplate({ goal: 'Bare' })
    expect(text.split('\n').filter((line) => line.startsWith('## '))).toEqual(['## Checks', '## Report'])
    expect(requiredChecks(text)).toEqual([])
  })

  it('reads its checks and asks for a result line the verdict understands', () => {
    const text = contractTemplate({ ...brief, lang: 'en' })
    expect(requiredChecks(text)).toEqual(['pnpm test', '`cli greet Ann` prints Hello, Ann'])
    // The claim the report section asks for is one the verdict reader accepts, in either language.
    expect(claimOf('Result: received')).toBe('result')
    expect(claimOf('Результат: получен')).toBe('result')
    expect(contractWarnings(text)).toEqual([])
    expect(contractWarnings(contractTemplate({ ...brief, lang: 'ru' }))).toEqual([])
  })
})

describe('soft contract check', () => {
  it.each([
    ['a one-line sketch', 'Add src/greet.ts', ['no_checks', 'no_result_instruction']],
    ['checks without the result line', '<checks>\n- pnpm test\n</checks>', ['no_result_instruction']],
    ['the result line without checks', 'Первая строка ответа: «Результат: получен | отрицательный | заблокирован».', ['no_checks']],
    ['the skeleton before it is filled in', contractSkeleton('Task'), ['no_checks']],
    ['a filled contract', contractTemplate(brief), []],
  ])('%s', (_name, text, expected) => {
    expect(contractWarnings(text)).toEqual(expected)
  })
})

describe('draft approval through the template', () => {
  it('writes contracts with checks, sources and the result line, and turns open questions into decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct1-'))
    await saveDraft(root, {
      id: 'greeting', goal: 'Greeting CLI', source: 'chat', lanes: ['core'],
      tasks: [
        { id: 'greet', title: 'Add the greet command', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Add `src/greet.ts`.', acceptance: ['pnpm test', 'cli greet Ann prints Hello, Ann'], sources: ['## Greeting'] },
        { id: 'decision-1', title: 'Document it', lane: 'core', class: 'design', kind: 'implement', deps: ['greet'], contract: 'Describe greet in README.md.', acceptance: ['README shows an example'], sources: [] },
      ],
      decisions: ['Should the greeting be localised?', ' ', 'Which name is the default?'],
    })
    const plan = await approveDraft(root, 'greeting', now, 'en')
    const contract = await readFile(join(root, '.orchestration/contracts/greet.md'), 'utf8')
    expect(requiredChecks(contract)).toEqual(['pnpm test', 'cli greet Ann prints Hello, Ann'])
    expect(contract).toContain('## Sources\n\n- ## Greeting')
    expect(contract).toContain('Part of the plan: Greeting CLI.')
    expect(contractWarnings(contract)).toEqual([])
    const docs = await readFile(join(root, '.orchestration/contracts/decision-1.md'), 'utf8')
    expect(docs).toContain('Builds on: greet.')
    expect(contractWarnings(docs)).toEqual([])
    // Open questions: decision tasks titled as the question, ids clear of the draft's own.
    expect(plan.tasks.filter((task) => task.kind === 'decision').map(({ id, title, contract }) => ({ id, title, contract }))).toEqual([
      { id: 'decision-2', title: 'Should the greeting be localised?', contract: undefined },
      { id: 'decision-3', title: 'Which name is the default?', contract: undefined },
    ])
    const stored = await loadPlan(root, 'greeting')
    expect(stored).not.toHaveProperty('draftDecisions')
    expect(deriveViews(stored).filter((view) => view.needsHuman).map((view) => view.task.id)).toEqual(['decision-2', 'decision-3'])
  })

  it('writes the contract in the person\'s language', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct1-ru-'))
    await saveDraft(root, { id: 'ru-plan', goal: 'Приветствие', source: 'chat', lanes: ['core'], tasks: [{ id: 'greet', title: 'Команда greet', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Добавить `src/greet.ts`.', acceptance: ['pnpm test'], sources: [] }], decisions: [] })
    await approveDraft(root, 'ru-plan', now, 'ru')
    const contract = await readFile(join(root, '.orchestration/contracts/greet.md'), 'utf8')
    expect(contract).toContain('## Проверки')
    expect(contract).toContain('Часть плана: Приветствие.')
    expect(contractWarnings(contract)).toEqual([])
  })
})

/** rq1: `run` refuses a contract that still reads like `task add --template`'s own skeleton. */
describe('contractIsUnfilled', () => {
  it('flags the skeleton exactly as --template writes it, in either language', () => {
    expect(contractIsUnfilled(contractSkeleton('Task', 'en'))).toBe(true)
    expect(contractIsUnfilled(contractSkeleton('Task', 'ru'))).toBe(true)
  })

  it('flags a Result heading left empty, and a <checks> block left empty', () => {
    expect(contractIsUnfilled('# T\n\n## Result\n\n## Checks\n\n<checks>\n</checks>')).toBe(true)
    expect(contractIsUnfilled('# T\n\n## Result\n\nDo the thing.\n\n<checks>\n</checks>')).toBe(true)
  })

  it('does not flag a hand-authored contract with no Result heading and no <checks> tag at all', () => {
    expect(contractIsUnfilled('# T\n\nDo the thing, plainly.\n')).toBe(false)
  })

  it('does not flag a filled-in contract with real Result and Checks content', () => {
    expect(contractIsUnfilled(contractTemplate({ ...brief, lang: 'en' }))).toBe(false)
  })
})
