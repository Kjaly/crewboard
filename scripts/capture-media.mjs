// Captures the documentation's screenshots and walkthroughs from the live app on demo data (scripts/seed-demo.mjs),
// in English and Russian, and dresses them in a studio frame (scripts/media/).
// Workers are replaced by a script that sleeps, so an answer or a request on screen never starts a real agent.
//
//   PLAYWRIGHT=<path to the playwright package> CHROMIUM=<browser executable> node scripts/capture-media.mjs [--lang en|ru] [--only shots|video]
// Needs ffmpeg on PATH. Writes docs/assets/<lang>/{now,request,history,analytics,mobile,empty}-{dark,light}.png,
// walkthrough.mp4 and walkthrough.gif.
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { framePhone, frameWindow, videoMask, videoStage } from './media/scene.mjs'
import { director, studioInit } from './media/studio.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const langs = opt('--lang') ? [opt('--lang')] : ['en', 'ru']
const only = opt('--only')
const port = 4791
const url = `http://127.0.0.1:${port}/`
const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href : 'playwright')
const chromium = pw.chromium ?? pw.default.chromium

/** What the scripts click, by the label the screen shows in each language. */
const L = {
  en: {
    locale: 'en-US', history: 'History', analytics: 'Analytics', now: 'Now', guide: /Assembly guide/, mobile: /Mobile kitchen properties/, geo: /^Cut-out geometry tests/,
    firstWords: 'I want a full-cycle kitchen', option: 'Bottom sheet', handoff: 'Hand over to another agent', handoffSend: 'Ask to hand over',
    cap: {
      intro: '<h1>Crew<b>board</b></h1><p>One chat leads: Claude Code, Codex or dsh. Any agent does the work.</p>',
      tree: 'The tree shows who is doing what, right now',
      question: 'A worker’s question reached you: answer in one click',
      request: 'Every action is a request. The lead decides',
      history: 'History: the whole conversation with the lead',
      analytics: 'Analytics: who was busy and what it cost',
      outro: '<h1>Crew<b>board</b></h1><p>Local, open source, MIT.</p><code>github.com/Kjaly/crewboard</code>',
    },
  },
  ru: {
    locale: 'ru-RU', history: 'История', analytics: 'Аналитика', now: 'Сейчас', guide: /Сборочная инструкция/, mobile: /Мобильная панель/, geo: /^Тесты геометрии/,
    firstWords: 'Хочу кухню полного цикла', option: 'Шторка снизу', handoff: 'Передать другому агенту', handoffSend: 'Попросить передать',
    cap: {
      intro: '<h1>Crew<b>board</b></h1><p>Ведёт один чат: Claude Code, Codex или dsh. Работает любой агент.</p>',
      tree: 'Дерево показывает, кто чем занят прямо сейчас',
      question: 'Вопрос исполнителя дошёл до вас: ответ в один клик',
      request: 'Любое действие — это просьба. Решает ведущий',
      history: 'История: весь разговор с ведущим',
      analytics: 'Аналитика: кто был загружен и сколько это стоило',
      outro: '<h1>Crew<b>board</b></h1><p>Локально, открытый код, MIT.</p><code>github.com/Kjaly/crewboard</code>',
    },
  },
}

/** Seeds the demo goal in a neutral folder (so no user directory shows on screen) and starts the server on it. */
const startDemo = async (lang, o = {}) => {
  const demoDir = join('/tmp', 'crewboard-demo')
  rmSync(demoDir, { recursive: true, force: true })
  const seed = JSON.parse(execFileSync('node', [join(root, 'scripts', 'seed-demo.mjs'), '--dir', demoDir, '--lang', lang, '--pid', String(process.pid)]).toString())
  // A stand-in worker that just keeps working: an answer or a handover on screen shows a live run, and no agent starts.
  // It also answers the readiness checks the first-run screen shows (version, sign-in, dsh profile), with no CLI run.
  const stub = (name, version) => {
    const file = join(demoDir, `${name}.sh`)
    const answers = [
      `[ "$1" = "--version" ] && { echo "${version}"; exit 0; }`,
      `[ "$1 $2 $3" = "auth status --json" ] && { echo '{"loggedIn":true}'; exit 0; }`,
      `[ "$1 $2" = "login status" ] && { echo 'Logged in using ChatGPT'; exit 0; }`,
      `[ "$1 $3" = "--profile --dump-config" ] && exit 0`,
      '[ "$1" = "--help" ] && { echo "--bare"; exit 0; }',
    ]
    writeFileSync(file, `#!/bin/sh\n${answers.join('\n')}\nexec sleep 90\n`, { mode: 0o755 })
    return file
  }
  // DeepSeek's balance API, answered locally: the panel shows money left without a request leaving the machine.
  const balance = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '18.42', granted_balance: '0.00', topped_up_balance: '18.42' }] })))
  await new Promise((r) => balance.listen(0, '127.0.0.1', r))
  const server = spawn('node', [join(root, 'packages', 'crewboard', 'dist', 'main.js'), 'serve', '--port', String(port)], {
    env: {
      // The operator's own Crewboard settings (a dsh argument list, a runner) could route a check to a real CLI.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CREWBOARD_') && !k.startsWith('ORCH_'))), ...seed.env, ...(o.empty ? { CREWBOARD_HOME: seed.emptyHome } : {}), ANTHROPIC_API_KEY: 'demo-not-used', DEEPSEEK_API_KEY: 'demo-not-used', DEEPSEEK_BASE_URL: `http://127.0.0.1:${balance.address().port}`, MOONSHOT_API_KEY: '', CREWBOARD_CLAUDE_USAGE: 'log',
      CREWBOARD_CLAUDE_COMMAND: stub('claude', '2.1.316 (Claude Code)'), CREWBOARD_CODEX_COMMAND: stub('codex', 'codex-cli 0.166.0'), CREWBOARD_DSH_COMMAND: stub('dsh', '0.1.5'),
    },
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${url}api/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return () =>
    new Promise((r) => {
      balance.close()
      server.once('exit', r)
      server.kill('SIGTERM')
    })
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const work = mkdtempSync(join(tmpdir(), 'crewboard-media-'))
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`

const shots = async (lang) => {
  const l = L[lang]
  const out = join(root, 'docs', 'assets', lang)
  mkdirSync(out, { recursive: true })
  const stop = await startDemo(lang)
  const raw = async (name, scheme, opts, act) => {
    const context = await browser.newContext({ locale: l.locale, viewport: opts.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}) })
    const page = await context.newPage()
    await page.goto(url)
    if (opts.empty) await page.locator('.workers li').first().waitFor()
    else await page.getByRole('tree').waitFor()
    await page.evaluate(() => document.fonts.ready)
    if (act) await act(page)
    await page.waitForTimeout(500)
    const file = join(work, `${lang}-${name}-${scheme}.png`)
    await page.screenshot({ path: file })
    await context.close()
    return file
  }
  const plan = [
    ['now', {}, undefined],
    ['request', {}, (p) => p.getByRole('treeitem', { name: l.guide }).click()],
    ['history', {}, (p) => p.getByRole('tab', { name: l.history }).click().then(() => p.getByText(l.firstWords).first().waitFor())],
    ['analytics', {}, (p) => p.getByRole('tab', { name: l.analytics }).click().then(() => p.getByRole('table').first().waitFor())],
    ['mobile', { viewport: { width: 390, height: 844 }, mobile: true }, (p) => p.getByRole('treeitem', { name: l.mobile }).click()],
  ]
  for (const [name, opts, act] of plan)
    for (const scheme of ['dark', 'light']) {
      const src = await raw(name, scheme, opts, act)
      const file = join(out, `${name}-${scheme}.png`)
      if (name === 'mobile') await framePhone(browser, { src, scheme, out: file })
      else await frameWindow(browser, { src, scheme, out: file })
      console.log(`captured ${lang}/${name}-${scheme}.png (${kb(file)})`)
    }
  await stop()
  // The first-run screen: no goal yet, how to connect a lead, which workers are ready.
  const stopEmpty = await startDemo(lang, { empty: true })
  for (const scheme of ['dark', 'light']) {
    const src = await raw('empty', scheme, { empty: true }, undefined)
    const file = join(out, `empty-${scheme}.png`)
    await frameWindow(browser, { src, scheme, out: file })
    console.log(`captured ${lang}/empty-${scheme}.png (${kb(file)})`)
  }
  await stopEmpty()
}

const W = 1280
const H = 800
const CANVAS = { w: 1920, h: 1080 }

const video = async (lang) => {
  const l = L[lang]
  const out = join(root, 'docs', 'assets', lang)
  mkdirSync(out, { recursive: true })
  const stop = await startDemo(lang)
  const dir = mkdtempSync(join(work, `video-${lang}-`))
  const context = await browser.newContext({ locale: l.locale, viewport: { width: W, height: H }, colorScheme: 'dark', recordVideo: { dir, size: { width: W, height: H } } })
  await context.addInitScript(studioInit)
  const page = await context.newPage()
  const d = director(page)
  await page.goto(url)
  await d.card(l.cap.intro)
  await page.getByRole('tree').waitFor()
  await page.evaluate(() => document.fonts.ready)
  await d.pause(2600)
  await d.card(null)
  await d.pause(700)

  await d.caption(l.cap.tree)
  await d.glide(page.getByRole('treeitem', { name: l.geo }), 900)
  await d.pause(600)
  await d.glide(page.getByRole('treeitem', { name: l.guide }), 700)
  await d.pause(1600)

  await d.caption(l.cap.question)
  await d.zoom(page.locator('.qbox'), 1.55)
  await d.click(page.getByRole('button', { name: l.option, exact: true }), 900)
  await d.pause(1800)
  await d.zoom(null)

  await d.caption(l.cap.request)
  await d.click(page.getByRole('treeitem', { name: l.geo }), 800)
  await d.pause(700)
  await d.zoom(page.locator('.na'), 1.45)
  await d.click(page.getByRole('button', { name: new RegExp(`^${l.handoff}`) }), 800)
  await d.pause(500)
  await d.click(page.getByRole('radio', { name: /Claude/ }), 700)
  await d.pause(400)
  // The chip of the chosen agent opens its model and effort card. The card places itself from on-screen
  // coordinates, which the camera zoom would stretch, so the camera steps back first.
  await d.zoom(null)
  await d.click(page.locator('.na-ag[data-checked=true] .na-chip'), 700)
  await page.locator('.na-pop').waitFor({ state: 'visible', timeout: 3000 })
  await d.pause(1800)
  await page.keyboard.press('Escape')
  await d.pause(300)
  await d.click(page.getByRole('button', { name: l.handoffSend }), 700)
  await d.pause(2000)

  await d.caption(l.cap.history)
  await d.click(page.getByRole('tab', { name: l.history }), 800)
  await d.pause(800)
  await d.glideTo(640, 520, 900)
  await page.mouse.wheel(0, 360)
  await d.pause(2200)

  await d.caption(l.cap.analytics)
  await d.click(page.getByRole('tab', { name: l.analytics }), 800)
  await d.pause(2800)
  await d.caption('')
  await d.card(l.cap.outro)
  await d.pause(3000)
  await context.close()
  await stop()

  const webm = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')))
  const stage = join(dir, 'stage.png')
  const mask = join(dir, 'mask.png')
  await videoStage(browser, { scheme: 'dark', out: stage, w: W, h: H, canvas: CANVAS })
  await videoMask(browser, { out: mask, w: W, h: H })
  const x = (CANVAS.w - W) / 2
  const y = (CANVAS.h - (H + 40)) / 2 + 40
  const mp4 = join(out, 'walkthrough.mp4')
  const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a])
  // The stage and the mask loop forever: the recording's own length ends the output.
  const seconds = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm]).toString().trim()
  ff('-loop', '1', '-i', stage, '-i', webm, '-loop', '1', '-i', mask,
    '-filter_complex', `[1:v]fps=30,format=rgba[v];[2:v]format=gray[m];[v][m]alphamerge[vm];[0:v][vm]overlay=${x}:${y}:shortest=1,format=yuv420p`,
    '-t', seconds, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-movflags', '+faststart', mp4)
  const palette = join(dir, 'palette.png')
  const scale = 'fps=8,scale=880:-1:flags=lanczos'
  ff('-i', mp4, '-vf', `${scale},palettegen=max_colors=96:stats_mode=diff`, palette)
  const gif = join(out, 'walkthrough.gif')
  ff('-i', mp4, '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, gif)
  console.log(`captured ${lang}/walkthrough.mp4 (${kb(mp4)}), walkthrough.gif (${kb(gif)})`)
}

try {
  for (const lang of langs) {
    if (only !== 'video') await shots(lang)
    if (only !== 'shots') await video(lang)
  }
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
