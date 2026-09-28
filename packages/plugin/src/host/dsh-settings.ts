import { watch } from 'node:fs'
import { join, resolve } from 'node:path'

/** dsh's home, as dsh resolves it: `$DSH_HOME`, else `~/.dsh`. */
export const dshHomeOf = (env: NodeJS.ProcessEnv, home: string): string =>
  env.DSH_HOME?.trim() ? resolve(env.DSH_HOME.replace(/^~(?=$|\/)/, home)) : join(home, '.dsh')

/**
 * Calls `onChange` when dsh's `settings.yaml` changes. The directory is watched, not the file: the Models page
 * replaces the file, which a file watch would lose. Missing directory or no fs.watch: nothing is watched.
 */
export function watchDshSettings(dir: string, onChange: () => void): () => void {
  try {
    const watcher = watch(dir, (_event, file) => { if (String(file ?? '') === 'settings.yaml') onChange() })
    watcher.on('error', () => {})
    return () => watcher.close()
  } catch {
    return () => {}
  }
}
