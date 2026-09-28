import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { contractWarnings } from '../src/plan/contract.js'
import { contractBlock, contractPaths, requiredChecks, verdictOf } from '../src/orchestration/verdict.js'
import type { TaskDetail } from '../src/orchestration/detail.js'

// ck1: a block opens and closes only at a line that is exactly the tag; the probe on ck1's own contract ran 11
// «commands» because its prose mentions `<checks>` inline and the old reader took everything up to </checks>.

const fixture = () => readFile(new URL('./fixtures/ck1-contract-inline-checks.md', import.meta.url), 'utf8')

describe('contract blocks', () => {
  it('ck1\'s own contract: inline mentions are prose, only the real block counts', async () => {
    expect(requiredChecks(await fixture())).toEqual(['pnpm -s lint:i18n', 'test -f does-not-exist.txt'])
  })

  it.each([
    ['inline mention and no block', 'Contracts carry a `<checks>` block.\nMore prose </checks> here.', undefined],
    ['tag with text on the same line', '<checks> - pnpm test\n</checks>', undefined],
    ['unclosed block', '<checks>\n- pnpm test\n', undefined],
    ['surrounding whitespace is allowed', '  <checks>  \n- pnpm test\n\t</checks>\n', ['- pnpm test']],
    ['a block inside fenced code is an example', '```md\n<checks>\n- rm -rf x\n</checks>\n```\n', undefined],
    ['a tilde fence too', '~~~\n<checks>\n- rm -rf x\n</checks>\n~~~\n<checks>\n- pnpm test\n</checks>', ['- pnpm test']],
    ['several blocks: the last counts', '<checks>\n- pnpm lint\n</checks>\n\n<checks>\n- pnpm test\n</checks>', ['- pnpm test']],
    ['an inline mention before the real block', 'Run the `<checks>` below.\n\n<checks>\n- pnpm test\n</checks>', ['- pnpm test']],
  ])('%s', (_name, text, expected) => {
    expect(contractBlock(text, 'checks')).toEqual(expected)
  })

  it('the same rule reads <paths>', () => {
    expect(contractPaths('Touch only `<paths>` listed.\n<paths>\n- src/api/\n</paths>\nnot </paths> here')).toEqual(['src/api/'])
  })

  it('the contract warning, the checks list and the verdict agree on the fixture', async () => {
    const text = await fixture()
    const commands = requiredChecks(text)
    expect(commands).toHaveLength(2)
    expect(contractWarnings(text)).not.toContain('no_checks')
    const detail: Omit<TaskDetail, 'verdict'> = {
      id: 'ck1', title: 'ck1', kind: 'implement', status: 'in_review', deps: [], dependents: [],
      runs: [{ runId: 'run_1', agent: 'worker', startedAt: '2026-09-25T10:00:00Z', finishedAt: '2026-09-25T10:01:00Z', outcome: 'completed' }],
      notes: [], steers: [], events: [], changedFiles: ['packages/core/src/a.ts'],
      report: { runId: 'run_1', text: 'Result: received\n- pnpm -s lint:i18n — passed\n- test -f does-not-exist.txt — passed', source: 'section', truncated: false },
      contract: { path: 'c.md', text, truncated: false },
    }
    // The verdict counts the same two commands; the prose around the inline mention used to add nine more.
    const counted = verdictOf(detail).facts.filter((fact) => /^checks_(?:run|not_run|unreported|unreadable)$/.test(fact.code))
    expect(counted.reduce((sum, fact) => sum + (fact.count ?? 0), 0)).toBe(commands.length)
    expect(counted.map((fact) => fact.code)).toContain('checks_run')
  })
})
