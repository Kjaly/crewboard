import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export async function writeJsonAtomic(path: string, value: unknown, beforeRename?: () => Promise<void>): Promise<void> {
  return writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, beforeRename)
}

/** The text variant also preserves the previous registry byte for byte in its backup. */
export async function writeTextAtomic(path: string, text: string, beforeRename?: () => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, text)
    await beforeRename?.()
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
