# Crewboard: любой ведущий — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Часть 3 дизайна «любой ведущий, любой исполнитель»: ведущим может быть любой MCP-клиент (Claude Code, Codex, dsh и другие); Crewboard знает, кто ведёт цель, даёт команды подключения для известных клиентов, читает историю из транскриптов Claude Code и Codex (и dsh, если формат удаётся прочитать), а для остальных показывает ход работы из своего журнала.

**Architecture:** Кто ведёт, Crewboard узнаёт сам из `clientInfo` MCP-инициализации, без нового параметра в инструментах: имя клиента записывается в мету цели при каждом вызове инструмента по цели. Вкладка «История» опрашивает набор читателей транскриптов (по одному на клиент); если ни один не нашёл разговор по цели, история строится из журнала. Тексты экрана и документации говорят «ведущий» и дают команды подключения для каждого известного клиента.

**Tech Stack:** Node 24 (`node:zlib` с zstd), TypeScript, pnpm 11.5.2, vitest, Testing Library, MCP SDK 1.32.2, React 18.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-any-lead-any-agent-design.md` (часть 3).

## Global Constraints

- История только читает транскрипты клиентов и никогда туда не пишет.
- Журнал только дописывается; старые журналы и мета-файлы без новых полей читаются как раньше.
- Каждый новый текст интерфейса — в `src/ui/i18n/ru.ts` и `en.ts`; английские руководства — источник, русские — пара.
- Форматы транскриптов чужих клиентов не документированы: всё неожиданное пропускается, ничего не бросается (как в `history/transcript.ts`).
- Тесты: мало, про поведение; образцы транскриптов — маленькие фикстуры в `test/`, версии клиентов записаны в комментарии фикстуры.
- Коммиты — Conventional Commits без scope, с `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Цель, которую вёл Codex, а потом подхватил Claude Code: история показывает оба разговора по порядку и смену ведущего (тест в Task 3).
2. Транскриптов нет вовсе (неизвестный клиент): вкладка «История» не пустая, показывает ход работы и честно говорит, что разговора нет (тест в Task 5).
3. Файл транскрипта Codex с незнакомыми строками, битым JSON, служебными сообщениями окружения (`<environment_context>`): разговор читается, служебное не выдаётся за слова владельца (строки в Task 3).
4. Сотни старых файлов в `~/.codex/sessions`: история не перечитывает их на каждом запросе (кэш по размеру и времени, отбор по времени цели) — тест в Task 3.
5. MCP-клиент без `clientInfo.name`: цель работает, ведущий показан как «ведущий» без имени (строка в Task 1).

---

### Task 1: Кто ведёт цель

**Files:**
- Modify: `packages/crewboard/src/lead/mcp.ts` (имя клиента сессии из `server.server.getClientVersion()`), `packages/crewboard/src/lead/commands.ts` (передача клиента в отметку присутствия)
- Modify: `packages/crewboard/src/store/event-store.ts` (`GoalMeta.lead?: { client: string; version?: string }`, `touchLead(goalId, now, lead?)`)
- Modify: `packages/crewboard/src/model/types.ts` (событие `adopted` получает необязательное `client`)
- Modify: `packages/crewboard/src/owner.ts` (`GoalSummary.lead?: string`), `packages/crewboard/src/ui/components/sidebar.tsx` и `context-panel.tsx` (подпись ведущего)
- Create: `packages/crewboard/src/lead/clients.ts`
- Test: `packages/crewboard/test/lead-flow.test.ts`, `packages/crewboard/test/agents.test.ts` (строки для меток клиентов)

**Interfaces:**
- Produces в `src/lead/clients.ts`: `leadLabel(client: string | undefined): string | undefined` — `claude-code` и всё, что содержит `claude` → `Claude Code`; содержит `codex` → `Codex`; содержит `dsh` или `deepseek` → `dsh`; иное непустое — как есть; пусто → `undefined`. Этот модуль не импортирует серверные модули, экран использует его же.
- `LeadCommands`: каждая команда, принимающая `goalId`, получает от MCP-сессии `lead: { client: string; version?: string } | undefined` и пишет его в мету через `touchLead`. `adopt` пишет событие `adopted` с `client`.
- `GoalSummary.lead` — `leadLabel` клиента из меты.
- Экран: в боковой панели у цели и в контексте корня — «Ведущий: Codex» / «Lead: Codex» (новый ключ `leadIs`), если имя известно.

- [ ] **Step 1: Тесты.** `lead-flow.test.ts`: «remembers which client leads the goal» — клиент `new Client({ name: 'codex-mcp-client', version: '0.160.0' })` ставит цель; `/api/projects` отдаёт у цели `lead: 'Codex'`; второй клиент `claude-code` вызывает `crewboard_adopt_goal`; `lead` становится `Claude Code`, в журнале событие `adopted` с `client: 'claude-code'`. Таблица `leadLabel`: `['claude-code', 'Claude Code']`, `['codex-mcp-client', 'Codex']`, `['dsh-acp', 'dsh']`, `['my-agent', 'my-agent']`, `['', undefined]`.
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/lead-flow.test.ts test/agents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Реализация** по интерфейсам.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: remember which client leads each goal`.

### Task 2: Нейтральные тексты и команды подключения

**Files:**
- Modify: `packages/crewboard/src/ui/text.ts` (`MCP_COMMAND` → `CONNECT_COMMANDS(origin)`), `packages/crewboard/src/ui/components/empty-state.tsx`, `packages/crewboard/src/ui/i18n/{ru,en}.ts`
- Modify: `packages/crewboard/src/main.ts` (подсказка при запуске сервера), `packages/crewboard/src/lead/mcp.ts` (инструкции без упоминания конкретного клиента)
- Modify: `docs/{en,ru}/getting-started.md`, `docs/{en,ru}/lead.md`, `docs/{en,ru}/troubleshooting.md`, `README.md`, `README.ru.md`
- Test: `packages/crewboard/test/ui-now.test.tsx`

**Interfaces:**
- `CONNECT_COMMANDS(origin: string): Array<{ client: 'claude' | 'codex' | 'dsh' | 'other'; label: string; text: string }>`:
  - Claude Code: `claude mcp add --transport http crewboard <origin>/mcp`
  - Codex: `codex mcp add crewboard --url <origin>/mcp`
  - dsh: запись профиля для `@deepseek-ai/dsh-mcp-client` — `serverName: crewboard`, `transport: streamable-http`, `url: <origin>/mcp` (YAML из трёх строк конфигурации, как в README `dsh-mcp-client`);
  - любой другой MCP-клиент: адрес `<origin>/mcp` (Streamable HTTP).
- Пустой экран: заголовок «Подключите ведущего» / «Connect your lead», текст про любой MCP-клиент, переключатель клиентов (кнопки-вкладки) и у выбранной команды кнопка «Скопировать».
- Тексты: `historyUnavailable` и прочие строки, где «Claude Code» означает ведущего, говорят «ведущий»; где речь именно о транскриптах Claude Code — остаётся.

- [ ] **Step 1: Тест.** `ui-now.test.tsx`: «offers a connection command for each known lead client» — на пустом экране выбрать «Codex» и увидеть команду с `codex mcp add crewboard --url`; выбрать «dsh» и увидеть `streamable-http`.
- [ ] **Step 2:** запуск теста. Expected: FAIL.
- [ ] **Step 3: Реализация** и правка текстов и документации: `getting-started` шаг 3 — «Подключите ведущего» с командами для Claude Code, Codex, dsh и общим адресом; `lead.md` — ведущим может быть любой MCP-клиент; `troubleshooting` — раздел «Ведущий не видит инструменты» для любого клиента (`claude mcp list`, `codex mcp list`).
- [ ] **Step 4:** `pnpm --filter crewboard test && pnpm lint`. Expected: зелёные.
- [ ] **Step 5: Commit** `feat: connect any MCP client as the lead`.

### Task 3: Транскрипты Codex в истории

**Files:**
- Create: `packages/crewboard/src/history/codex.ts` (читатель rollout-файлов Codex)
- Modify: `packages/crewboard/src/history/sessions.ts` (набор источников: Claude Code и Codex; отбор файлов по времени цели), `packages/crewboard/src/history/paths.ts` (`codexSessionsRoot(env)`: `CREWBOARD_CODEX_SESSIONS` или `~/.codex/sessions`), `packages/crewboard/src/app.ts` (время цели в запрос истории)
- Create: `packages/crewboard/test/fixtures/codex-rollout.jsonl`
- Test: `packages/crewboard/test/transcript.test.ts`

**Interfaces:**
- Формат rollout (Codex CLI 0.160.0, проверено на файлах 2026-11-02): одна JSON-строка на событие `{ timestamp, type, payload }`. Нужное: `type: 'session_meta'` (`payload.id`, `payload.cwd`); `type: 'response_item'` с `payload.type: 'message'` и `payload.role` `user` / `assistant` (текст — `payload.content[].text`); `payload.type: 'function_call'` с `payload.namespace: 'mcp__crewboard'`, `payload.name: 'crewboard_<tool>'`, `payload.arguments` (JSON-строка с `goalId`, `title`); результат — `payload.type: 'function_call_output'` с тем же `call_id`. Сообщения `user`, целиком состоящие из служебных блоков (`<environment_context>`, `<user_instructions>` и подобных `<…>…</…>`), — не слова владельца. Разработчик сверяет поля на своих rollout-файлах перед записью фикстуры.
- `readCodexRollout(file: string): Promise<{ sessionId: string; cwd?: string; items: TranscriptItem[] }>` — в тех же `TranscriptItem`, что читатель Claude Code (`owner`, `lead`, `tool` с именем `mcp__crewboard__crewboard_<tool>`, `tool_result`).
- `sessions.ts`: `createHistory` опрашивает источники `[claude, codex]`; у Codex берутся файлы `rollout-*.jsonl` с `mtime` не раньше создания цели и с `cwd` внутри репозитория; уменьшение файла кэшируется по размеру и времени, как сейчас. Сессии всех источников сливаются по времени.

- [ ] **Step 1: Фикстура и тесты.** `codex-rollout.jsonl`: `session_meta` с `cwd` репозитория; служебное сообщение `<environment_context>…</environment_context>`; сообщение владельца «Нужен раздел Usage»; ответ ведущего; `function_call` `crewboard_start_goal` и `crewboard_assign` с `goalId`; строка не-JSON; незнакомый тип. `transcript.test.ts`: таблица — история цели из фикстуры содержит `owner` «Нужен раздел Usage», `lead`-ответ и карточку `assign`; служебное сообщение не выдано как `owner`; битая строка пропущена. Тест «merges a Codex and a Claude Code conversation of one goal in time order» — фикстура Codex и транскрипт Claude Code (существующий генератор в тестах) с одной `goalId` дают две отметки `session` по порядку. Тест кэша: повторный запрос истории не перечитывает неизменённый файл (счётчик чтений через внедрённую функцию чтения или `stat`).
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/transcript.test.ts`. Expected: FAIL.
- [ ] **Step 3: Реализация** по интерфейсам.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: read Codex conversations into the history tab`.

### Task 4: Транскрипты dsh (с исследованием)

**Files:**
- Create (если формат читается): `packages/crewboard/src/history/dsh.ts`, `packages/crewboard/test/fixtures/dsh-session.jsonl`
- Modify: `packages/crewboard/src/history/sessions.ts`, `packages/crewboard/src/history/paths.ts` (`dshSessionsRoot(env)`: `CREWBOARD_DSH_SESSIONS` или `~/.dsh/sessions`)

**Interfaces:**
- Сессии dsh лежат в `~/.dsh/sessions/<слаг папки>/<id>/session.v3.jsonl.zstd` (сжатый zstd JSONL). Распаковка — `zlib.zstdDecompressSync` из Node 24.

- [ ] **Step 1: Исследование (до 30 минут).** Распаковать одну сессию dsh, где использовался MCP, и найти: сообщения владельца и ассистента, вызовы инструментов `mcp__crewboard__crewboard_*` с аргументами, время, `cwd`. Записать вывод в журнал выполнения.
- [ ] **Step 2:** Если формат читается — как Task 3: фикстура (несжатый JSONL, тест сжимает её сам), читатель `readDshSession(file)` в `TranscriptItem`, источник в `sessions.ts`, тест «reads a dsh conversation into the goal history». Если нет — шаги 2–4 не делать, записать решение «цели, которые ведёт dsh, показывают историю из журнала (Task 5)» и причину.
- [ ] **Step 3:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 4: Commit** `feat: read dsh conversations into the history tab` (только если реализовано).

### Task 5: История из журнала, когда разговора нет

**Files:**
- Modify: `packages/crewboard/src/history/sessions.ts` (`GoalHistory.source: 'transcript' | 'journal'`), `packages/crewboard/src/app.ts` (передача событий цели в историю)
- Create: `packages/crewboard/src/history/journal.ts`
- Modify: `packages/crewboard/src/ui/components/history-view.tsx`, `packages/crewboard/src/ui/i18n/{ru,en}.ts` (`historyFromJournal`: «Разговор ведущего недоступен: показан ход работы из журнала Crewboard.» / «The lead's conversation is not available: this is the course of the work from Crewboard's journal.»)
- Test: `packages/crewboard/test/owner.test.ts` (сейчас ждёт пустую историю), `packages/crewboard/test/ui-history.test.tsx`

**Interfaces:**
- `journalHistory(events: GoalEvent[], lead?: string): HistoryItem[]`: `goal_started` с `quote` → `owner`; `assigned` от ведущего → карточка `assign`; `escalated`, `closed`, `cancelled`, `returned`, `steered`, `answered`, `request_decided` от ведущего → вехи с соответствующим `tool` (`escalate`, `close`, `cancel`, `return`, `steer`, `answer`, `decide_request`); ответы и просьбы владельца → `owner` с текстом; `adopted` → отметка `session` с подписью нового ведущего. Порядок — порядок журнала.
- `goalHistory(repo, goalId, events)`: если ни один источник не нашёл разговор с этой целью — `{ available: true, truncated: false, source: 'journal', items: journalHistory(events) }`; иначе `source: 'transcript'`.
- Экран: при `source: 'journal'` над историей строка `historyFromJournal`.

- [ ] **Step 1: Тесты.** `owner.test.ts`: «answers history for a goal without a transcript plainly» переписать — история цели без транскрипта имеет `source: 'journal'` и содержит карточку поручения. `ui-history.test.tsx`: история с `source: 'journal'` показывает строку о журнале и карточку поручения.
- [ ] **Step 2:** запуск тестов. Expected: FAIL.
- [ ] **Step 3: Реализация** по интерфейсам.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Документация.** `docs/{en,ru}/screen.md` (раздел «История»: откуда берётся разговор — Claude Code, Codex, dsh, иначе журнал), `docs/{en,ru}/troubleshooting.md` (раздел «Полный разговор недоступен»), `CHANGELOG.md` (`## [Unreleased]`).
- [ ] **Step 6: Commit** `feat: build the history from the journal when no conversation is found`.

## Финал

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
- [ ] Живая проверка: Codex как ведущий через `codex exec -c 'mcp_servers.crewboard.url="http://127.0.0.1:<порт>/mcp"'` (переопределение конфигурации на один запуск, `~/.codex/config.toml` владельца не меняется), короткая цель; на экране у цели «Ведущий: Codex», вкладка «История» показывает разговор из rollout-файла.
- [ ] Финальное ревью ветки свежим ревьюером.

## Решения плана (вне дизайна)

- Ведущий не передаёт, кто он, параметром инструмента: имя берётся из `clientInfo` MCP-инициализации, которое шлёт каждый клиент. Это не требует от ведущего ничего и не ломает старые вызовы.
- Транскрипты Codex отбираются по времени изменения файла не раньше создания цели и по `cwd` из `session_meta`, а не перебором всех файлов: в `~/.codex/sessions` их сотни.
- Для dsh сначала исследование формата; если сессии не читаются надёжно, цели под dsh полагаются на историю из журнала, без догадок о формате.
- Живая проверка Codex-ведущего подключает сервер флагом `-c` на один запуск, а не `codex mcp add`: так настоящий `~/.codex/config.toml` владельца не меняется, а вход Codex остаётся его собственным.
