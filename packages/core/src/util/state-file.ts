/** Why a state file could not be read or written: the disk is full, access is denied, the disk is read-only. */
export type StateFileReason = 'no_space' | 'no_access' | 'read_only'

const REASONS: Record<string, StateFileReason> = { ENOSPC: 'no_space', EDQUOT: 'no_space', EACCES: 'no_access', EPERM: 'no_access', EROFS: 'read_only' }

const SENTENCES: Record<StateFileReason, (path: string) => string> = {
  no_space: (path) => `No space left on the disk for ${path}; free some space and try again. / На диске нет места для ${path}; освободите место и повторите.`,
  no_access: (path) => `No permission to write ${path}; check the owner and permissions of the file and its folder. / Нет прав на запись ${path}; проверьте владельца и права файла и его папки.`,
  read_only: (path) => `${path} is on a read-only disk; Crewboard cannot write there. / ${path} на диске только для чтения; Crewboard не может туда писать.`,
}

/**
 * A full disk, a denied permission or a read-only disk met on a state file (sf1). The person gets one
 * sentence with the path instead of a Node stack; the message carries both languages like the other
 * refusals (CLIs, agents and logs quote it as is), the CLI renders `reason` in its own language.
 */
export class StateFileError extends Error {
  readonly code = 'state_file'
  constructor(
    readonly reason: StateFileReason,
    readonly path: string,
    cause?: unknown,
  ) {
    super(SENTENCES[reason](path), { cause })
    this.name = 'StateFileError'
  }
}

/**
 * The sentence form of a disk or permission error, or undefined for anything else. `path` names the file
 * the person knows (the plan, not its temporary copy); without it the error's own path is used.
 */
export function stateFileError(err: unknown, path?: string): StateFileError | undefined {
  if (err instanceof StateFileError) return err
  const errno = err as NodeJS.ErrnoException | null
  const reason = typeof errno?.code === 'string' ? REASONS[errno.code] : undefined
  const where = path ?? (typeof errno?.path === 'string' ? errno.path : undefined)
  if (!reason || !where) return undefined
  return new StateFileError(reason, where, err)
}
