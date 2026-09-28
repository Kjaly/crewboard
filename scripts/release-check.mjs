import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// Measured tarball size plus ~5% (crewboard 116.5 KiB after wave 1 w1a+w1c — preflight auth/key checks, honest run
// outcomes, worker process groups; dsh-crewboard 775.7 KiB of which the lazy layout engine is most, after opt2;
// 2026-09-24): a heavier tarball fails here. Growth past them is a decision to make on purpose — measure it and
// move the number with the new size.
// Tarballs measured after wave 1 (w1a–w1f), 2026-09-24: crewboard 123.6 KiB → 130, dsh-crewboard 796.2 KiB → 836.
// crewboard re-measured after wave 2 and sz1 (2026-09-25): 162.4 KiB → 171 (the Russian texts in dist/dict-ru.js).
// crewboard re-measured after merging main's at2/nb1/SSE-hub texts into sz1 (2026-09-25): 164.7 KiB → 173.
// Re-measured after wave 2 (2026-09-25): crewboard 169.8 KiB → 179, dsh-crewboard 851.3 KiB → 894.
// crewboard re-measured after rq1's grouped "no worker" refusal (2026-09-25): 180.6 KiB → 190.
// crewboard re-measured after rb1's review fixes (2026-09-25): 190.5 KiB → 200.
// Re-measured after the 2026-09-28 merges (result attestation, API-only Claude policy, orchestrator usage):
// crewboard 212.7 KiB → 224, dsh-crewboard 904.9 KiB → 951. The growth is implemented feature content the
// per-bundle ceilings in packages/cli/test/build.test.ts and packages/plugin/test/build.test.ts already carry;
// packing is unchanged (exact file sets, no sources/tests/node_modules, classic-zod and tree-shaking guards hold).
const TARBALL_CEILING_KIB = { cli: 224, plugin: 951 }
// The always-loaded client bundle: measured 296.0 KiB plus ~5% (2026-09-24, after opt2), as in the plugin build test.
// Navigation stage (2026-09-28): the Now screen is lazy, the compact project switcher is not; measured 369.0 KiB → 388.
const CLIENT_CEILING_KIB = 388 // re-measured after wave 2 (2026-09-25): 334.8 KiB; 346.9 KiB on 2026-09-28, 369.0 after navigation
const temp = await mkdtemp(join(tmpdir(), 'crewboard-release-'))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
try {
  run('pnpm', ['build'])
  const packages = ['cli', 'plugin']
  const tgz = {}
  for (const dir of packages) {
    const pkg = JSON.parse(await readFile(join(root, `packages/${dir}/package.json`), 'utf8'))
    const dest = join(temp, dir)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dest))
    run('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', dest])
    const found = (await readdir(dest)).find((name) => name.endsWith('.tgz'))
    if (!found) throw new Error(`No tarball produced for ${pkg.name}`)
    tgz[dir] = join(dest, found)
    const listing = execFileSync('tar', ['-tzf', tgz[dir]], { encoding: 'utf8' }).trim().split('\n').map((x) => x.replace(/^package\//, ''))
    const forbidden = listing.filter((x) => /(^|\/)(src|test|tests|\.orchestration)(\/|$)|(^|\/)(\.env[^/]*|.*\.pem|.*\.key)$|node_modules/.test(x))
    if (forbidden.length) throw new Error(`${pkg.name} contains excluded files: ${forbidden.join(', ')}`)
    const expected = dir === 'cli'
      ? ['dist/main.js', 'dist/dict-ru.js', 'dist/runner-main.js', 'dist/cli-runner-main.js', 'README.md', 'LICENSE']
      : ['lib/index.js', 'lib/runner-main.js', 'lib/cli-runner-main.js', 'lib/client.js', 'lib/elk.js', 'lib/dict-en.js', 'lib/dict-ru.js', 'lib/preview-dxf.js', 'lib/preview-structured.js', 'cordis.patch.yml', 'README.md', 'LICENSE', ...['review','welcome','settings','draft','ledger','trace','task','now'].map(n => `lib/screen-${n}.js`)]
    for (const name of expected) if (!listing.includes(name)) throw new Error(`${pkg.name} missing required tarball file ${name}`)
    // The CLI ships exactly its bundle and runners: anything else is a stale build leftover.
    if (dir === 'cli') {
      const extra = listing.filter((x) => !expected.includes(x) && !['package.json', 'README.md', 'LICENSE'].includes(x))
      if (extra.length) throw new Error(`${pkg.name} contains unexpected files: ${extra.join(', ')}`)
    }
    if (dir === 'plugin') {
      const clientBytes = (await (await import('node:fs/promises')).stat(join(root, 'packages/plugin/lib/client.js'))).size
      if (clientBytes > CLIENT_CEILING_KIB * 1024) throw new Error(`Plugin main client bundle is ${clientBytes} bytes; limit is ${CLIENT_CEILING_KIB * 1024}`)
      for (const asset of await readdir(join(root, 'packages/plugin/assets/vendors'))) {
        if (asset.endsWith('.svg') && !listing.includes(`assets/vendors/${asset}`)) throw new Error(`Plugin host-served vendor asset missing: ${asset}`)
      }
    }
    const meta = execFileSync('tar', ['-xOzf', tgz[dir], 'package/package.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const packed = JSON.parse(meta)
    if (packed.private || packed.version !== '0.4.0') throw new Error(`${pkg.name} packed manifest is private or has unexpected version`)
    if (dir === 'cli' && packed.dependencies?.['@crewboard/core']) throw new Error('CLI tarball retains private core dependency')
    if (dir === 'cli') {
      const firstLine = execFileSync('tar', ['-xOzf', tgz[dir], 'package/dist/main.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')[0]
      if (firstLine !== '#!/usr/bin/env node') throw new Error('CLI emitted bin is missing its Node shebang')
    }
    const size = (await (await import('node:fs/promises')).stat(tgz[dir])).size
    console.log(`\n${pkg.name} ${size} bytes (${(size / 1024).toFixed(1)} KiB)\n${listing.map(x => `  ${x}`).join('\n')}`)
    if (size > TARBALL_CEILING_KIB[dir] * 1024) throw new Error(`${pkg.name} tarball is ${size} bytes; limit is ${TARBALL_CEILING_KIB[dir] * 1024}`)
  }
  const project = join(temp, 'consumer')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(project)
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'crewboard-release-smoke', version: '1.0.0', private: true }, null, 2))
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tgz.cli, tgz.plugin], { cwd: project })
  run('npm', ['exec', '--offline', '--', 'crewboard', '--help'], { cwd: project })
  run('npm', ['exec', '--offline', '--', 'orch', '--help'], { cwd: project })
  try {
    // A throwaway dsh home keeps the owner's profiles untouched; --profile takes a name, not a path.
    execFileSync('dsh', ['plugin', '--profile', 'crewboard-smoke', 'add', tgz.plugin], { cwd: project, stdio: 'inherit', env: { ...process.env, DSH_HOME: join(temp, 'dsh-home') } })
  } catch (error) {
    if (error.code === 'ENOENT') console.log('\ndsh CLI unavailable; skipped disposable profile install.')
    else throw error
  }
  console.log('\nRelease package checks passed.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
