// Fills a fresh temporary Git repository with a demo goal in every state the screen knows, without running any
// worker: the journal is written line by line in the format the server reads. Prints the environment to start
// `crewboard serve` on it. Used for screenshots and the walkthrough video (scripts/capture-media.mjs).
//
//   node scripts/seed-demo.mjs [--dir <empty folder>] [--lang ru|en]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'ru'
const tr = (ruText, enText) => (lang === 'en' ? enText : ruText)
const base = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : mkdtempSync(join(tmpdir(), 'crewboard-demo-'))
mkdirSync(base, { recursive: true })
const repo = join(base, 'kitchen-planner')
mkdirSync(repo, { recursive: true })
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
git('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'README.md'), '# Kitchen planner\n')
git('add', '.')
git('-c', 'user.email=demo@example.com', '-c', 'user.name=demo', 'commit', '-q', '-m', 'init')
const root = realpathSync(repo)

const home = join(base, 'home')
const claude = join(base, 'claude-projects')
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'projects.json'), `${JSON.stringify({ projects: [root] }, null, 2)}\n`)
// One agent of the owner's own, next to the built-in three: Kimi reached through a dsh route.
const agentsFile = `${JSON.stringify({ agents: { kimi: { label: 'Kimi', run: 'dsh', model: 'moonshot/kimi-k3' } } }, null, 2)}\n`
writeFileSync(join(home, 'agents.json'), agentsFile)
// The same agents with no project yet: the first-run screen.
const emptyHome = join(base, 'home-empty')
mkdirSync(emptyHome, { recursive: true })
writeFileSync(join(emptyHome, 'agents.json'), agentsFile)
// No Codex or dsh sessions: the demo's history must never pick up the machine's own.
const noSessions = join(base, 'no-sessions')
mkdirSync(noSessions, { recursive: true })

const now = Date.now()
const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString()
const goalId = 'kitchen-1f2a'
const events = []
const ev = (minAgo, e) => events.push({ goalId, actor: 'system', ...e, seq: events.length + 1, ts: at(minAgo) })
const assign = (minAgo, id, title, provider, extra = {}) =>
  ev(minAgo, { type: 'assigned', assignmentId: id, actor: 'lead', parentId: goalId, title, criteria: [], resultKind: 'local', provider, after: [], ...extra })
const run = (minAgo, id, agent, n) => ev(minAgo, { type: 'run_started', assignmentId: id, runId: `demo-${id}-${n}`, agent, cwd: root })
const end = (minAgo, id, n, usage) => ev(minAgo, { type: 'run_ended', assignmentId: id, runId: `demo-${id}-${n}`, outcome: 'completed', ...(usage ? { usage } : {}) })

ev(62, { type: 'goal_started', assignmentId: goalId, actor: 'lead', title: tr('Кухня полного цикла', 'Full-cycle kitchen'), criteria: tr(['Покупатель собирает кухню сам, без подсказок', 'Короб, фурнитура и вырезы считаются из одной модели', 'Сборочная инструкция строится из модели'], ['The buyer assembles the kitchen alone, no help needed', 'Carcass, hardware and cut-outs come from one model', 'The assembly guide is built from the model']), client: 'claude-code', quote: tr('Хочу кухню полного цикла: как у шкафа, только с ящиками, мойкой и сборкой.', 'I want a full-cycle kitchen: like the wardrobe, but with drawers, a sink and assembly.') })

assign(60, 'hw', tr('Исследовать петли и направляющие для кухни', 'Research hinges and runners for the kitchen'), 'deepseek', { resultKind: 'answer', criteria: tr(['Не меньше трёх производителей', 'Совместимость с толщиной фасада'], ['At least three manufacturers', 'Fits the front panel thickness']), quote: tr('Встроенная мойка, подсветку тоже, собирает сам покупатель.', 'Built-in sink, lighting too, the buyer assembles it.') })
run(60, 'hw', 'dsh/deepseek-flash', 1)
ev(41, { type: 'progress', assignmentId: 'hw', actor: 'worker', text: tr('Сравниваю Blum, Hettich и GTV по толщине фасада', 'Comparing Blum, Hettich and GTV by front thickness') })
ev(34, { type: 'reported', assignmentId: 'hw', actor: 'worker', summary: tr('Таблица совместимости готова: четыре производителя, петли и направляющие под фасады 16 и 18 мм.', 'Compatibility table ready: four manufacturers, hinges and runners for 16 and 18 mm fronts.') })
end(34, 'hw', 1, { inputTokens: 41200, outputTokens: 3900 })
ev(33, { type: 'closed', assignmentId: 'hw', actor: 'lead', summary: tr('Критерии выполнены: четыре производителя, совместимость по толщине.', 'Criteria met: four manufacturers, thickness compatibility.') })

assign(59, 'box', tr('Модель короба кухни в 2D и 3D', 'Kitchen carcass model in 2D and 3D'), 'codex', { model: 'gpt-6.1-sol', criteria: tr(['Короб строится из панелей с реальной толщиной', 'Вырезы под мойку и варочную замкнуты', 'Тесты геометрии зелёные'], ['The carcass is built from panels of real thickness', 'Sink and hob cut-outs are closed shapes', 'Geometry tests are green']), quote: tr('Раздай работу, начни с короба.', 'Hand the work out, start with the carcass.') })
run(58, 'box', 'codex/gpt-6.1-sol', 1)
ev(30, { type: 'progress', assignmentId: 'box', actor: 'worker', text: tr('Делю работу: тесты геометрии и независимое ревью', 'Splitting the work: geometry tests and an independent review') })
ev(29, { type: 'reported', assignmentId: 'box', actor: 'worker', summary: tr('Короб готов, остаются тесты вырезов и ревью.', 'Carcass done; cut-out tests and the review remain.'), split: true })
ev(29, { type: 'assigned', assignmentId: 'geo', actor: 'worker', parentId: 'box', title: tr('Тесты геометрии вырезов', 'Cut-out geometry tests'), criteria: tr(['Покрыты прямоугольные и скруглённые вырезы'], ['Rectangular and rounded cut-outs covered']), resultKind: 'local', provider: 'codex', model: 'gpt-6-luna', after: [] })
ev(29, { type: 'assigned', assignmentId: 'rev', actor: 'worker', parentId: 'box', title: tr('Независимое ревью изменений короба', 'Independent review of the carcass changes'), criteria: tr(['Замечания с приоритетами'], ['Findings with priorities']), resultKind: 'answer', provider: 'claude', after: ['geo'] })
end(29, 'box', 1, { inputTokens: 182000, outputTokens: 24100, apiUsd: 0.62 })
run(28, 'geo', 'codex/gpt-6-luna', 1)
ev(3, { type: 'progress', assignmentId: 'geo', actor: 'worker', text: tr('Пишет тесты, готово 6 из 9', 'Writing tests, 6 of 9 done') })

assign(57, 'ux', tr('Мобильная панель свойств кухни', 'Mobile kitchen properties panel'), 'claude', { criteria: tr(['Модель, библиотека и свойства доступны одной рукой', 'Работает в обеих темах'], ['Model, library and properties reachable with one hand', 'Works in both themes']), quote: tr('И мобильную версию сразу, я часто смотрю с телефона.', 'And the mobile version right away, I often check from my phone.') })
run(57, 'ux', 'claude/sonnet', 1)
ev(14, { type: 'question', assignmentId: 'ux', actor: 'worker', text: tr('Панель свойств на телефоне: шторка снизу или полноэкранный слой?', 'Properties panel on a phone: bottom sheet or full-screen layer?'), options: tr(['Шторка снизу', 'Полноэкранный слой'], ['Bottom sheet', 'Full-screen layer']) })
end(14, 'ux', 1, { inputTokens: 64000, outputTokens: 9100, usd: 0.38 })
ev(13, { type: 'escalated', assignmentId: 'ux', actor: 'lead', text: tr('Панель свойств на телефоне: шторка снизу или полноэкранный слой?', 'Properties panel on a phone: bottom sheet or full-screen layer?'), options: tr(['Шторка снизу', 'Полноэкранный слой'], ['Bottom sheet', 'Full-screen layer']), why: tr('Это вопрос вашего вкуса, я не стал решать за вас', 'This is a matter of your taste, so I did not decide for you') })

assign(56, 'light', tr('Подсветка, розетки и ручные трассы', 'Lighting, sockets and manual routing'), 'codex', { quote: tr('Подсветку тоже.', 'Lighting too.') })
run(56, 'light', 'codex/gpt-6.1-sol', 1)
ev(48, { type: 'cancelled', assignmentId: 'light', actor: 'lead', reason: tr('Курс изменён: подсветку перенесли в следующий этап', 'Change of course: lighting moved to the next stage') })
end(48, 'light', 1, { inputTokens: 21000, outputTokens: 2300 })

assign(55, 'pdf', tr('Сборочная инструкция из модели', 'Assembly guide from the model'), 'deepseek', { quote: tr('Собирает сам покупатель, значит нужна инструкция.', 'The buyer assembles it, so a guide is needed.') })
run(40, 'pdf', 'dsh/deepseek-flash', 1)
ev(8, { type: 'progress', assignmentId: 'pdf', actor: 'worker', text: tr('Раскладываю шаги сборки по панелям короба', 'Laying out assembly steps across the carcass panels') })
ev(6, { type: 'owner_requested', assignmentId: 'pdf', actor: 'owner', requestId: 'r-demo1', action: 'stop' })
ev(5, { type: 'request_decided', assignmentId: 'pdf', actor: 'lead', requestId: 'r-demo1', decision: 'declined', reason: tr('Инструкция нужна покупателю для сборки, остановка сорвёт цель', 'The buyer needs the guide to assemble; stopping it would break the goal') })
assign(26, 'copy', tr('Текст страницы товара', 'Product page copy'), 'kimi', { criteria: tr(['Три абзаца: что это, из чего, как собрать', 'Без обещаний сроков доставки'], ['Three paragraphs: what it is, what it is made of, how to assemble', 'No delivery-time promises']), quote: tr('И текст для страницы товара.', 'And the copy for the product page.') })
run(25, 'copy', 'dsh/moonshot/kimi-k3', 1)
ev(9, { type: 'reported', assignmentId: 'copy', actor: 'worker', summary: tr('Текст готов: три абзаца, сроки доставки не упомянуты.', 'Copy ready: three paragraphs, no delivery times mentioned.') })
end(9, 'copy', 1, { inputTokens: 38000, outputTokens: 5200, usd: 0.04 })

const goalDir = join(root, '.crewboard', 'goals', goalId)
mkdirSync(goalDir, { recursive: true })
writeFileSync(join(root, '.crewboard', '.gitignore'), '*\n')
writeFileSync(join(goalDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`)
writeFileSync(join(goalDir, 'meta.json'), `${JSON.stringify({ goalId, title: tr('Кухня полного цикла', 'Full-cycle kitchen'), createdAt: at(62), leadLastSeen: new Date(now).toISOString(), lead: { client: 'claude-code', version: '2.1.316' } }, null, 2)}\n`)

// The lead's conversation, in the shape Claude Code writes its transcripts.
const session = 'demo-session-1'
const lines = []
let n = 0
const line = (minAgo, row) => lines.push({ uuid: `d${++n}`, parentUuid: null, sessionId: session, timestamp: at(minAgo), isSidechain: false, cwd: root, ...row })
const owner = (m, text) => line(m, { type: 'user', message: { role: 'user', content: text } })
const lead = (m, text) => line(m, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (m, id, tool, input, result) => {
  line(m, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__crewboard__crewboard_${tool}`, input: { project: root, ...input } }] } })
  line(m, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(result) }] }] } })
}
owner(64, tr('Хочу кухню полного цикла: как у шкафа, только с ящиками, мойкой и сборкой.', 'I want a full-cycle kitchen: like the wardrobe, but with drawers, a sink and assembly.'))
lead(63, tr('Уточню три вещи: мойка встроенная или накладная, нужна ли подсветка в этом этапе и кто собирает.', 'Three questions: built-in or overlay sink, is lighting in this stage, and who assembles.'))
owner(63, tr('Встроенная мойка, подсветку тоже, собирает сам покупатель. И мобильную версию сразу, я часто смотрю с телефона.', 'Built-in sink, lighting too, the buyer assembles it. And the mobile version right away, I often check from my phone.'))
lead(62, tr('Договорились о критериях. Ставлю цель и раздаю работу.', 'We agreed on the criteria. Setting the goal and handing out the work.'))
call(62, 't1', 'start_goal', { title: tr('Кухня полного цикла', 'Full-cycle kitchen'), criteria: [] }, { goalId })
call(60, 't2', 'assign', { goalId, title: tr('Исследовать петли и направляющие для кухни', 'Research hinges and runners for the kitchen'), provider: 'deepseek' }, { assignmentId: 'hw' })
call(59, 't3', 'assign', { goalId, title: tr('Модель короба кухни в 2D и 3D', 'Kitchen carcass model in 2D and 3D'), provider: 'codex' }, { assignmentId: 'box' })
call(57, 't4', 'assign', { goalId, title: tr('Мобильная панель свойств кухни', 'Mobile kitchen properties panel'), provider: 'claude' }, { assignmentId: 'ux' })
call(56, 't5', 'assign', { goalId, title: tr('Подсветка, розетки и ручные трассы', 'Lighting, sockets and manual routing'), provider: 'codex' }, { assignmentId: 'light' })
call(55, 't6', 'assign', { goalId, title: tr('Сборочная инструкция из модели', 'Assembly guide from the model'), provider: 'deepseek' }, { assignmentId: 'pdf' })
owner(49, tr('Подсветку давай потом, сначала короб.', 'Lighting later, the carcass first.'))
call(48, 't7', 'cancel', { goalId, assignmentId: 'light', reason: tr('Курс изменён', 'Change of course') }, { ok: true })
lead(48, tr('Отменил ветку с подсветкой, остальное идёт.', 'Cancelled the lighting branch, the rest is running.'))
call(33, 't8', 'close', { goalId, assignmentId: 'hw', summary: tr('Критерии выполнены', 'Criteria met') }, { ok: true })
call(13, 't9', 'escalate', { goalId, assignmentId: 'ux', why: tr('Вопрос вкуса', 'A matter of taste') }, { ok: true })
lead(13, tr('Исполнитель по мобильной панели спрашивает, шторка снизу или полноэкранный слой. Тут решать вам, вопрос на экране.', 'The mobile panel worker asks: bottom sheet or full-screen layer. This is yours to decide, the question is on the screen.'))
lead(5, tr('Остановку инструкции я отклонил: она нужна покупателю для сборки.', 'I declined stopping the guide: the buyer needs it to assemble.'))
const folder = join(claude, root.replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, `${session}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

console.log(JSON.stringify({ repo: root, goalId, emptyHome, env: { CREWBOARD_HOME: home, CREWBOARD_CLAUDE_PROJECTS: claude, CREWBOARD_CODEX_SESSIONS: noSessions, CREWBOARD_DSH_SESSIONS: noSessions } }, null, 2))
