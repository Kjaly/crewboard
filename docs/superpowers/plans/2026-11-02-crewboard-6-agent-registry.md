# Crewboard: реестр агентов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Часть 2 дизайна «любой ведущий, любой исполнитель»: вместо трёх зашитых провайдеров — реестр агентов в `~/.crewboard/agents.json`; любой агент из адаптеров core (claude, codex, dsh, opencode, cursor, gemini, grok, devin) подключается записью, Kimi/GLM/Qwen — через dsh.

**Architecture:** Модуль реестра в crewboard (`src/workers/agents.ts`) отдаёт список записей: встроенные Claude, Codex, DeepSeek плюс файл пользователя. Журнал хранит имя агента строкой в существующем поле `provider`, поэтому старые цели читаются без миграции. Супервизор строит идентификатор core из записи (`<run>/<model>`, для dsh модель может быть `<провайдер>/<модель>`). Ведущий получает список агентов инструментом `crewboard_agents`, экран — через `/api/agents`.

**Tech Stack:** Node 24, TypeScript, pnpm 11.5.2, zod, vitest, Testing Library, MCP SDK 1.32.2, React 18.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-any-lead-any-agent-design.md` (часть 2).

## Global Constraints

- Журнал только дописывается; старые журналы с `provider: 'claude' | 'codex' | 'deepseek'` читаются и показываются без миграции.
- Цели с агентом, которого нет в реестре, продолжают читаться и показываться; новую работу по нему запустить нельзя.
- Агенты через API подключаются только через dsh; своего агентного цикла нет.
- Crewboard не читает и не хранит учётные данные агентов.
- Каждый новый текст интерфейса — в `src/ui/i18n/ru.ts` и `en.ts`; английские руководства — источник, русские — пара.
- Тесты: мало, про поведение, новые ветки — строки в таблицах.
- Коммиты — Conventional Commits без scope, с `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Файл реестра с ошибкой (не JSON, неизвестный `run`, пустая модель): сервер не падает молча и не теряет встроенных агентов; ошибка видна с путём к файлу (тест в Task 1).
2. Старая цель с `provider: 'deepseek'` открывается, показывает значок и подпись DeepSeek, аналитика считает её запуски (строка в Task 3).
3. Ведущий поручает работу агенту, которого нет в реестре: внятная ошибка со списком доступных, ничего не записано в журнал (тест в Task 2).
4. Исполнитель в блоке разбиения указывает `[kimi]`, которого нет в реестре: часть берёт агента родителя, как сейчас с неизвестным именем (строка в Task 2).
5. Передача работы с экрана предлагает только включённых агентов из реестра, кроме текущего (тест в Task 3).

---

### Task 1: Реестр агентов и журнал с любым агентом

**Files:**
- Create: `packages/crewboard/src/workers/agents.ts`
- Modify: `packages/crewboard/src/model/types.ts` (`PROVIDERS`, `ProviderId`, схема событий)
- Delete: `packages/crewboard/src/workers/providers.ts` (заменён реестром)
- Modify: `packages/crewboard/src/supervisor.ts` (`agentFor` → реестр), `packages/crewboard/src/app.ts` (создание реестра, передача в супервизор и команды)
- Test: `packages/crewboard/test/agents.test.ts` (новый), `packages/crewboard/test/supervisor.test.ts`

**Interfaces:**
- Produces в `src/workers/agents.ts`:
  - `type AgentRun = 'claude' | 'codex' | 'dsh' | 'opencode' | 'cursor' | 'gemini' | 'grok' | 'devin'`
  - `type AgentEntry = { id: string; label: string; run: AgentRun; model: string; color?: string; enabled: boolean; readOnly: boolean }` — `readOnly`: умеет ли адаптер запуск только на чтение (`claude`, `codex`, `opencode`, `cursor`, `grok` — да; `gemini`, `dsh`, `devin` — нет).
  - `BUILTIN_AGENTS: AgentEntry[]` — `claude` (run `claude`, model `sonnet`, label `Claude`), `codex` (run `codex`, model `gpt-6.1-sol`, label `Codex`), `deepseek` (run `dsh`, model `deepseek-flash`, label `DeepSeek`); цвета — текущие токены `--claude`, `--codex`, `--deepseek`.
  - `class AgentsFileError extends Error { path: string }`.
  - `createAgents(env: NodeJS.ProcessEnv): { list(): Promise<AgentEntry[]>; get(id: string): Promise<AgentEntry | undefined>; coreId(entry: AgentEntry, model?: string): string }`. `list` читает `<CREWBOARD_HOME>/agents.json` при каждом вызове (файл мал), проверяет zod-схемой, накладывает на встроенные записи (та же `id` переопределяет поля, `"enabled": false` выключает) и возвращает только включённые. Файла нет — только встроенные. Файл битый — `list` бросает `AgentsFileError` с путём и причиной.
  - `coreId`: `devin` → `devin/<model>`, остальные → `<run>/<model>` (для dsh модель вида `moonshot/kimi-k3` даёт `dsh/moonshot/kimi-k3`).
- Формат файла:

```json
{ "agents": { "kimi": { "label": "Kimi", "run": "dsh", "model": "moonshot/kimi-k3", "color": "#8b5cf6" }, "codex": { "model": "gpt-6.1-terra" }, "deepseek": { "enabled": false } } }
```

- `model/types.ts`: `ProviderId` становится `string` (имя агента); `PROVIDERS` удаляется; в схеме `assigned.provider`, `owner_requested.provider`, `reassigned.provider` — `z.string().min(1)`.
- Supervisor: `createSupervisor` получает `agents: ReturnType<typeof createAgents>`; запуск берёт запись по `node.provider`; нет записи — запуск записывается как неудавшийся (`run_ended` `failed`, `reason: 'agent <id> is not in the registry'`), как сейчас отказ бэкенда.

- [ ] **Step 1: Тесты.** `agents.test.ts`, таблица:

```ts
it.each([
  ['no file: the built-in three', undefined, ['claude', 'codex', 'deepseek']],
  ['adds an agent through dsh', { agents: { kimi: { label: 'Kimi', run: 'dsh', model: 'moonshot/kimi-k3' } } }, ['claude', 'codex', 'deepseek', 'kimi']],
  ['turns a built-in off', { agents: { deepseek: { enabled: false } } }, ['claude', 'codex']],
])('%s', async (_n, file, ids) => { /* CREWBOARD_HOME во временной папке */ expect((await agents.list()).map((a) => a.id)).toEqual(ids) })
```

плюс: `coreId(kimi)` → `'dsh/moonshot/kimi-k3'`, `coreId(codex, 'gpt-6-luna')` → `'codex/gpt-6-luna'`; битый файл (`{ agents: { x: { run: 'nope', model: 'm' } } }`) → `list()` отклоняется `AgentsFileError` с `path`, указывающим на файл.
  `supervisor.test.ts`: «launches a registered agent through its core id» — реестр с `kimi`, поручение `provider: 'kimi'`, у фейкового бэкенда `fake.runs[0].agent === 'dsh/moonshot/kimi-k3'`; «records a failed run for an agent no longer registered».
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/agents.test.ts test/supervisor.test.ts`. Expected: FAIL (модуля нет).
- [ ] **Step 3: Реализация** по интерфейсам. `createApp` создаёт реестр один раз и передаёт его в супервизоры проектов и в команды ведущего. Все прочие места, где был `ProviderId`, компилируются со `string`; ссылки на `PROVIDERS` переходят на реестр в Task 2 и Task 3 (на этом шаге — временно на `BUILTIN_AGENTS.map((a) => a.id)` там, где нужен список, чтобы typecheck был зелёным).
- [ ] **Step 4:** `pnpm --filter crewboard test && pnpm typecheck`. Expected: зелёные.
- [ ] **Step 5: Commit** `feat: run workers from an agent registry instead of three hard-coded providers`.

### Task 2: Ведущий видит реестр

**Files:**
- Modify: `packages/crewboard/src/lead/mcp.ts` (новый инструмент `crewboard_agents`, `provider` в `crewboard_assign` — строка, `LEAD_INSTRUCTIONS` без перечисления провайдеров)
- Modify: `packages/crewboard/src/lead/commands.ts` (`agents()`, проверка агента в `assign`)
- Modify: `packages/crewboard/src/requests.ts`, `packages/crewboard/src/app.ts` (проверка агента для передачи работы)
- Modify: `packages/crewboard/src/workers/protocol.ts` (`parseOutcome(finalText, known: ReadonlySet<string>)`)
- Test: `packages/crewboard/test/lead-flow.test.ts`, `packages/crewboard/test/protocol.test.ts`

**Interfaces:**
- Consumes: `createAgents` из Task 1.
- Produces: `LeadCommands.agents(): Promise<Array<{ id: string; label: string; run: AgentRun; model: string; readOnly: boolean }>>`; MCP `crewboard_agents` без аргументов возвращает этот список. `assign` с `provider`, которого нет среди включённых, бросает ошибку `unknown agent <id>; available: <ids>` и ничего не пишет. `parseOutcome` принимает множество известных имён; тег `[x]` с неизвестным именем игнорируется (часть берёт агента родителя).
- `LEAD_INSTRUCTIONS`: первая строка — «Crewboard runs work you hand out to other coding agents and shows the owner a live map of it. crewboard_agents lists who you can hand work to.»; описание `crewboard_assign` говорит «provider: an agent id from crewboard_agents».

- [ ] **Step 1: Тесты.** `lead-flow.test.ts`: «lists the registered agents and refuses an unknown one» — `crewboard_agents` содержит `claude`, `codex`, `deepseek`; `crewboard_assign` с `provider: 'nope'` возвращает ошибку с `available`, а в дереве цели нет нового узла. `protocol.test.ts`: в таблицу разбиения строка `['a registered custom agent', '- [kimi] Тесты', [{ title: 'Тесты', criteria: [], provider: 'kimi' }]]` с `known = new Set(['claude', 'codex', 'deepseek', 'kimi'])`; существующая строка с `[gemini]` остаётся «агент не указан».
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/lead-flow.test.ts test/protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Реализация.** Супервизор передаёт в `parseOutcome` идентификаторы из `agents.list()`.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: let the lead see the agent registry and refuse unknown agents`.

### Task 3: Экран для любого агента

**Files:**
- Modify: `packages/crewboard/src/server.ts`, `packages/crewboard/src/app.ts` (`GET /api/agents`)
- Modify: `packages/crewboard/src/ui/api.ts` (`agents()`), `packages/crewboard/src/ui/app.tsx` (загрузка списка)
- Modify: `packages/crewboard/src/ui/components/badges.tsx` (`Avatar` берёт подпись и цвет из записи, буква — первая буква подписи; неизвестный агент — серый значок и сама строка имени)
- Modify: `packages/crewboard/src/ui/components/actions.tsx` (список «Кому передать» из реестра)
- Modify: `packages/crewboard/src/ui/components/analytics-view.tsx`, `packages/crewboard/src/analytics.ts` (дорожки и затраты по имени агента)
- Modify: `packages/crewboard/src/ui/i18n/{ru,en}.ts` (`provider` оставляет только `lead`; подписи агентов — из реестра)
- Modify: `packages/crewboard/test/ui-fixtures.ts` (`agents()` в фейковом API)
- Test: `packages/crewboard/test/ui-now.test.tsx`, `packages/crewboard/test/analytics.test.ts`

**Interfaces:**
- Produces: `GET /api/agents` → `Array<{ id: string; label: string; color?: string }>` (только включённые). `Api.agents(): Promise<AgentBadge[]>`, где `type AgentBadge = { id: string; label: string; color?: string }`.
- `analytics.ts`: агент запуска берётся из журнала — текущее `provider` поручения на момент `run_started` (по `assigned` и последнему `reassigned` до него), а не из префикса строки core. `Lane.provider`, ключи `byProvider` и `byAssignment[].provider` — имя агента (`string`).

- [ ] **Step 1: Тесты.** `ui-now.test.tsx`: «offers every other registered agent to hand work over» — фейковый API отдаёт `claude`, `codex`, `kimi`; на узле с `provider: 'codex'` после «Передать» видны кнопки `Claude` и `Kimi`, а `Codex` нет. `analytics.test.ts`: строки таблицы — запуск поручения с `provider: 'kimi'` попадает в дорожку `kimi`; старый журнал с `provider: 'deepseek'` и агентом `dsh/deepseek-flash` попадает в дорожку `deepseek`; после `reassigned` на `claude` следующий запуск — в дорожке `claude`.
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/ui-now.test.tsx test/analytics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Реализация.** Цвет значка — `style={{ background: color }}`, если он задан в записи; иначе классы `claude` / `codex` / `deepseek` для встроенных и нейтральный для прочих. Подпись агента в аналитике и в контексте — `label` из реестра, для удалённого агента — его `id`.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: show any registered agent on the screen and in analytics`.

### Task 4: Канал оплаты Claude и предстартовая проверка

**Files:**
- Modify: `packages/crewboard/src/workers/pool.ts` (канал из события запуска Claude)
- Modify: `packages/crewboard/src/model/types.ts` (`RunCost.billing?: 'subscription' | 'api'`)
- Modify: `packages/crewboard/src/analytics.ts`, `packages/crewboard/src/ui/components/analytics-view.tsx`, `packages/crewboard/src/ui/i18n/{ru,en}.ts` (`bySubscription`: «по подписке» / «by subscription»)
- Modify: `packages/core/src/preflight/preflight.ts` (проверки `--bare` и `ANTHROPIC_API_KEY` только в режиме `isolated`)
- Test: `packages/crewboard/test/analytics.test.ts`, `packages/core/test/` (тест preflight, если есть; иначе строка в `cli-runner.test.ts`)

**Interfaces:**
- Сначала проверить на живом Claude Code, что сообщает его поток: `claude -p --output-format stream-json --verbose "say ok"` — найти в событии `system`/`init` поле источника ключа (ожидается `apiKeySource`, значение `none` при входе по подписке). Если поля нет — шаг с каналом не делать, записать решение в журнал выполнения, остальное в задаче выполнить.
- `pool.poll`: для запусков `claude/…` по сырому событию инициализации записать в `usage.billing` `'subscription'` (`apiKeySource === 'none'`) или `'api'`.
- Аналитика: ячейка «Деньги» для запуска с `billing: 'subscription'` и без `usd` показывает «по подписке», а не «нет данных»; сумма по агенту — число запусков по подписке отдельно не считается.

- [ ] **Step 1: Проверка живого потока** (команда выше), результат — в журнал выполнения.
- [ ] **Step 2: Тесты.** `analytics.test.ts`: строка «a subscription run shows by subscription, not no data». Core: preflight в режиме по умолчанию не требует `ANTHROPIC_API_KEY` для `claude-code`, в `isolated` — требует.
- [ ] **Step 3:** запуск тестов. Expected: FAIL.
- [ ] **Step 4: Реализация** по интерфейсам.
- [ ] **Step 5:** `pnpm test`. Expected: зелёный.
- [ ] **Step 6: Commit** `feat: show Claude subscription runs as such and check Claude preflight by sign-in mode`.

### Task 5: Документация реестра

**Files:**
- Modify: `docs/{en,ru}/workers.md` (раздел «Your agents» / «Ваши агенты»: файл, поля, встроенные записи, пример Kimi через dsh с профилем dsh, пример OpenCode с GLM; что видит ведущий)
- Modify: `docs/{en,ru}/costs.md` («по подписке»), `docs/{en,ru}/screen.md` (передача работы — из реестра), `README.md`, `README.ru.md` (абзац о любых агентах), `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1:** Тексты по списку. Пример Kimi: запись в `~/.crewboard/agents.json` плюс ссылка на настройку маршрута в профиле dsh (модуль `dsh-llm-pi-ai`, `providers` с `baseURL`, `apiKeyEnv`, `models`), без ключей в примерах.
- [ ] **Step 2:** `pnpm lint`. Expected: зелёный.
- [ ] **Step 3: Commit** `docs: describe the agent registry and adding agents through dsh`.

## Финал

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
- [ ] Живая проверка: запись `kimi` (или любая модель из профиля dsh пользователя) в `agents.json`, скрипт-ведущий поручает ей вопрос, исполнитель отвечает. Если ключа к такой модели нет — проверка на `opencode` или на встроенных, с пометкой.
- [ ] Финальное ревью ветки свежим ревьюером.

## Решения плана (вне дизайна)

- Изоляция Claude остаётся одним переключателем окружения `CREWBOARD_CLAUDE_AUTH`, а не полем записи: бэкенд core создаётся на вид адаптера, а не на запись, и раздельные режимы для двух записей Claude потребовали бы второго экземпляра бэкенда. Вернуться, если владелец попросит.
- Поле журнала остаётся `provider`, хотя теперь это имя агента: переименование потребовало бы миграции или двойного чтения.
- Реестр читается при каждом обращении, без кэша и наблюдения за файлом: файл маленький, а правка вступает в силу без перезапуска.
