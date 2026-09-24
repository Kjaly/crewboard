import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/** Runs `scripts/build.mjs` of `pkg` while another process keeps checking that `entries` exist. */
export async function buildWhileWatching(pkg: string, entries: string[]): Promise<{ rounds: number; misses: number }> {
  const stop = join(await mkdtemp(join(tmpdir(), 'orch-build-watch-')), 'stop')
  const watcher = spawn(process.execPath, [fixture('watch-entries.mjs'), stop, ...entries], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  watcher.stdout.setEncoding('utf8')
  await new Promise<void>((resolve) => watcher.stdout.on('data', (chunk: string) => { out += chunk; if (out.startsWith('ready\n')) resolve() }))
  try {
    await promisify(execFile)(process.execPath, ['scripts/build.mjs'], { cwd: pkg })
  } finally {
    await writeFile(stop, '')
    await new Promise((resolve) => watcher.on('close', resolve))
  }
  return JSON.parse(out.slice('ready\n'.length))
}

/** Runs `scripts/build.mjs` of `pkg` with esbuild failing half-way through the output; resolves to the exit code. */
export async function failingBuild(pkg: string): Promise<number> {
  try {
    await promisify(execFile)(process.execPath, ['--import', fixture('failing-esbuild.mjs'), 'scripts/build.mjs'], { cwd: pkg })
    return 0
  } catch (error) {
    return (error as { code: number }).code
  }
}

/** Staging directories a build left next to its output. */
export async function leftovers(pkg: string): Promise<string[]> {
  return (await readdir(pkg)).filter((name) => name.includes('-next-'))
}
