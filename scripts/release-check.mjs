// Packs the crewboard package the way npm would publish it and checks what the tarball holds: the server, the
// worker runners, the screen, the readme and licence, and nothing from the sources or a local .crewboard.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageReadme } from './package-readme.mjs'

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
  if (manifest.bin?.crewboard !== 'dist/main.js') fail('bin crewboard must point at dist/main.js')
  // The Claude Code plugin ships with the package version, so an install from the marketplace names what npm has.
  const plugin = JSON.parse(readFileSync(join(root, 'plugins', 'crewboard', '.claude-plugin', 'plugin.json'), 'utf8'))
  if (plugin.version !== manifest.version) fail(`the Claude Code plugin is ${plugin.version}, the package is ${manifest.version}: set plugins/crewboard/.claude-plugin/plugin.json`)
  // `npm publish` rewrites a manifest it finds invalid, and drops what it cannot fix (a `./` bin path, with npm 11):
  // `pack` does not, so only a publish dry run shows what npm would actually publish.
  const dry = spawnSync('npm', ['publish', '--dry-run'], { cwd: pkgDir, encoding: 'utf8' })
  const corrected = (dry.stderr ?? '').split('\n').filter((l) => /errors corrected|was invalid and removed/.test(l))
  if (corrected.length) fail(`npm would rewrite package.json on publish: ${corrected.join(' ')}`)
  if (!readFileSync(join(pkgDir, 'dist', 'main.js'), 'utf8').startsWith('#!/usr/bin/env node')) fail('dist/main.js has no shebang')
  // The packed CLI must run on its own, the way npx runs it: from the unpacked tarball, without this repository's
  // node_modules, against an empty home.
  const unpacked = join(out, 'unpacked')
  execFileSync('mkdir', ['-p', unpacked])
  execFileSync('tar', ['-xzf', join(out, tarball), '-C', unpacked])
  const main = join(unpacked, 'package', 'dist', 'main.js')
  const env = { ...process.env, CREWBOARD_HOME: join(out, 'home'), NODE_PATH: '' }
  // npm shows the package's README: it must be the repository's, with no link that only works on GitHub.
  const readme = readFileSync(join(unpacked, 'package', 'README.md'), 'utf8')
  if (readme !== packageReadme(readFileSync(join(root, 'README.md'), 'utf8'))) fail('the packed README is not the repository README')
  const relative = [...readme.matchAll(/\]\(([^)\s]+)\)|\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter((t) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(t))
  if (relative.length) fail(`the packed README has relative links npm cannot follow: ${relative.join(', ')}`)
  const help = spawnSync('node', [main, '--help'], { cwd: out, env, encoding: 'utf8' })
  if (help.status !== 0 || !help.stdout.includes('crewboard serve')) fail(`packed --help failed: ${help.stderr || help.status}`)
  const doctor = spawnSync('node', [main, 'doctor'], { cwd: out, env, encoding: 'utf8', timeout: 120_000 })
  if ((doctor.status !== 0 && doctor.status !== 1) || !/[✓✗]/.test(doctor.stdout) || /\n\s+at /.test(doctor.stderr)) fail(`packed doctor failed: ${doctor.stderr || doctor.status}`)
  if (!process.exitCode) console.log(`release check: ok (${manifest.name}@${manifest.version}, ${files.length} files; --help and doctor ran from the tarball)`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(out, { recursive: true, force: true })
}
