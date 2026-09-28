import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CREWBOARD_DIR } from '../plan/store.js'

/**
 * A command's full output kept in a file, with what a message shows of it: the path, the size and the
 * last lines. Output that enters a model's context stays there for every later request of that session,
 * so a message carries the tail and the file holds the rest (tk1).
 */
export type SavedOutput = { path: string; bytes: number; tail: string }

/** About this many last lines go into a message. */
export const TAIL_LINES = 20
/** A tail of very long lines (minified code, a progress bar) is cut to this many characters. */
const TAIL_CHARS = 4000
/** Output files one task keeps; the oldest go when a new one is written. */
const KEEP_FILES = 10

/** One folder per task copy: `worktree gc` removes it together with the copy. */
export const outputDir = (root: string, taskId: string): string => join(root, CREWBOARD_DIR, 'output', taskId)

/**
 * Lines of a runner's crash dump that tell a person nothing the file does not: stack frames (vitest's `❯ …`, Node's
 * `at …`), the code frame under them, vitest's `Serialized Error: {…}` and its bare separator rules. A vitest run
 * that dies in its setup ends with them, and 20 such lines hid the compiler errors above them (fo1, rf2).
 */
const DUMP_LINE = [/^\s*❯ /, /^\s+at \S.*:\d+(:\d+)?\)?$/, /^\s*\d+\|/, /^\s*\|\s*\^/, /^Serialized Error: /, /^⎯+$/]

/**
 * The last `count` lines, cut at a line boundary, without a crash dump's frames (the file keeps them); trailing
 * blank lines (a runner's summary padding) do not count, and runs of blank lines count as one.
 */
export function tailLines(text: string, count = TAIL_LINES): string {
  const kept = text
    .replace(/\s+$/, '')
    .split('\n')
    .filter((line) => !DUMP_LINE.some((re) => re.test(line)))
    .filter((line, i, all) => line.trim() !== '' || (all[i - 1] ?? '').trim() !== '')
  let lines = kept.slice(-count)
  while (lines.length > 1 && lines.join('\n').length > TAIL_CHARS) lines = lines.slice(1)
  return lines.join('\n').slice(-TAIL_CHARS)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Writes `text` to `<dir>/<ms>-<kind>.log` and keeps only the task's latest files. */
export async function saveOutput(dir: string, kind: string, text: string, now: Date): Promise<SavedOutput> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${now.getTime()}-${kind}.log`)
  await writeFile(path, text)
  const old = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.log')).sort().slice(0, -KEEP_FILES)
  for (const name of old) await rm(join(dir, name), { force: true })
  return { path, bytes: Buffer.byteLength(text), tail: tailLines(text) }
}

/** Removes a task's output files; called when its copy is removed. */
export const removeOutput = (root: string, taskId: string): Promise<void> => rm(outputDir(root, taskId), { recursive: true, force: true })
