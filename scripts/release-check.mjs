// Packs the crewboard package the way npm would publish it and checks what the tarball holds: the server, the
// worker runners, the screen, the readme and licence, and nothing from the sources or a local .crewboard.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkgDir = join(root, 'packages', 'crewboard')
const out = mkdtempSync(join(tmpdir(), 'crewboard-pack-'))
const fail = (message) => {
  console.error(`release check: ${message}`)
  process.exitCode = 1
}

try {
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: pkgDir, stdio: 'ignore' })
  const tarball = execFileSync('ls', [out]).toString().trim().split('\n').find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error('pnpm pack produced no tarball')
  const files = execFileSync('tar', ['-tzf', join(out, tarball)]).toString().trim().split('\n')
  const required = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/main.js', 'package/dist/cli-runner-main.js', 'package/dist/runner-main.js', 'package/dist/ui/index.html', 'package/dist/ui/app.js', 'package/dist/ui/styles.css']
  for (const file of required) if (!files.includes(file)) fail(`missing ${file}`)
  for (const file of files) if (/^package\/(src|test)\/|\.crewboard\//.test(file)) fail(`must not ship ${file}`)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  if (manifest.name !== 'crewboard') fail(`package name is ${manifest.name}`)
  if (manifest.bin?.crewboard !== './dist/main.js') fail('bin crewboard must point at ./dist/main.js')
  if (!readFileSync(join(pkgDir, 'dist', 'main.js'), 'utf8').startsWith('#!/usr/bin/env node')) fail('dist/main.js has no shebang')
  if (!process.exitCode) console.log(`release check: ok (${manifest.name}@${manifest.version}, ${files.length} files)`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(out, { recursive: true, force: true })
}
