import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../src/app.js'
import { createFakeBackend } from './fake-backend.js'

export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return dir
}

/** The app on a free port with a fake backend and an MCP client playing the lead. Call `close` when done. */
export async function startApp(opts: { now?: () => Date } = {}) {
  const fake = createFakeBackend()
  // Never read the developer's real Claude Code transcripts from tests.
  const env = { ...process.env, CREWBOARD_HOME: await mkdtemp(join(tmpdir(), 'cb-home-')), CREWBOARD_CLAUDE_PROJECTS: await mkdtemp(join(tmpdir(), 'cb-claude-')), CREWBOARD_CODEX_SESSIONS: await mkdtemp(join(tmpdir(), 'cb-codex-')), CREWBOARD_DSH_SESSIONS: await mkdtemp(join(tmpdir(), 'cb-dsh-')) }
  const app = createApp({ env, backendFor: () => async () => fake.backend, tickMs: 60_000, ...(opts.now ? { now: opts.now } : {}) })
  const server = await app.listen(0)
  const client = new Client({ name: 'test-lead', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)))
  const call = async <T = unknown>(name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
    const text = r.content[0]?.text ?? ''
    if (r.isError) throw new Error(`${name}: ${text}`)
    return JSON.parse(text) as T
  }
  return {
    app, server, fake, env, call, project: await gitRepo(),
    async close() {
      await client.close().catch(() => undefined)
      await server.close()
    },
  }
}

/** Reads a streamed response until `until` matches the text so far, or `ms` passes. */
export async function readStream(res: Response, until: (text: string) => boolean, ms = 5000): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (!until(text) && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()))])
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel().catch(() => undefined)
  return text
}
