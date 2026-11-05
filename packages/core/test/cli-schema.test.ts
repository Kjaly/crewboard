import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCliBackend } from '../src/runs/cli-backend.js'
import { runCliRun } from '../src/runs/cli-runner.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-schema-cli.mjs', import.meta.url))
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const response = { answer: 'Готово' }
const cases = (['claude', 'codex'] as const).flatMap((kind) =>
  [false, true].flatMap((resumed) => [false, true].map((structured) => ({ kind, resumed, structured }))),
)

describe('CLI response schemas', () => {
  it.each(['claude', 'codex'] as const)('%s passes the schema through launch, saved args and the runner', async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-schema-'))
    const promptFile = join(dir, 'prompt.md')
    const log = join(dir, 'argv.json')
    await writeFile(promptFile, 'Check the files')
    const backend = createCliBackend({ kind, runsRoot: dir, command: process.execPath, commandArgs: [fixture, kind], env: { ...process.env, TEST_SCHEMA_LOG: log, TEST_SCHEMA_RESULT: JSON.stringify(response) }, startRunner: (args, env) => runCliRun(args, undefined, env) })
    const runId = await backend.launch({ agent: `${kind}/model`, cwd: dir, promptFile, schema })
    expect(await backend.status(runId)).toMatchObject({ status: 'completed' })
    expect(JSON.parse(await readFile(join(dir, runId, 'args.json'), 'utf8')).schema).toEqual(schema)
    expect(JSON.parse(await readFile(log, 'utf8')).schema).toEqual(schema)
    const results = (await backend.events(runId)).filter((e) => e.type === 'result')
    expect(results.at(-1)?.data).toBe(JSON.stringify(response))
  })

  it.each(cases)('arguments: $kind resumed=$resumed schema=$structured', async ({ kind, resumed, structured }) => {
    const runDir = await mkdtemp(join(tmpdir(), 'cb-schema-args-'))
    const promptFile = join(runDir, 'prompt.md')
    const log = join(runDir, 'argv.json')
    await writeFile(promptFile, 'Check the files')
    const state = await runCliRun({ kind, runDir, cwd: runDir, promptFile, command: process.execPath, commandArgs: [fixture, kind], readOnly: true, ...(resumed ? { previousSessionId: 'previous-session' } : {}), ...(structured ? { schema } : {}) }, undefined, { ...process.env, TEST_SCHEMA_LOG: log, TEST_SCHEMA_RESULT: JSON.stringify(response) })
    expect(state.status).toBe('completed')
    const { argv, schema: recorded } = JSON.parse(await readFile(log, 'utf8')) as { argv: string[]; schema?: unknown }
    const flag = kind === 'claude' ? '--json-schema' : '--output-schema'
    expect(argv.includes(flag)).toBe(structured)
    expect(recorded).toEqual(structured ? schema : undefined)
    if (structured && kind === 'codex') {
      const file = argv[argv.indexOf(flag) + 1]!
      expect(file.startsWith(`${runDir}/`)).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(schema)
    }
    if (kind === 'claude') {
      expect(argv).toContain('-p')
      expect(argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json']))
      if (structured) expect(argv[argv.indexOf(flag) + 1]).toBe(JSON.stringify(schema))
      if (resumed) expect(argv).toEqual(expect.arrayContaining(['--resume', 'previous-session']))
    } else if (resumed) expect(argv).toEqual(expect.arrayContaining(['resume', 'previous-session']))
  })
})
