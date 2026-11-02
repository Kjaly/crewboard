# Crewboard 1: фундамент (модель, хранилище, исполнители, мост с ведущим) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Локальный сервер, к которому Claude Code подключается по MCP как ведущий, ставит цели и поручения, а сервер запускает исполнителей (Claude, Codex, DeepSeek через dsh), передаёт их вопросы и итоги ведущему и выводит статусы из журнала событий.

**Architecture:** Новый пакет `packages/app`. Доменная модель построена на журнале событий: на каждую цель файл `events.jsonl` в `<repo>/.crewboard/goals/<goalId>/`, статусы только вычисляются. Исполнители запускаются через существующий контракт `RunBackend` из `@crewboard/core`, который на этом этапе подключается как зависимость. Перенос нужных модулей и удаление старого кода выполняет план 4. Один процесс на `node:http` обслуживает MCP (Streamable HTTP, путь `/mcp`), JSON API и long-poll ожидания для ведущего.

**Tech Stack:** Node.js 24+, TypeScript (как в репозитории), `@modelcontextprotocol/sdk` ^1.32.0, `zod` ^4.6.5 (уже в core), vitest, esbuild для сборки бина.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-lead-chat-design.md`

## Дорожная карта (план 1 из 4)

| План | Результат |
| --- | --- |
| **1. Фундамент (этот)** | Сервер, модель и журнал, исполнители, MCP для ведущего, `wait` для пробуждения. Работает без интерфейса. |
| 2. Экран «Сейчас» и просьбы | Веб-интерфейс по прототипу `crewboard-now-v2.html`, поток обновлений SSE, ответы владельца на эскалации, просьбы из дерева и решения ведущего, разбиение работы самими исполнителями (MCP в исполнителе), несколько проектов. |
| 3. История и аналитика | Связь сессии Claude Code с целью, терпимый разбор транскрипта, экран «История» с переходами, дорожки и затраты. |
| 4. Релиз | Перенос нужных модулей из core и удаление старого кода, плагина и CLI, имя пакета `crewboard`, документация на двух языках, скриншоты и видео. |

## Global Constraints

- Node.js `>=24`, ESM, TypeScript, стиль как в репозитории (Biome, без классов там, где хватает функций).
- Данные проекта хранятся в `<repo>/.crewboard/`. Сервер создаёт `<repo>/.crewboard/.gitignore` с содержимым `*`.
- Реестр проектов лежит в `~/.crewboard/projects.json`. Переменная `CREWBOARD_HOME` переопределяет `~/.crewboard` (для тестов).
- Порт по умолчанию `4700`, сервер слушает только `127.0.0.1`.
- Статус никогда не хранится. Он всегда вычисляется из событий.
- Набор статусов в коде: `queued`, `running`, `waiting_answer`, `waiting_owner`, `done`, `cancelled`, `abandoned`, `paused` (`paused` только у корня цели).
- Пороги задаются в одном файле `src/model/thresholds.ts`: `LEAD_SILENT_PAUSE_MS = 24 * 60 * 60 * 1000`, `STALE_ABANDON_MS = 24 * 60 * 60 * 1000`.
- Провайдеры: `claude` запускается агентом `claude/<model>`, `codex` агентом `codex/<model>`, `deepseek` агентом `dsh/<model>` через dsh. Модель по умолчанию задаёт CLI.
- Автоматический Claude проходит проверку политики API-ключа в core (`routing/anthropic-policy.ts`). Окружение передаётся как есть, ключ не пишется в журнал.
- Политика тестов владельца: мало тестов, про поведение. Новая ветка поведения добавляется строкой в таблицу `it.each`. Моки допустимы только на границе (`RunBackend`, время).
- Коммиты в стиле Conventional Commits без scope. Каждый коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Перезапуск сервера посреди работы.** Живые запуски должны снова подхватываться по сохранённому `runId`, а статусы восстанавливаться с диска. Тест в Task 4.
2. **Исполнитель закончил без тега протокола.** Реальные CLI часто забывают формат, поэтому последнее сообщение целиком считается итогом. Сервер не должен падать или зависать. Строка таблицы в Task 3.
3. **Запуск упал** (нет CLI, ошибка авторизации, лимит). Ведущий должен получить событие с причиной во входящих, узел пишет «Запуск упал: <причина>». Строка в Task 3 и Task 5.
4. **Два одновременных вызова пишут в одну цель.** Номера событий уникальны и монотонны, файл не портится. Обрезанная последняя строка после аварии пропускается при чтении. Тест в Task 2.
5. **Неверный проект в вызове MCP** (путь не существует или не git-репозиторий). Ведущий получает понятную ошибку инструмента, сервер продолжает работу. Строка в Task 5.

---

## Файловая структура

```
packages/app/
  package.json            name "@crewboard/app", private, bin "crewboard-app": "./dist/main.js"
  tsconfig.json           extends ../../tsconfig.base.json
  tsconfig.check.json     как в packages/cli
  scripts/build.mjs       esbuild-бандл src/main.ts, по образцу packages/cli/scripts/build.mjs
  src/
    model/types.ts        схемы событий (zod) и доменные типы
    model/thresholds.ts   пороги
    model/project.ts      deriveStatuses, buildTree, doingLine — чистые функции
    store/paths.ts        пути .crewboard и CREWBOARD_HOME
    store/event-store.ts  журнал целей: append/read/list, мета цели
    store/registry.ts     реестр проектов
    store/inbox.ts        входящие ведущего: undelivered/ack
    workers/providers.ts  провайдер -> агент
    workers/protocol.ts   промпт исполнителю и разбор тегов итога
    workers/pool.ts       запуск/опрос/steer/cancel поверх RunBackend
    workers/backends.ts   реальные RunBackend из core
    supervisor.ts         такт: старт очереди, опрос запусков, устаревание
    lead/commands.ts      команды ведущего (общие для MCP и тестов)
    lead/mcp.ts           MCP-сервер и инструменты
    server.ts             node:http: /mcp, /api/*
    app.ts                createApp(): сборка всего вместе
    main.ts               CLI: serve, wait
  test/
    status.test.ts
    event-store.test.ts
    protocol.test.ts
    supervisor.test.ts
    lead-flow.test.ts
    fake-backend.ts       RunBackend в памяти для тестов
```

---

### Task 1: Пакет, доменная модель и вычисление статусов

**Files:**
- Create: `packages/app/package.json`, `packages/app/tsconfig.json`, `packages/app/tsconfig.check.json`
- Create: `packages/app/src/model/types.ts`, `packages/app/src/model/thresholds.ts`, `packages/app/src/model/project.ts`
- Test: `packages/app/test/status.test.ts`

**Interfaces:**
- Produces (`model/types.ts`):
  ```ts
  export type ProviderId = 'claude' | 'codex' | 'deepseek'
  export type ResultKind = 'local' | 'branch' | 'answer' | 'decision'
  export type Status = 'queued' | 'running' | 'waiting_answer' | 'waiting_owner' | 'done' | 'cancelled' | 'abandoned' | 'paused'
  export type Actor = 'lead' | 'owner' | 'worker' | 'system'
  type Base = { seq: number; ts: string; goalId: string; assignmentId: string; actor: Actor }
  export type GoalEvent = Base & (
    | { type: 'goal_started'; title: string; criteria: string[]; quote?: string }
    | { type: 'assigned'; parentId: string; title: string; criteria: string[]; resultKind: ResultKind; provider: ProviderId; model?: string; quote?: string; after: string[] }
    | { type: 'run_started'; runId: string; agent: string; cwd: string }
    | { type: 'progress'; text: string }
    | { type: 'question'; text: string; options: string[] }
    | { type: 'escalated'; text: string; options: string[]; why: string }
    | { type: 'answered'; text: string }
    | { type: 'steered'; text: string }
    | { type: 'reported'; summary: string }
    | { type: 'returned'; note: string }
    | { type: 'run_ended'; runId: string; outcome: 'completed' | 'failed' | 'cancelled'; reason?: string }
    | { type: 'closed'; summary: string }
    | { type: 'cancelled'; reason: string }
    | { type: 'adopted'; note?: string }
  )
  export type NewEvent = DistributiveOmit<GoalEvent, 'seq' | 'ts'>
  export const goalEventSchema: z.ZodType<GoalEvent>
  export type AssignmentView = { id: string; parentId: string | null; title: string; criteria: string[]; resultKind: ResultKind | 'goal'; provider: ProviderId | 'lead'; model?: string; quote?: string; status: Status; doing: string; runId?: string; cwd?: string; children: AssignmentView[] }
  ```
  У корня цели `assignmentId === goalId`, `parentId: null`, `provider: 'lead'`, `resultKind: 'goal'`.
- Produces (`model/project.ts`):
  ```ts
  export function buildTree(events: GoalEvent[], now: Date, leadLastSeen: Date | undefined): AssignmentView
  export function deriveStatus(own: GoalEvent[], ctx: { parentStatus: Status | null; isRoot: boolean; now: Date; leadLastSeen?: Date }): Status
  export function doingLine(own: GoalEvent[], status: Status): string
  ```

- [ ] **Step 1: Создать пакет.** `package.json`: `"type": "module"`, `"engines": {"node": ">=24"}`, скрипты `build`, `typecheck`, `test` как в `packages/cli`. Зависимости: `@crewboard/core: workspace:*`, `@modelcontextprotocol/sdk: ^1.32.0`, `zod: ^4.6.5`. Dev: `esbuild` той же версии, что в cli. Выполнить `pnpm install`.

- [ ] **Step 2: Написать падающий тест `status.test.ts`.** Таблица `it.each` над последовательностями событий одного поручения (хелпер `ev(type, extra)` проставляет `seq`, `ts`, `goalId: 'g'`, `assignmentId: 'a'`). Строки и ожидаемый статус:

  | Строка | Последние события | ctx | Ожидается |
  | --- | --- | --- | --- |
  | только поручено | assigned | parent running | `queued` |
  | запущено | assigned, run_started | parent running | `running` |
  | вопрос ведущему | …, question | parent running | `waiting_answer` |
  | эскалация | …, question, escalated | parent running | `waiting_owner` |
  | ответ получен | …, escalated, answered | parent running | `running` |
  | закрыто | …, reported, closed | parent running | `done` |
  | отменено | assigned, cancelled | parent running | `cancelled` |
  | родитель отменён | assigned, run_started | parent `cancelled` | `abandoned` |
  | запуск кончился без итога давно | assigned, run_started, run_ended(failed) с `ts` старше `STALE_ABANDON_MS` | parent running | `abandoned` |
  | запуск упал недавно | assigned, run_started, run_ended(failed, reason 'auth') | parent running | `running` |
  | корень, ведущий молчит | goal_started | isRoot, `leadLastSeen` старше `LEAD_SILENT_PAUSE_MS` | `paused` |
  | корень, ведущий на связи | goal_started | isRoot, `leadLastSeen` 1 мин назад | `running` |

  Второй тест `buildTree`: корень и два поручения, одно с `cancelled` у родителя-узла. Проверить, что у потомка отменённого узла статус `abandoned` и что `children` вложены по `parentId`.
  Третий тест `doingLine`: для строки «запуск упал недавно» строка равна `'Запуск упал: auth'`, для `waiting_owner` строка равна `'Ждёт вашего ответа'`, для `running` с последним `progress` строка равна тексту этого progress.

- [ ] **Step 3: Запустить и убедиться, что тест падает.** Run: `pnpm --filter @crewboard/app test -- status` Expected: FAIL, модули не найдены.

- [ ] **Step 4: Реализовать `types.ts`, `thresholds.ts`, `project.ts`.** Схема: `z.discriminatedUnion('type', [...])`, пересечённая с базой. Правила `deriveStatus` по порядку: последнее терминальное (`closed` → done, `cancelled` → cancelled); родитель в `cancelled`/`done`/`abandoned` → abandoned; открытый вопрос (последний `question` позже последнего `answered`): если после него есть `escalated`, то `waiting_owner`, иначе `waiting_answer`; нет `run_started` → `queued`; последний запуск завершён без последующего `run_started`, без `reported` после него и старше `STALE_ABANDON_MS` → abandoned; корень: `leadLastSeen` старше `LEAD_SILENT_PAUSE_MS` → paused; иначе `running`. Тексты `doingLine`: `queued` → «В очереди», при непустом `after` «Начнёт после: <названия>»; `waiting_answer` → «Спрашивает: <текст>»; `waiting_owner` → «Ждёт вашего ответа»; последний `run_ended` failed → «Запуск упал: <reason>»; `reported` без `closed` → «Доложил итог, ждёт решения»; иначе текст последнего `progress` или «Работает».

- [ ] **Step 5: Запустить тест.** Run: `pnpm --filter @crewboard/app test -- status` Expected: PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git add packages/app pnpm-lock.yaml
  git commit -m "feat: add assignment model with status derived from events"
  ```

---

### Task 2: Журнал событий, реестр проектов и входящие ведущего

**Files:**
- Create: `packages/app/src/store/paths.ts`, `store/event-store.ts`, `store/registry.ts`, `store/inbox.ts`
- Test: `packages/app/test/event-store.test.ts`

**Interfaces:**
- Consumes: `GoalEvent`, `NewEvent`, `goalEventSchema` (Task 1).
- Produces:
  ```ts
  // paths.ts
  export const crewboardHome: (env: NodeJS.ProcessEnv) => string
  export const projectDir: (repo: string) => string          // <repo>/.crewboard
  export const goalDir: (repo: string, goalId: string) => string
  // event-store.ts
  export type GoalMeta = { goalId: string; title: string; createdAt: string; leadLastSeen?: string }
  export function createEventStore(repo: string): {
    append(goalId: string, e: NewEvent): Promise<GoalEvent>
    read(goalId: string): Promise<GoalEvent[]>
    listGoals(): Promise<GoalMeta[]>
    writeMeta(meta: GoalMeta): Promise<void>
    touchLead(goalId: string, at: Date): Promise<void>
  }
  // registry.ts
  export function createRegistry(env: NodeJS.ProcessEnv): { add(repo: string): Promise<void>; list(): Promise<string[]> }
  // inbox.ts
  export const LEAD_EVENT_TYPES: ReadonlySet<GoalEvent['type']>  // question, reported, run_ended, answered (от владельца)
  export function createInbox(store: ReturnType<typeof createEventStore>): {
    pending(): Promise<GoalEvent[]>        // события для ведущего по всем целям проекта с seq > delivered
    ack(goalId: string, seq: number): Promise<void>
  }
  ```

- [ ] **Step 1: Написать падающий тест `event-store.test.ts`.** Во временной папке:
  - `append` 20 событий через `Promise.all` в одну цель → `read` возвращает 20 событий, `seq` равны 1..20 без пропусков и повторов.
  - Дописать в конец файла обрезанную строку `{"seq":21,` → `read` возвращает 20 событий и не бросает.
  - `inbox.pending()` после `question` и `progress` возвращает только `question`. После `ack(goalId, seq)` возвращает пустой список. Новый экземпляр store на той же папке тоже возвращает пустой список (подтверждение сохраняется на диске).
  - Первая запись в репозиторий создаёт `<repo>/.crewboard/.gitignore` с содержимым `*\n`.

- [ ] **Step 2: Запустить и убедиться, что тест падает.** Run: `pnpm --filter @crewboard/app test -- event-store` Expected: FAIL.

- [ ] **Step 3: Реализовать.** Запись сериализуется через промис-цепочку на цель внутри процесса (сервер один). `seq` берётся из счётчика в памяти, инициализированного при первом чтении файла. Строка дописывается через `appendFile`. При чтении каждая строка проверяется схемой, невалидные пропускаются. `meta.json` и `inbox.json` (`{ delivered: Record<goalId, number> }`) пишутся атомарно: временный файл и `rename`.

- [ ] **Step 4: Запустить тест.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: add append-only goal journal and lead inbox`.

---

### Task 3: Протокол исполнителя и пул запусков

**Files:**
- Create: `packages/app/src/workers/providers.ts`, `workers/protocol.ts`, `workers/pool.ts`
- Create: `packages/app/test/fake-backend.ts`
- Test: `packages/app/test/protocol.test.ts`

**Interfaces:**
- Consumes: `AssignmentView`, `NewEvent` (Task 1). Из `@crewboard/core`: `RunBackend`, `RawEvent`, `normalize`, `NormEvent`, `TERMINAL_STATUSES`.
- Produces:
  ```ts
  // providers.ts
  export function agentFor(provider: ProviderId, model?: string): string   // 'claude/sonnet', 'codex/', 'dsh/'
  // protocol.ts
  export function workerPrompt(a: { title: string; criteria: string[]; resultKind: ResultKind; chain: string[]; resumeNote?: string }): string
  export type WorkerOutcome = { kind: 'report'; summary: string } | { kind: 'question'; text: string; options: string[] }
  export function parseOutcome(finalText: string): WorkerOutcome
  // pool.ts
  export type BackendFor = (agent: string) => Promise<RunBackend>
  export function createPool(o: { backendFor: BackendFor; runsDir: string }): {
    launch(input: { agent: string; cwd: string; prompt: string }): Promise<string>        // runId
    poll(agent: string, runId: string, sinceIndex: number): Promise<{ events: NormEvent[]; nextIndex: number; terminal: boolean; failed: boolean; reason?: string }>
    steer(agent: string, runId: string, text: string): Promise<'delivered' | 'ended'>
    cancel(agent: string, runId: string): Promise<void>
  }
  ```
- Протокол итога, который `workerPrompt` требует от исполнителя:
  - итог заканчивается блоком `<crewboard-report>…</crewboard-report>`;
  - вопрос заканчивается блоком `<crewboard-question>текст</crewboard-question>`, варианты ответа задаются строками `- вариант` внутри блока после пустой строки.

- [ ] **Step 1: Написать падающий тест `protocol.test.ts`.** Таблица `parseOutcome`:

  | Вход | Ожидается |
  | --- | --- |
  | `Сделал.\n<crewboard-report>Короб готов</crewboard-report>` | `{kind:'report', summary:'Короб готов'}` |
  | `<crewboard-question>Шторка или слой?\n\n- Шторка\n- Слой</crewboard-question>` | `{kind:'question', text:'Шторка или слой?', options:['Шторка','Слой']}` |
  | `Всё готово, тесты зелёные` (без тега) | `{kind:'report', summary:'Всё готово, тесты зелёные'}` |
  | пустая строка | `{kind:'report', summary:'Исполнитель завершил работу без итога'}` |
  | оба тега | побеждает последний по позиции |

  Тест пула на `fake-backend.ts`: `FakeBackend` реализует `RunBackend` в памяти. Тест задаёт ему сценарий: события `RawEvent[]`, финальный статус `completed` или `failed` с `failure`. Проверки: `poll` возвращает нормализованные события начиная с `sinceIndex`. `terminal`/`failed`/`reason` выставляются по `status()`. `steer` для завершённого запуска возвращает `'ended'` и не вызывает `backend.steer`.

- [ ] **Step 2: Запустить и убедиться, что тест падает.** Expected: FAIL.

- [ ] **Step 3: Реализовать.** `workerPrompt` включает: цепочку «кто поручил» (заголовки предков), формулировку, критерии списком, вид результата (для `branch`: «закоммить работу в текущей ветке»; для `local`: «не коммить»; для `answer`/`decision`: «ничего не меняй в файлах, ответь итогом») и правила протокола выше. `resumeNote` добавляется в конец разделом «Продолжение». Промпт пишется в `runsDir/<uuid>.md` перед `launch`, так как `RunBackend.launch` принимает `promptFile`. `reason` берётся из `RunState.failure?.code` или `status`.

- [ ] **Step 4: Запустить тест.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: add worker protocol and run pool over core backends`.

---

### Task 4: Супервизор

**Files:**
- Create: `packages/app/src/supervisor.ts`
- Test: `packages/app/test/supervisor.test.ts`

**Interfaces:**
- Consumes: event store, inbox (Task 2); `createPool`, `workerPrompt`, `parseOutcome`, `agentFor` (Task 3); `buildTree` (Task 1).
- Produces:
  ```ts
  export function createSupervisor(o: { repo: string; store: EventStore; pool: Pool; now: () => Date; worktree: (repo: string, assignmentId: string, title: string) => Promise<string> }): {
    tick(): Promise<void>              // один проход; таймер вешает app.ts
    resume(goalId: string, assignmentId: string, note: string): Promise<void>   // ответ или возврат: steer или новый запуск
    cancelTree(goalId: string, assignmentId: string, reason: string): Promise<void>
  }
  ```
  `worktree` для `resultKind === 'branch'` создаёт копию через `git worktree add -b crewboard/<id>-<slug> <repo>/.crewboard/worktrees/<id>` и возвращает путь. Для остальных видов возвращает `repo`. Реализация лежит в `supervisor.ts` как экспорт `gitWorktree`.

- [ ] **Step 1: Написать падающий тест `supervisor.test.ts`** на `FakeBackend` и временный git-репозиторий (`git init`, один коммит):
  - Поручение со статусом `queued` и пустым `after` после `tick()` получает `run_started` с `agent: 'claude/sonnet'`.
  - Поручение с `after: [X]` не стартует, пока X не `done`. После `closed` у X следующий `tick()` его запускает.
  - Фейковый запуск отдаёт `progress`-сообщение и завершается финалом с `<crewboard-question>`. После `tick()` в журнале есть `progress`, `question` и `run_ended(completed)`, а статус равен `waiting_answer`.
  - Запуск падает с `failure.code = 'auth'`. В журнале появляется `run_ended(failed, reason 'auth')`, `inbox.pending()` его содержит.
  - Перезапуск: создать второй супервизор на тех же папках при живом фейковом запуске. Его `tick()` продолжает опрос по `runId` из журнала и не создаёт второй `run_started`.
  - `cancelTree` у родителя вызывает `pool.cancel` у живого запуска потомка и пишет `cancelled` обоим.

- [ ] **Step 2: Запустить и убедиться, что тест падает.** Expected: FAIL.

- [ ] **Step 3: Реализовать `tick`.** Порядок: для каждой цели проекта построить дерево. Стартовать `queued`, у которых все `after` в `done`. Опросить каждое поручение с последним `run_started` без `run_ended`. Позиция опроса хранится в памяти по `runId`, после перезапуска опрос идёт с 0, но уже записанные `progress` не дублируются: новый `progress` пишется только если его текст отличается от последнего записанного и прошло не меньше 15 с с прошлого `progress` этого поручения. На терминальном запуске: при `failed` записать `run_ended(failed, reason)`. Иначе разобрать текст последнего события `kind: 'final'` (или `'message'`) через `parseOutcome` и записать `reported` или `question`, затем `run_ended(completed)`. `resume`: если `pool.steer` вернул `'delivered'`, записать `steered`/`answered` и ничего не запускать. Если `'ended'`, запустить новый запуск в том же `cwd` с `workerPrompt({..., resumeNote})`, где `resumeNote` содержит последний итог или вопрос и текст ответа или замечания.

- [ ] **Step 4: Запустить тест.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: add supervisor that starts queued work and relays worker outcomes`.

---

### Task 5: Команды ведущего, MCP и HTTP

**Files:**
- Create: `packages/app/src/lead/commands.ts`, `lead/mcp.ts`, `server.ts`, `app.ts`
- Test: `packages/app/test/lead-flow.test.ts`

**Interfaces:**
- Consumes: всё из Tasks 1–4.
- Produces:
  ```ts
  // app.ts
  export function createApp(o: { env: NodeJS.ProcessEnv; backendFor: (repo: string) => BackendFor; now?: () => Date; tickMs?: number }): {
    listen(port: number): Promise<{ url: string; close(): Promise<void> }>
    tick(): Promise<void>
  }
  // lead/commands.ts — каждая команда проверяет проект (существует, git-репозиторий) и обновляет leadLastSeen цели
  export type LeadCommands = {
    startGoal(i: { project: string; title: string; criteria: string[]; quote?: string }): Promise<{ goalId: string }>
    assign(i: { project: string; goalId: string; parentId?: string; title: string; criteria: string[]; resultKind: ResultKind; provider: ProviderId; model?: string; quote?: string; after?: string[] }): Promise<{ assignmentId: string }>
    inbox(i: { project: string }): Promise<GoalEvent[]>                          // читает и подтверждает
    answer(i: { project: string; goalId: string; assignmentId: string; text: string }): Promise<void>
    escalate(i: { project: string; goalId: string; assignmentId: string; why: string; text?: string; options?: string[] }): Promise<void>
    steer(i: { project: string; goalId: string; assignmentId: string; text: string }): Promise<void>
    returnWork(i: { project: string; goalId: string; assignmentId: string; note: string }): Promise<void>
    close(i: { project: string; goalId: string; assignmentId: string; summary: string }): Promise<void>
    cancel(i: { project: string; goalId: string; assignmentId: string; reason: string }): Promise<void>
    status(i: { project: string; goalId: string }): Promise<AssignmentView>
    adopt(i: { project: string; goalId: string }): Promise<void>
  }
  ```
  MCP-инструменты называются `crewboard_start_goal`, `crewboard_assign`, `crewboard_inbox`, `crewboard_answer`, `crewboard_escalate`, `crewboard_steer`, `crewboard_return`, `crewboard_close`, `crewboard_cancel`, `crewboard_status`, `crewboard_adopt_goal` и вызывают соответствующие команды. Входные схемы описаны через zod.
  HTTP-маршруты: `POST|GET|DELETE /mcp` (Streamable HTTP транспорт SDK, сессия на клиента), `GET /api/health` → `{ ok: true }`, `GET /api/lead/wait?project=<path>&timeoutMs=<n>` (long-poll: отвечает `200 {pending: n}`, как только `inbox.pending()` не пуст, иначе `204` по таймауту, максимум 600000), `GET /api/goals?project=<path>`, `GET /api/goals/:goalId?project=<path>` → `AssignmentView`.
  Поле `instructions` MCP-сервера объясняет ведущему протокол: договорись с владельцем о критериях, затем вызывай `crewboard_start_goal` и `crewboard_assign` с репликой-источником в `quote`. В фоне держи `crewboard-app wait --project <cwd>` (Bash в фоне), на его завершение читай `crewboard_inbox`. Вопросы решай сам или поднимай через `crewboard_escalate` с причиной. Закрывай работу по критериям через `crewboard_close`.

- [ ] **Step 1: Написать падающий интеграционный тест `lead-flow.test.ts`.** `createApp` с `backendFor: () => async () => fake` (`FakeBackend`), временным `CREWBOARD_HOME`, временным git-репозиторием, `listen(0)`. Клиент `Client` из `@modelcontextprotocol/sdk/client` с `StreamableHTTPClientTransport` на `<url>/mcp`. Сценарий:
  1. `crewboard_start_goal` → `goalId`. `crewboard_assign` (provider `codex`, resultKind `local`) → `assignmentId`.
  2. Фейковый запуск завершается вопросом. Вызвать `app.tick()`. `GET /api/lead/wait` отвечает 200. `crewboard_inbox` возвращает `question`. Повторный `crewboard_inbox` возвращает пусто.
  3. `crewboard_answer` с текстом «Шторка». Фейк получает новый запуск, и его промпт содержит «Шторка». Фейк завершается `<crewboard-report>Готово</crewboard-report>`. После `tick()` inbox возвращает `reported`.
  4. `crewboard_close` → `crewboard_status` показывает у поручения статус `done`.
  5. Таблица ошибок: `crewboard_assign` с `project: '/nonexistent'` и с путём к папке без git → результат инструмента `isError: true`, текст содержит `project`. После этого `GET /api/health` всё ещё отвечает `{ok:true}`.
  6. `crewboard_cancel` у корня с живым потомком → потомок `cancelled`, у фейка вызван `cancel`.

- [ ] **Step 2: Запустить и убедиться, что тест падает.** Expected: FAIL.

- [ ] **Step 3: Реализовать `commands.ts`, `mcp.ts`, `server.ts`, `app.ts`.** `app.ts` хранит по супервизору и store на проект (ключ: реальный путь репозитория) и регистрирует проект в реестре при первом вызове. Таймер `tick` на `tickMs` (по умолчанию 2000) запускается в `listen` и останавливается в `close`. Ошибки инструментов возвращаются как `{ isError: true, content: [{ type: 'text', text }] }`, процесс не падает. `escalate` без `text` берёт текст и варианты из последнего `question`. Ответ владельца появится в плане 2.

- [ ] **Step 4: Запустить тест.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: expose lead commands over MCP with a wait endpoint`.

---

### Task 6: Реальные исполнители, бин и проверка вживую

**Files:**
- Modify: `packages/core/src/orchestration/backends.ts:40-44` и `:67-…`: в `BackendsOptions` добавить `runsRoot?: string`, по умолчанию `join(o.root, CREWBOARD_DIR, 'runs')`, и использовать его везде вместо повторённого `join(...)`.
- Create: `packages/app/src/workers/backends.ts`, `packages/app/src/main.ts`, `packages/app/scripts/build.mjs`

**Interfaces:**
- Consumes: `createBackends` из `@crewboard/core` (после правки), `nodeExec` из `core/src/exec.ts`.
- Produces:
  ```ts
  // workers/backends.ts
  export function realBackendFor(o: { repo: string; env: NodeJS.ProcessEnv; home: string }): BackendFor   // runsRoot = <repo>/.crewboard/runs
  ```
  `main.ts` передаёт в `createApp` фабрику `(repo) => realBackendFor({ repo, env, home })`.
  CLI `main.ts`:
  - `crewboard-app serve [--port 4700]` печатает строку `crewboard http://127.0.0.1:<port>  mcp: http://127.0.0.1:<port>/mcp`.
  - `crewboard-app wait --project <path> [--port 4700] [--timeout 10m]` завершается с кодом 0, когда у ведущего есть входящие, 2 по таймауту, 1 если сервер недоступен.

- [ ] **Step 1: Правка core (механическая, без изменения поведения).** Run: `pnpm --filter @crewboard/core test` Expected: все тесты зелёные, как до правки.

- [ ] **Step 2: Реализовать `backends.ts`, `main.ts`, `build.mjs`** по образцу `packages/cli/scripts/build.mjs` (core инлайнится, node builtins external). Run: `pnpm build && node packages/app/dist/main.js serve --port 4711` Expected: строка с адресами. `curl -s http://127.0.0.1:4711/api/health` возвращает `{"ok":true}`.

- [ ] **Step 3: Проверка вживую с Claude Code (вручную, результат записать в описание PR).**
  ```bash
  claude mcp add --transport http crewboard http://127.0.0.1:4700/mcp
  ```
  В новом чате Claude Code в тестовом репозитории попросить: «Поставь цель: добавить в README раздел Usage. Поручи Codex с resultKind local». Ожидается: в `.crewboard/goals/*/events.jsonl` появились `goal_started`, `assigned`, `run_started`, затем `reported`. `crewboard_status` показывает дерево. Повторить с `provider: deepseek` (нужен установленный dsh) и с `provider: claude` (нужен `ANTHROPIC_API_KEY`). Что не удалось проверить, записать явно.

- [ ] **Step 4: Полный прогон.** Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` Expected: всё зелёное.

- [ ] **Step 5: Commit** `feat: run real workers and ship the crewboard-app server`.

---

## Отклонения от спецификации, принятые в этом плане

- **Продолжение после ответа.** Если запуск исполнителя ещё жив, ответ доставляется в ту же сессию через `steer`. Если запуск уже завершился (обычный случай для безголового CLI), стартует новый запуск в той же рабочей копии с полным контекстом в промпте. Это не та же сессия модели. Возобновление сессии по её идентификатору (`claude --resume`, `codex exec resume`) можно добавить позже, не меняя модели событий.
- **Разбиение работы самими исполнителями** перенесено в план 2. В плане 1 дерево строит ведущий: он может давать поручения с `parentId` любого узла.
