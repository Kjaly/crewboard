import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCodexQuota } from '../src/cost/codex-quota.js'

async function fake(mode: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'))
  const file = join(dir, 'codex')
  await writeFile(file, `#!/usr/bin/env node\nlet b=''; process.stdin.on('data',c=>{b+=c; const lines=b.split('\\n'); b=lines.pop(); for(const l of lines){let q;try{q=JSON.parse(l)}catch{continue}; if(q.id===1){${mode === 'protocol' ? "process.stdout.write(JSON.stringify({id:1,error:{code:-1,message:'bad protocol'}})+'\\n')" : "process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n')"};} if(q.method==='account/rateLimits/read'){${mode === 'timeout' ? "" : mode === 'protocol' ? "" : mode === 'login' ? "process.stdout.write(JSON.stringify({id:2,result:{}})+'\\n')" : "process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{planType:'plus',primary:{usedPercent:17.5,windowDurationMins:300,resetsAt:1800000000}},rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:17.5,windowDurationMins:300,resetsAt:1800000000}},other:{limitName:'Other',secondary:{usedPercent:40}}}}})+'\\n')"}}}});\n`)
  await chmod(file, 0o755)
  return file
}

describe('readCodexQuota', () => {
  it('normalizes app-server response and records snapshot time', async () => {
    const result = await readCodexQuota({ binary: await fake('normal'), now: () => new Date('2026-09-23T00:00:00Z') })
    expect(result).toMatchObject({ ok: true, source: 'codex-app-server:account/rateLimits/read', takenAt: '2026-09-23T00:00:00.000Z', planType: 'plus', limits: { codex: { primary: { usedPercent: 17.5, remainingPercent: 82.5, windowDurationMins: 300, resetsAt: '2027-01-15T08:00:00.000Z' } }, other: { secondary: { usedPercent: 40, remainingPercent: 60 } } } })
  })
  it('returns unknown for timeout, protocol error, missing binary, and no login', async () => {
    expect(await readCodexQuota({ binary: await fake('timeout'), timeoutMs: 40 })).toMatchObject({ ok: false, reason: expect.any(String) })
    expect(await readCodexQuota({ binary: await fake('protocol') })).toMatchObject({ ok: false, reason: expect.any(String) })
    expect(await readCodexQuota({ binary: '/missing/codex-test-binary' })).toMatchObject({ ok: false, reason: expect.any(String) })
    expect(await readCodexQuota({ binary: await fake('login') })).toMatchObject({ ok: false, reason: expect.stringContaining('rate limits') })
  })
})
