/**
 * Piping into a command that closes early (`crewboard status | head`) breaks the pipe; without a listener
 * Node treats the stream's `error` event as unhandled and crashes with a stack. Exit quietly instead (cl2).
 * A minimal structural type keeps this testable with a plain `EventEmitter`, not only a real Node stream.
 */
export function guardEpipe(stream: { on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown }, exit: (code: number) => void): void {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') exit(0)
    else throw err
  })
}
