import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type AcpParams = Record<string, unknown>

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }
type Incoming = { id?: number | string; method?: string; params?: AcpParams; result?: unknown; error?: { code?: number; message?: string } }

/** Minimal ACP v1 client: JSON-RPC 2.0, one JSON object per line over the agent's stdio. */
export class AcpConnection {
  onNotification: (method: string, params: AcpParams) => void = () => {}
  onRequest: (method: string, params: AcpParams) => Promise<unknown> = async (method) => {
    throw new AcpError(`unsupported client method: ${method}`, -32601)
  }
  readonly exited: Promise<number>

  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, Pending>()

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => {
      child.on('close', (code) => {
        this.closed = true
        for (const p of this.pending.values()) p.reject(new AcpError(`agent process exited (${code ?? 'signal'}) during ${p.method}`))
        this.pending.clear()
        resolve(code ?? 1)
      })
    })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    child.stderr.resume()
    createInterface({ input: child.stdout }).on('line', (line) => this.handle(line))
  }

  static spawn(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): AcpConnection {
    return new AcpConnection(spawn(command, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] }))
  }

  request<T = unknown>(method: string, params: AcpParams): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError(`connection closed before ${method}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method })
      this.write({ id, method, params })
    })
  }

  /** Notifications carry no id; ACP `session/cancel` MUST be sent this way. */
  notify(method: string, params: AcpParams): void {
    if (!this.closed) this.write({ method, params })
  }

  kill(): void {
    if (!this.closed) this.child.kill('SIGTERM')
  }

  private write(msg: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }

  private handle(line: string): void {
    let msg: Incoming
    try {
      msg = JSON.parse(line) as Incoming
    } catch {
      return
    }
    if (msg.method === undefined && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new AcpError(`${p.method}: ${msg.error.message ?? 'error'}`, msg.error.code))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      const id = msg.id
      this.onRequest(msg.method, msg.params ?? {}).then(
        (result) => this.write({ id, result }),
        (err: unknown) =>
          this.write({
            id,
            error: { code: err instanceof AcpError && err.code ? err.code : -32603, message: err instanceof Error ? err.message : String(err) },
          }),
      )
      return
    }
    if (typeof msg.method === 'string') this.onNotification(msg.method, msg.params ?? {})
  }
}
