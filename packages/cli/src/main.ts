#!/usr/bin/env node
import { run } from './cli.js'
import { envLang, programOf } from './i18n.js'
import { askLine } from './io.js'

const io = {
  cwd: process.cwd(),
  lang: envLang(process.env),
  program: programOf(process.argv[1]),
  env: process.env,
  out: (s: string) => void process.stdout.write(s),
  err: (s: string) => void process.stderr.write(s),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: (q: string) => askLine(q, { input: process.stdin, output: process.stdout }),
  now: () => new Date(),
}

process.exitCode = await run(process.argv.slice(2), io)
