import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const scenario = process.argv[2]
if (process.argv.includes('--version')) { console.log('fake devin'); process.exit(0) }
if (process.argv.includes('auth')) { console.log(scenario === 'auth' ? 'Not logged in' : 'Logged in'); process.exit(0) }
const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n')
const reply = (id, result) => send({ id, result })
// Signals: SIGTERM ends the fake at once, and so does its stdin closing (the supervisor died), so a test
// that loses its supervisor never leaves an agent behind. `ignore-term` is a `hold` agent that ignores SIGTERM,
// standing in for a real agent that will not stop, so the supervisor's SIGKILL fallback can be tested.
if (scenario === 'ignore-term') process.on('SIGTERM', () => {})
else process.on('SIGTERM', () => process.exit(143))
process.stdin.on('end', () => { if (scenario !== 'ignore-term') process.exit(0) })
let pending = []
const finish = (reason) => { for (const id of pending.reverse()) reply(id, { stopReason: reason }); pending = [] }
createInterface({ input: process.stdin }).on('line', (line) => {
 const m = JSON.parse(line)
 appendFileSync('rpc.jsonl', JSON.stringify(m) + '\n')
 if (m.method === 'initialize') {
  if (process.env.ACP_BACKEND) process.exit(9)
  reply(m.id, { protocolVersion: 1 })
 } else if (m.method === 'session/new') {
  if(scenario === 'negotiation') send({id:m.id,error:{code:-1,message:'Not logged in'}})
  else reply(m.id, scenario === 'no-session' ? {} : { sessionId: 'devin-session' })
 }
 else if (m.method === 'session/set_mode') {
  if(scenario === 'bypass-error') send({id:m.id,error:{code:-1,message:'mode unavailable'}})
  else reply(m.id, {})
 }
 else if (m.method === 'session/prompt') {
  if(scenario === 'prompt-error') {send({id:m.id,error:{code:-1,message:'prompt rejected'}});return}
  pending.push(m.id)
  if(scenario === 'normal') {
   send({id:'permission',method:'session/request_permission',params:{options:[{kind:'reject_once',optionId:'no'},{kind:'allow_always',optionId:'always'},{kind:'allow_once',optionId:'once'}]}})
   send({id:'elicit',method:'elicitation/create',params:{}})
  }
  for (const [sessionUpdate, content] of [['agent_message_chunk', [{content:{type:'text',text:'hello'}}]], ['agent_thought_chunk', 'thinking'], ['tool_call', null]]) send({ method:'session/update', params:{update:{sessionUpdate, content, title:'read file', kind:'read'}} })
  if (scenario === 'crash') setTimeout(() => process.exit(7), 30)
  else if (['normal','bypass-error','unknown','empty'].includes(scenario)) setTimeout(() => finish(scenario === 'unknown' ? 'mystery' : scenario === 'empty' ? '' : 'end_turn'), 50)
  else if (pending.length > 1 || m.params.prompt[0].text === 'correction') setTimeout(() => finish('end_turn'), 100)
 } else if (m.method === 'session/cancel') finish('cancelled')
})
