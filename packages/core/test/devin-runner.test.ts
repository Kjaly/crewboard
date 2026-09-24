import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createDevinBackend } from '../src/runs/devin-backend.js'
import { runDevinRun } from '../src/runs/devin-runner.js'
import { readSteer, writeSteer } from '../src/runs/steers.js'
import { createBackends } from '../src/orchestration/backends.js'
import { nodeExec } from '../src/exec.js'
const fake = fileURLToPath(new URL('./fixtures/fake-devin.mjs', import.meta.url))
async function setup(scenario = 'normal', detached = false) {
 const root = await mkdtemp(join(tmpdir(), 'orch-devin-'))
 const promptFile = join(root, 'prompt.md'); await writeFile(promptFile, 'contract')
 const options = { runsRoot: root, command: process.execPath, commandArgs: [fake, scenario] }
 const factory = detached ? (await import('../dist/runs/devin-backend.js')).createDevinBackend : createDevinBackend
 const backend = factory({ ...options, ...(detached ? {} : {startRunner: runDevinRun}) })
 return {root, promptFile, options, backend, launch: () => backend.launch({agent:'devin', cwd:root, promptFile})}
}
async function until(fn: () => Promise<boolean>) {
 for (let n=0;n<150;n++) { if(await fn()) return; await new Promise(r=>setTimeout(r, 40)) }
 throw new Error('timed out')
}
it('routes Devin directly', async () => {
 const s=await setup(); expect((await createBackends({root:s.root,home:s.root,env:{},exec:nodeExec}).forAgent('devin')).id).toBe('devin')
})
it('handshakes, streams and persists final text', async () => {
 const s=await setup(); const id=await s.launch()
 expect(id).toMatch(/^run_devin-[a-z0-9]+$/)
 expect(await s.backend.status(id)).toMatchObject({status:'completed',exitCode:0})
 const state=JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8'))
 expect(state).toMatchObject({sessionId:'devin-session',finalText:'hello'})
 expect((await s.backend.events(id)).map(e=>e.type)).toEqual(expect.arrayContaining(['text','thought','tool']))
 const rpc=(await readFile(join(s.root,'rpc.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l))
 expect(rpc[0].params).toMatchObject({protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}})
 expect(rpc[1].params).toEqual({cwd:s.root,mcpServers:[]})
 expect(rpc[2].params.modeId).toBe('bypass')
 expect(rpc[3].params.prompt[0].text).toBe('contract')
 expect(rpc.find(m=>m.id==='permission').result).toEqual({outcome:{outcome:'selected',optionId:'once'}})
 expect(rpc.find(m=>m.id==='elicit').result).toEqual({action:'cancel'})
})
for (const mode of ['auto','queue','interrupt'] as const) it(`detaches and delivers ${mode} steer with durable acknowledgement`, async () => {
 const s=await setup('hold',true); const id=await s.launch()
 const restarted=createDevinBackend(s.options)
 await until(async()=> (await restarted.events(id)).some(e=>e.type==='text'))
 expect(await restarted.status(id)).toMatchObject({status:'running'})
 await writeFile(s.promptFile,'correction'); await restarted.steer(id,s.promptFile,mode)
 await until(async()=> (await restarted.status(id)).terminal)
 expect(await restarted.status(id)).toMatchObject({status:'completed'})
 expect((await restarted.events(id)).filter(e=>e.type==='steer_ack').map(e=>e.data)).toEqual(expect.arrayContaining([expect.objectContaining({status:'request_sent'}),expect.objectContaining({status:'completed'})]))
 const rpc=await readFile(join(s.root,'rpc.jsonl'),'utf8'); expect(rpc.includes('session/cancel')).toBe(mode==='interrupt')
})
it('records sent and acknowledged for a tracked ACP prompt', async () => {
 const s=await setup('hold',true);const id=await s.launch()
 await until(async()=> (await s.backend.events(id)).some(e=>e.type==='text'))
 const steerId='11111111-1111-4111-8111-111111111111', runDir=join(s.root,id)
 await writeSteer(runDir,{id:steerId,createdAt:new Date().toISOString(),mode:'auto',preview:'correction',file:s.promptFile,state:'queued',timestamps:{queued:new Date().toISOString()}})
 await writeFile(s.promptFile,'correction');await s.backend.steer(id,s.promptFile,'auto',steerId)
 await until(async()=> (await s.backend.status(id)).terminal)
 expect(await readSteer(runDir,steerId)).toMatchObject({state:'acknowledged',timestamps:{sent:expect.any(String),acknowledged:expect.any(String)}})
})
it('cancels a detached run', async()=>{
 const s=await setup('hold',true);const id=await s.launch()
 await until(async()=> (await s.backend.events(id)).some(e=>e.type==='text'))
 await s.backend.cancel(id);await until(async()=> (await s.backend.status(id)).terminal)
 expect(await s.backend.status(id)).toMatchObject({status:'cancelled',exitCode:130})
})
for (const scenario of ['crash','auth']) it(`reports ${scenario} failure`,async()=>{
 const s=await setup(scenario);const id=await s.launch()
 expect(await s.backend.status(id)).toMatchObject({status:'failed'})
 const state=JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8'))
 expect(state.error).toMatch(scenario==='auth'? /not logged in/i : /exited|closed/i)
})
it('distinguishes missing executable',async()=>{
 const s=await setup();const b=createDevinBackend({runsRoot:s.root,command:join(s.root,'absent-devin'),startRunner:runDevinRun})
 const id=await b.launch({agent:'devin',cwd:s.root,promptFile:s.promptFile})
 expect(JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8')).error).toMatch(/binary.*not found/i)
})

for (const scenario of ['negotiation', 'no-session', 'unknown', 'empty', 'prompt-error']) it(`fails honestly on ${scenario}`, async () => {
 const s=await setup(scenario);const id=await s.launch()
 expect(await s.backend.status(id)).toMatchObject({status:'failed',exitCode:1})
 expect((await s.backend.events(id)).some(e=>e.type==='run_failed')).toBe(true)
 const state=JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8'))
 expect(state.error).toMatch(scenario==='negotiation'? /Not logged in/ : scenario==='no-session'? /sessionId/ : scenario==='prompt-error'? /prompt rejected/ : /stop reason/)
})

it('continues after the launching process exits', async () => {
 const s=await setup('hold')
 const moduleUrl=new URL('../dist/runs/devin-backend.js',import.meta.url).href
 const code=`import {createDevinBackend} from ${JSON.stringify(moduleUrl)};const b=createDevinBackend(${JSON.stringify(s.options)});console.log(await b.launch(${JSON.stringify({agent:'devin',cwd:s.root,promptFile:s.promptFile})}))`
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:5000})
 const id=stdout.trim()
 await until(async()=> (await s.backend.events(id)).some(e=>e.type==='text'))
 expect(await s.backend.status(id)).toMatchObject({status:'running'})
 await s.backend.cancel(id)
 await until(async()=> (await s.backend.status(id)).terminal)
})
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
// cli-runner-main.ts: SIGTERM stops the run, the agent included, and the supervisor is gone within 5 s — also when the agent ignores SIGTERM.
for (const scenario of ['hold','ignore-term']) it(`exits within the bound on SIGTERM and stops a ${scenario} agent`, async () => {
 const s=await setup(scenario,true);const id=await s.launch()
 await until(async()=> (await s.backend.events(id)).some(e=>e.type==='text'))
 const {pid}=JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8')) as {pid:number}
 const agent=Number((await promisify(execFile)('pgrep',['-P',String(pid)])).stdout.trim())
 expect(alive(agent)).toBe(true)
 const sent=Date.now();process.kill(pid,'SIGTERM')
 await until(async()=> !alive(pid)&&!alive(agent))
 expect(Date.now()-sent).toBeLessThan(5000)
 expect(JSON.parse(await readFile(join(s.root,id,'state.json'),'utf8'))).toMatchObject({status:'failed',exitCode:1,error:expect.stringContaining('SIGTERM'),finishedAt:expect.any(String)})
})
it('removes ACP_BACKEND and tolerates bypass rejection', async () => {
 const previous=process.env.ACP_BACKEND;process.env.ACP_BACKEND='windsurf'
 try {
  const s=await setup('bypass-error');const id=await s.launch()
  expect(await s.backend.status(id)).toMatchObject({status:'completed'})
  expect((await s.backend.events(id)).some(e=>e.type==='progress'&&String(e.data).includes('mode unavailable'))).toBe(true)
 } finally {if(previous===undefined)delete process.env.ACP_BACKEND;else process.env.ACP_BACKEND=previous}
})
