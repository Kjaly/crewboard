import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// ~15% above the size reached by moving core to zod/mini and minifying the Node bundles (crewboard 134 KiB,
// dsh-crewboard 775 KiB of which the lazy layout engine is most, 2026-09-24): a heavier tarball fails here.
// The CLI ceiling was raised to 162 KiB the same day: note events (i18n2) and plan compatibility (pq1) took it
// to 154.2 KiB, both accepted on purpose.
const TARBALL_CEILING_KIB = { cli: 162, plugin: 891 }
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
      ? ['dist/main.js', 'dist/runner-main.js', 'dist/cli-runner-main.js', 'README.md', 'LICENSE']
      : ['lib/index.js', 'lib/runner-main.js', 'lib/cli-runner-main.js', 'lib/client.js', 'lib/elk.js', 'lib/dict-en.js', 'lib/dict-ru.js', 'lib/preview-dxf.js', 'lib/preview-structured.js', 'cordis.patch.yml', 'README.md', 'LICENSE', ...['review','welcome','settings','draft','ledger','trace','task'].map(n => `lib/screen-${n}.js`)]
    for (const name of expected) if (!listing.includes(name)) throw new Error(`${pkg.name} missing required tarball file ${name}`)
    // The CLI ships exactly its bundle and runners: anything else is a stale build leftover.
    if (dir === 'cli') {
      const extra = listing.filter((x) => !expected.includes(x) && !['package.json', 'README.md', 'LICENSE'].includes(x))
      if (extra.length) throw new Error(`${pkg.name} contains unexpected files: ${extra.join(', ')}`)
    }
    if (dir === 'plugin') {
      const clientBytes = (await (await import('node:fs/promises')).stat(join(root, 'packages/plugin/lib/client.js'))).size
      if (clientBytes > 320 * 1024) throw new Error(`Plugin main client bundle is ${clientBytes} bytes; limit is 327680`)
      for (const asset of await readdir(join(root, 'packages/plugin/assets/vendors'))) {
        if (asset.endsWith('.svg') && !listing.includes(`assets/vendors/${asset}`)) throw new Error(`Plugin host-served vendor asset missing: ${asset}`)
      }
    }
    const meta = execFileSync('tar', ['-xOzf', tgz[dir], 'package/package.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const packed = JSON.parse(meta)
    if (packed.private || packed.version !== '0.3.0') throw new Error(`${pkg.name} packed manifest is private or has unexpected version`)
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
