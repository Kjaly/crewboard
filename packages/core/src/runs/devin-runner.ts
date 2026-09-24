import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CliRunState } from './cli-runner.js'
import { finishSteers, readSteer, transitionSteer } from './steers.js'
export type DevinRunnerArgs = { kind?:'devin'; runDir:string; cwd:string; promptFile:string; command:string; commandArgs?:string[]; model?:string }
type Mail = {id:string;text:string;mode:'auto'|'queue'|'interrupt';status:string;delivery?:string;error?:string}
type Rpc = {id?:number|string;method?:string;params?:any;result?:any;error?:any}
export async function writeDevinJson(file:string,value:unknown):Promise<void> {
 const tmp=`${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
 await writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600});await rename(tmp,file)
}
function textOf(v:any):string {
 if(typeof v==='string') return v
 if(Array.isArray(v)) return v.map(textOf).join('')
 if(v && typeof v==='object') return typeof v.text==='string'?v.text:textOf(v.content)
 return ''
}
async function probe(args:DevinRunnerArgs,env:NodeJS.ProcessEnv,argv:string[]):Promise<string> {
 return new Promise((resolve,reject)=>{
  const c=spawn(args.command,[...(args.commandArgs??[]),...argv],{cwd:args.cwd,env,stdio:['ignore','pipe','pipe']})
  let output=''; const timer=setTimeout(()=>{c.kill('SIGKILL');reject(new Error('Devin login check timed out'))},10000)
  c.stdout.on('data',b=>{output+=String(b)});c.stderr.on('data',b=>{output+=String(b)})
  c.on('error',(e:NodeJS.ErrnoException)=>{clearTimeout(timer);reject(new Error(e.code==='ENOENT'?'Devin binary not found: install Devin or configure its executable':e.message))})
  c.on('close',(code)=>{clearTimeout(timer);if(code!==0)reject(new Error(`Devin ${argv.join(' ')} failed: ${output.trim()}`));else resolve(output)})
 })
}
/** `stop` (the supervisor's SIGTERM, see cli-runner-main.ts) ends the run like a cancel of the agent, but records it as failed. */
export async function runDevinRun(args:DevinRunnerArgs,stop?:AbortSignal):Promise<CliRunState & {finalText:string}> {
 const mailbox=join(args.runDir,'mailbox'), steers=join(args.runDir,'steers')
 await mkdir(mailbox,{recursive:true});await mkdir(steers,{recursive:true});await mkdir(join(args.runDir,'raw'),{recursive:true})
 const state:CliRunState & {finalText:string}={status:'running',exitCode:null,startedAt:new Date().toISOString(),pid:process.pid,finalText:'',usage:{calls:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0}}
 let writes=Promise.resolve()
 const emit=(type:string,data:unknown)=>{writes=writes.then(()=>appendFile(join(args.runDir,'events.jsonl'),JSON.stringify({ts:new Date().toISOString(),type,backend:'devin',data})+'\n'));return writes}
 const save=()=>writeDevinJson(join(args.runDir,'state.json'),state)
 await save()
 const env={...process.env};delete env.ACP_BACKEND
 let child:ChildProcess|undefined, timer:ReturnType<typeof setInterval>|undefined, closed=false,cancelled=false,stopping=false
 let failure:string|undefined,lastReason:string|undefined,interrupting=false,draining=Promise.resolve()
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>|undefined}>()
 const prompts=new Set<Promise<void>>();let seq=0
 const kill=(signal:NodeJS.Signals)=>{if(child?.pid)try{process.kill(-child.pid,signal)}catch{child.kill(signal)}}
 let childDone:Promise<void>=Promise.resolve()
 const stopped=()=>`Run supervisor stopped by ${String(stop?.reason??'signal')}`
 stop?.addEventListener('abort',()=>{stopping=true;kill('SIGTERM')},{once:true})
 const ack=async(m:Mail,status:string,error?:string)=>{
  m.status=status;if(error)m.error=error
  if (await readSteer(args.runDir,m.id)) {
   if(status==='request_sent') await transitionSteer(args.runDir,m.id,'sent')
   else if(status==='response_received') await transitionSteer(args.runDir,m.id,'acknowledged')
  } else await writeDevinJson(join(steers,`${m.id}.json`),m)
  await emit('steer_ack',{id:m.id,status,delivery:m.delivery,...(error?{error}:{})})
 }
 try {
  await probe(args,env,['--version'])
  const auth=await probe(args,env,['auth','status'])
  if(!/\bLogged in\b/.test(auth)||/not logged in/i.test(auth)) throw new Error(`Devin is not logged in: run devin auth login. ${auth.trim()}`)
  if(stop?.aborted) throw new Error(stopped())
  child=spawn(args.command,[...(args.commandArgs??[]),'acp',...(args.model?['--model',args.model]:[])],{cwd:args.cwd,env,detached:true,stdio:['pipe','pipe','pipe']})
  let stderr=''
  child.stderr?.on('data',b=>{stderr=(stderr+String(b)).slice(-4000)})
  child.stdin?.on('error',()=>{})
  childDone=new Promise(resolve=>{
   const finish=(error?:string)=>{
    closed=true
    if(!stopping&&!cancelled) failure=error??'Devin ACP closed before the run finished'
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(error??'Devin ACP closed before response'))}pending.clear();resolve()
   }
   child!.once('error',e=>finish(e.message))
   // Once stopping, the agent exits because we signalled it: an agent that handles SIGTERM exits non-zero, which is no failure.
   child!.once('close',(code)=>{const failed=code&&!stopping?`Devin ACP exited with code ${code}: ${stderr.trim()}`:undefined;if(failed&&!cancelled)failure=failed;finish(failed)})
  })
  const send=(v:Rpc)=>{
   if(closed)throw new Error('Devin ACP is closed')
   writes=writes.then(()=>appendFile(join(args.runDir,'raw','devin.jsonl'),JSON.stringify({direction:'out',...v})+'\n'))
   child!.stdin!.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n')
  }
  const request=(method:string,params:unknown,timeout=30000)=>new Promise<any>((resolve,reject)=>{
   const id=++seq
   const timeoutId=timeout?setTimeout(()=>{pending.delete(id);reject(new Error(`Devin ACP ${method} timed out`))},timeout):undefined
   pending.set(id,{resolve,reject,timer:timeoutId});try{send({id,method,params})}catch(e){pending.delete(id);clearTimeout(timeoutId);reject(e)}
  })
  const rl=createInterface({input:child.stdout!})
  rl.on('line',line=>{
   writes=writes.then(()=>appendFile(join(args.runDir,'raw','devin.jsonl'),line+'\n'))
   let m:Rpc;try{m=JSON.parse(line)}catch{failure='Invalid JSON from Devin ACP';kill('SIGTERM');return}
   if(m.method && m.id!==undefined) {
    if(m.method==='session/request_permission') {
     const opts=m.params?.options??[];const opt=opts.find((o:any)=>o.kind==='allow_once')??opts.find((o:any)=>String(o.kind).startsWith('allow'))
     send({id:m.id,result:{outcome:opt?{outcome:'selected',optionId:opt.optionId}:{outcome:'cancelled'}}})
    } else if(m.method==='elicitation/create')send({id:m.id,result:{action:'cancel'}})
   } else if(m.method==='session/update') {
    const u=m.params?.update??{},type=u.sessionUpdate
    if(type==='agent_message_chunk'){const text=textOf(u.content);state.finalText+=text;void emit('text',text);void emit('answer_delta',text)}
    else if(type==='agent_thought_chunk')void emit('thought',textOf(u.content))
    else if(type==='tool_call'){void emit('tool',u.title??u.kind??'tool');void emit('tool_started',u.title??u.kind??'tool')}
    else void emit('progress',u)
   } else if(m.method)void emit('progress',{method:m.method,params:m.params})
   else if(typeof m.id==='number') {
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer)
    if(m.error)p.reject(new Error(`Devin ACP: ${m.error.message??JSON.stringify(m.error)}`));else p.resolve(m.result)
   }
  })
  await request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'crewboard',version:'0.2.0'}},60000)
  const session=await request('session/new',{cwd:args.cwd,mcpServers:[]},60000)
  if(!session?.sessionId)throw new Error('Devin ACP session/new returned no sessionId')
  state.sessionId=session.sessionId;await save()
  const sessionId=state.sessionId
  try{await request('session/set_mode',{sessionId,modeId:'bypass'})}catch(e){await emit('progress',String(e))}
  const prompt=(text:string,m?:Mail)=>{
   const response=request('session/prompt',{sessionId,prompt:[{type:'text',text}]},0)
   void response.catch(()=>{})
   const task=(async()=>{
    try {
     if(m)await ack(m,'request_sent')
     const result=await response;if(m)await ack(m,'response_received');lastReason=String(result?.stopReason??'').toLowerCase();state.usage.calls++
     const status=['end_turn','endturn'].includes(lastReason)?'completed':['cancelled','canceled'].includes(lastReason)?'cancelled':'failed'
     if(status==='failed')failure=`Devin ACP unknown stop reason: ${lastReason||'(empty)'}`
     await emit('turn_ended',{stopReason:lastReason});if(m)await ack(m,status)
    }catch(e){failure=String(e);if(m)await ack(m,'failed',failure)}
   })()
   prompts.add(task);void task.finally(()=>prompts.delete(task));return task
  }
  const drain=()=>{
   draining=draining.then(async()=>{
    const names=(await readdir(mailbox)).sort()
    if(names.includes('cancel.json')){cancelled=true;send({method:'session/cancel',params:{sessionId}});return}
    for(const name of names.filter(n=>n.startsWith('steer-')&&n.endsWith('.json'))) {
     const m=JSON.parse(await readFile(join(mailbox,name),'utf8')) as Mail
     await ack(m,'delivering');await rm(join(mailbox,name))
     if(m.mode==='interrupt') {
      m.delivery='acp_cancel_then_prompt';interrupting=true;send({method:'session/cancel',params:{sessionId}})
      const deadline=Date.now()+30000
      while(prompts.size&&!closed&&!cancelled&&Date.now()<deadline) {
       if((await readdir(mailbox)).includes('cancel.json')){cancelled=true;break}
       await new Promise(r=>setTimeout(r,50))
      }
      interrupting=false
     }else m.delivery='acp_concurrent_prompt'
     if(closed||cancelled||failure)await ack(m,'failed',failure??'Run stopped before delivery')
     else void prompt(m.text,m)
    }
   }).catch(e=>{failure=String(e)})
   return draining
  }
  void prompt(await readFile(args.promptFile,'utf8'))
  timer=setInterval(()=>void drain(),100)
  while(!cancelled&&!failure&&!closed&&!stop?.aborted) {
   await new Promise(r=>setTimeout(r,25))
   if(!prompts.size&&!interrupting){await drain();if(!prompts.size&&!interrupting)break}
  }
  clearInterval(timer);await draining
  if(cancelled)send({method:'session/cancel',params:{sessionId}})
  if(!cancelled&&!failure)cancelled=['cancelled','canceled'].includes(lastReason??'')
 }catch(e){failure=e instanceof Error?e.message:String(e)}
 finally {
  clearInterval(timer);stopping=true;kill('SIGTERM')
  const hard=setTimeout(()=>kill('SIGKILL'),3000)
  await childDone;kill('SIGKILL');clearTimeout(hard);await Promise.all(prompts)
 }
 // Every accepted message gets a durable terminal disposition, including late arrivals.
 for(const name of (await readdir(mailbox)).filter(n=>n.startsWith('steer-')&&n.endsWith('.json'))) {
  const m=JSON.parse(await readFile(join(mailbox,name),'utf8')) as Mail
  await ack(m,'failed','Run finished before delivery');await rm(join(mailbox,name))
 }
 if(stop?.aborted&&!cancelled)failure=stopped()
 state.status=cancelled?'cancelled':failure?'failed':'completed';state.exitCode=cancelled?130:failure?1:0;state.finishedAt=new Date().toISOString()
 if(failure&&!cancelled){state.error=failure;await emit('run_failed',failure)}
 await emit('final',state.finalText);await emit('done',{status:state.status,text:state.finalText});await writes;await finishSteers(args.runDir,state.status==='completed'?'run_finished':state.status==='cancelled'?'cancelled':'run_failed',save);return state
}
