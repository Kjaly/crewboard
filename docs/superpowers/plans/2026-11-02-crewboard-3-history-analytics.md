# Crewboard 3: история и аналитика — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вкладка «История» показывает полный разговор владельца с ведущим из транскриптов Claude Code, с карточками поручений и переходами в дерево и обратно. Вкладка «Аналитика» показывает дорожки провайдеров во времени и затраты по провайдерам и поручениям.

**Architecture:** Сервер находит транскрипты сам, без участия ведущего. Транскрипт — это файл `~/.claude/projects/<папка проекта>/<sessionId>.jsonl`, имя папки получается из пути заменой каждого символа, кроме латинских букв и цифр, на `-`. К цели относятся все сессии в папке проекта, где есть вызов инструмента `mcp__<сервер>__crewboard_*` с этим `goalId` во входе или в результате. Так находятся и чат, начавший цель, и чаты, подхватившие её позже. Разбор терпимый: незнакомые строки пропускаются. Затраты записываются в событие `run_ended` при завершении запуска из `RunBackend.usage`.

**Tech Stack:** как в предыдущих планах.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-lead-chat-design.md`, раздел «Экраны → История, Аналитика».

## Дорожная карта

| План | Статус |
| --- | --- |
| 1, 2a, 2b | влиты (последний 9776c33) |
| **3. История и аналитика (этот)** | |
| 4. Релиз | |

## Global Constraints

- Всё из Global Constraints предыдущих планов остаётся в силе.
- Корень транскриптов: `~/.claude/projects`, переопределяется переменной `CREWBOARD_CLAUDE_PROJECTS` (для тестов).
- Транскрипт только читается. Сервер никогда не пишет в `~/.claude`.
- Терпимость: невалидный JSON, неизвестный `type`, неожиданная форма `content` пропускаются. Если ни одной сессии не найдено или все файлы нечитаемы, «История» отвечает `available: false`, а экран честно пишет, что полного текста нет, и показывает реплики-источники из поручений.
- Показываются реплики владельца (`type: 'user'`, текст) и ответы ведущего (`type: 'assistant'`, блоки `text`). Скрываются: `isSidechain: true`, блоки `thinking`, результаты инструментов, служебные строки (`attachment`, `system`, `api-request*`, `queue-operation` и подобные), служебные вставки в тексте владельца (`<system-reminder>…</system-reminder>`, `<local-command-…>`, `<command-…>`). Вызовы `crewboard_*` становятся карточками, остальные вызовы инструментов сворачиваются в счётчик «N действий».
- Затраты: «деньги» (`usd`), «по ценам API» (`apiEquivalentUsd`) и «нет данных» никогда не смешиваются. Отсутствие значения показывается как «нет данных», а не как ноль.
- Кэш разбора: по пути файла, его размеру и времени изменения.

## Review Focus

1. **Транскрипт растёт, пока открыт экран.** Новые реплики появляются по живому обновлению: изменение журнала цели перечитывает историю. Кэш по размеру не отдаёт устаревший разбор. Тест в Task 1.
2. **Большой транскрипт** (десятки мегабайт). Файл читается потоково построчно, не целиком в строку. Ответ API ограничен последними `HISTORY_LIMIT = 2000` элементами с признаком `truncated`. Тест в Task 1.
3. **Транскрипт другой цели в той же папке.** В историю попадают только сессии, где есть этот `goalId`. Тест в Task 1.
4. **Запуск без данных о затратах** (dsh не отдаёт деньги, упавший запуск). Аналитика показывает «нет данных», итог не притворяется точным. Тест в Task 4.
5. **Переход из истории к удалённому узлу.** Карточка поручения, которого больше нет в дереве, показывается неактивной, а не ломает экран. Тест в Task 3.

---

## Файловая структура

```
packages/app/src/
  history/paths.ts        claudeProjectsRoot(env), projectFolder(path)
  history/transcript.ts   readTranscript(file) -> TranscriptItem[] (потоково, терпимо)
  history/sessions.ts     sessionsForGoal(...), goalHistory(...) с кэшем
  model/types.ts          + run_ended.usage
  workers/pool.ts         + usage в PollResult при завершении
  supervisor.ts           + usage в run_ended
  analytics.ts            goalAnalytics(events) -> { lanes, totals }
  server.ts, app.ts       + GET /api/goals/:id/history, GET /api/goals/:id/analytics
  ui/api.ts               + history(), analytics()
  ui/components/history-view.tsx
  ui/components/analytics-view.tsx
  ui/app.tsx              вкладки активны, переходы между видами
packages/app/test/
  transcript.test.ts, analytics.test.ts, ui-history.test.tsx, fixtures/transcripts/*.jsonl
```

---

### Task 1: Чтение транскриптов и поиск сессий цели

**Files:**
- Create: `packages/app/src/history/paths.ts`, `history/transcript.ts`, `history/sessions.ts`, `packages/app/test/fixtures/transcripts/*.jsonl`
- Test: `packages/app/test/transcript.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // paths.ts
  export const claudeProjectsRoot = (env: NodeJS.ProcessEnv): string
  export const projectFolder = (absPath: string): string            // '/Users/a/b.c' -> '-Users-a-b-c'
  // transcript.ts
  export type TranscriptItem =
    | { kind: 'owner'; ts: string; text: string; uuid: string }
    | { kind: 'lead'; ts: string; text: string; uuid: string }
    | { kind: 'tool'; ts: string; name: string; toolUseId: string; input: unknown }            // любой tool_use ассистента
    | { kind: 'tool_result'; ts: string; toolUseId: string; text: string }
  export function readTranscript(file: string): Promise<{ sessionId: string; items: TranscriptItem[] }>
  // sessions.ts
  export type HistoryItem =
    | { kind: 'session'; ts: string; sessionId: string }
    | { kind: 'owner' | 'lead'; ts: string; text: string }
    | { kind: 'assignment'; ts: string; tool: string; goalId: string; assignmentId?: string; title?: string }
    | { kind: 'actions'; ts: string; count: number }
  export type GoalHistory = { available: boolean; truncated: boolean; items: HistoryItem[] }
  export function createHistory(o: { env: NodeJS.ProcessEnv }): { goalHistory(repo: string, goalId: string): Promise<GoalHistory> }
  export const HISTORY_LIMIT = 2000
  ```
  `kind: 'tool'` с именем, оканчивающимся на `crewboard_<имя>`, превращается в `assignment`. `assignmentId` берётся из результата `crewboard_assign` (`{"assignmentId": …}`) или из входа остальных инструментов. Подряд идущие прочие вызовы склеиваются в один `actions` со счётчиком. Сессии сортируются по времени первой строки, перед каждой стоит элемент `session`.

- [ ] **Step 1: Подготовить фикстуры** по реальной форме строк Claude Code (2026-11-02): `type`, `uuid`, `timestamp`, `sessionId`, `isSidechain`, `message.content` (строка или массив блоков `text`/`thinking`/`tool_use`/`tool_result`). Файлы: `lead-a.jsonl` (цель `g1`: реплика владельца, ответ, `crewboard_start_goal` с результатом `{"goalId":"g1"}`, `crewboard_assign` с результатом `{"assignmentId":"a-1"}`, два вызова `Bash`, служебные строки `attachment`, `system`, строка с `isSidechain: true`, реплика владельца с `<system-reminder>`), `lead-b.jsonl` (подхват `g1` через `crewboard_adopt_goal` позже), `other.jsonl` (цель `g2`), `broken.jsonl` (обрезанная строка и мусор).
- [ ] **Step 2: Написать падающий тест `transcript.test.ts`:**
  - `projectFolder('/private/tmp/x.y/a_b')` → `'-private-tmp-x-y-a-b'`.
  - `readTranscript(lead-a)` даёт по порядку owner, lead, tool(start_goal), tool_result, tool(assign), tool_result, tool(Bash)×2. Служебные строки, sidechain и `thinking` отсутствуют. Текст владельца без `<system-reminder>…</system-reminder>`.
  - `goalHistory(repo, 'g1')` возвращает сессии `lead-a` и `lead-b` по времени, без `other`. Карточка `crewboard_assign` содержит `assignmentId: 'a-1'`. Два `Bash` склеены в `{ kind: 'actions', count: 2 }`.
  - `broken.jsonl` в той же папке не роняет разбор.
  - Нет папки проекта → `{ available: false, items: [] }`.
  - Дописать в `lead-a` новую реплику владельца → следующий `goalHistory` её содержит (кэш учитывает размер).
  - Файл из 3000 реплик → `items.length === HISTORY_LIMIT`, `truncated: true`, последняя реплика на месте.
- [ ] **Step 3: Запустить.** Expected: FAIL.
- [ ] **Step 4: Реализовать.** Чтение через `readline` поверх `createReadStream`. Поиск сессий: файлы `*.jsonl` в папке проекта, у которых есть `goalId` в тексте (быстрый отсев по подстроке до разбора).
- [ ] **Step 5: Запустить.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: read the lead's Claude Code transcripts for a goal`.

---

### Task 2: Затраты на завершении запуска

**Files:**
- Modify: `model/types.ts` (`run_ended.usage`), `workers/pool.ts`, `supervisor.ts`, `test/fake-backend.ts`
- Test: `packages/app/test/supervisor.test.ts` (строка)

**Interfaces:**
- Produces:
  ```ts
  export type RunCost = { inputTokens?: number; outputTokens?: number; usd?: number; apiUsd?: number }
  // run_ended: + usage?: RunCost
  // PollResult: + usage?: RunCost   (при terminal, из backend.usage?.(runId); ошибка чтения → без usage)
  ```
- [ ] **Step 1: Падающая строка в `supervisor.test.ts`:** фейк отдаёт `usage: { calls: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.04 }`. После завершения `run_ended.usage` равно `{ inputTokens: 1200, outputTokens: 300, usd: 0.04 }`. Второй запуск без `usage` у фейка → `run_ended` без поля `usage`.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** `apiUsd` берётся из `apiEquivalentUsd`.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: record run costs when a run ends`.

---

### Task 3: Маршрут и вкладка «История»

**Files:**
- Modify: `server.ts`, `app.ts` (`GET /api/goals/:id/history?project=…`), `ui/api.ts`, `ui/text.ts`, `ui/app.tsx`, `ui/components/context-panel.tsx` (ссылка «Открыть в истории»)
- Create: `ui/components/history-view.tsx`
- Test: `packages/app/test/ui-history.test.tsx`, строка в `owner.test.ts` для маршрута

**Interfaces:**
- Produces: `Api.history(project, goalId): Promise<GoalHistory>`. `HistoryView({ history, tree, onOpenNode, focusAssignment })`. Вкладки — настоящие `tab` с `tabpanel`. Выбранная вкладка хранится в `localStorage`.
  Переходы: карточка поручения в истории → вкладка «Сейчас», выбор узла. «Открыть в истории» в контексте → вкладка «История», прокрутка к карточке этого поручения (или к первой реплике, если карточки нет) и короткая подсветка. Подсветка отключается при `prefers-reduced-motion`.
- [ ] **Step 1: Падающие тесты** на фейковом `Api`:
  - вкладка «История» показывает реплики владельца и ведущего по порядку, разделитель сессии и карточку «Мобильная панель» со статусом из дерева;
  - клик по карточке переключает на «Сейчас» и выбирает узел;
  - карточка поручения, которого нет в дереве, неактивна (`aria-disabled`);
  - `available: false` → текст «Полный разговор недоступен: транскрипт Claude Code не найден» и список реплик-источников из дерева;
  - «Открыть в истории» в контексте узла переключает вкладку, и карточка узла получает `data-focused`;
  - маршрут: `GET /api/goals/:id/history` для цели без транскрипта отвечает `{ available: false, truncated: false, items: [] }`.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** Живое обновление перечитывает историю вместе с деревом, если открыта эта вкладка.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: show the full conversation with the lead`.

---

### Task 4: Аналитика

**Files:**
- Create: `packages/app/src/analytics.ts`, `ui/components/analytics-view.tsx`
- Modify: `server.ts`, `app.ts` (`GET /api/goals/:id/analytics`), `ui/api.ts`, `ui/text.ts`, `ui/app.tsx`
- Test: `packages/app/test/analytics.test.ts`, строки в `ui-history.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type Lane = { provider: ProviderId; bars: Array<{ assignmentId: string; title: string; start: string; end?: string; outcome?: 'completed' | 'failed' | 'cancelled' }> }
  export type CostCell = { usd?: number; apiUsd?: number; inputTokens?: number; outputTokens?: number; runs: number; runsWithoutData: number }
  export type GoalAnalytics = { from: string; to: string; lanes: Lane[]; byProvider: Record<string, CostCell>; byAssignment: Array<{ assignmentId: string; title: string; provider: ProviderId } & CostCell> }
  export function goalAnalytics(events: GoalEvent[], now: Date): GoalAnalytics
  ```
  Полоса — это запуск от `run_started` до `run_ended` (открытый запуск тянется до `now`). Провайдер полосы берётся из агента запуска (`claude/` → claude, `codex/` → codex, `dsh/` → deepseek).
- [ ] **Step 1: Падающие тесты.** `analytics.test.ts`: два запуска codex (один с `usd`, один без usage), один dsh без денег, один открытый claude. Проверки: три дорожки, у codex `runs: 2, runsWithoutData: 1, usd: 0.04`, у deepseek `usd` отсутствует (не 0), открытая полоса без `end`, `to` равно `now`. UI: вкладка «Аналитика» рисует дорожку на провайдера с подписью и строку «нет данных» там, где денег нет; «по ценам API» показано отдельно от «деньги».
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать** по прототипу дорожек из `crewboard-now-v2.html` (вкладка «Аналитика»), с укладкой полос в ряды и линией «сейчас».
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: add provider lanes and costs to analytics`.

---

### Task 5: Проверка вживую

- [ ] **Step 1: Полный прогон** `pnpm build && pnpm typecheck && pnpm test && pnpm lint`.
- [ ] **Step 2: Живая проверка истории на реальном транскрипте.** Запустить сервер с `CREWBOARD_CLAUDE_PROJECTS`, указывающим на копию папки этого проекта из `~/.claude/projects`, в которой есть вызовы `crewboard_*` (если таких нет, провести короткую сессию Claude Code с подключённым MCP по инструкции из плана 1 и попросить поставить цель). Проверить в браузере вкладки «История» и «Аналитика» на 1360 и 375 px, переходы в обе стороны и поведение при отсутствии транскрипта.
- [ ] **Step 3: Commit** правок полировки, если были.
