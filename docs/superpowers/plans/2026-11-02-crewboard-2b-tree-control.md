# Crewboard 2b: управление из дерева — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец управляет работой прямо из дерева: каждое действие становится просьбой к ведущему, ведущий решает, и решение видно на узле. Исполнители сами разбивают свою работу на под-поручения.

**Architecture:** Просьбы и решения становятся событиями журнала (`owner_requested`, `request_decided`). Ведущий получает просьбу во входящих и отвечает инструментом `crewboard_decide_request`. Если ведущий соглашается, сервер сам выполняет действие (уточнить, остановить, передать другому, начать раньше, переоткрыть, вернуть), так что действие и решение никогда не расходятся. Исполнитель делит работу блоком `<crewboard-split>` в своём итоге. Супервизор создаёт дочерние поручения, закрывает их итоги за исполнителя и возобновляет его, когда все дети закончили.

**Tech Stack:** как в планах 1 и 2a.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-lead-chat-design.md`, разделы «Просьбы из дерева», «Устаревание», «Модель → Исполнитель».

## Дорожная карта

| План | Статус |
| --- | --- |
| 1. Фундамент | влит (f7c35a9) |
| 2a. Экран «Сейчас» | влит (6507e0e) |
| **2b. Управление из дерева (этот)** | |
| 3. История и аналитика | |
| 4. Релиз | |

## Global Constraints

- Всё из Global Constraints планов 1 и 2a остаётся в силе.
- Решение ведущего финальное. В интерфейсе нет кнопки «всё равно сделать». Причина отказа видна на узле.
- Единственное действие без решения ведущего: аварийная остановка. Она доступна, только когда ведущий не на связи дольше `LEAD_OFFLINE_MS = 10 * 60 * 1000`, выполняется сразу и сообщается ведущему во входящих.
- «Обсудить с ведущим» не требует решения: это заметка ведущему плюс готовая реплика в буфер обмена.
- Протокол разбиения: блок `<crewboard-split>` в итоге исполнителя, по строке на поручение в формате `- [провайдер] Заголовок | критерий; критерий`. Провайдер необязателен, по умолчанию берётся провайдер родителя.

## Review Focus

1. **Две просьбы подряд на один узел** (двойной клик, два окна). Вторая отклоняется с `409`, пока первая ждёт решения. Тест в Task 2.
2. **Ведущий решает по просьбе, а узел уже изменился** (закрыт, отменён). Решение `accept` для невыполнимого действия возвращает ведущему понятную ошибку инструмента, а не ломает журнал. Тест в Task 2.
3. **Исполнитель прислал разбиение с мусором** (пустые строки, неизвестный провайдер, 30 строк). Мусорные строки пропускаются, неизвестный провайдер заменяется провайдером родителя, больше `MAX_SPLIT = 8` детей не создаётся. Тест в Task 3.
4. **Ребёнок разбиения упал.** Родитель всё равно возобновляется, когда остальные закончили, и получает в контексте причину падения. Тест в Task 3.
5. **MCP-сессии копятся при перезапусках Claude Code.** Простаивающая сессия закрывается через `MCP_IDLE_MS = 30 * 60 * 1000`. Тест в Task 5.

---

## Файловая структура

```
packages/app/src/
  model/types.ts          + события owner_requested, request_decided, reassigned, unblocked, reopened; RequestAction; AssignmentView.request, .handoffs
  model/project.ts        + провайдер из reassigned, reopened снимает done/cancelled, unblocked снимает after, request view
  model/thresholds.ts     + LEAD_OFFLINE_MS, MAX_SPLIT, MCP_IDLE_MS
  requests.ts             просьба владельца и решение ведущего с выполнением действия
  workers/protocol.ts     + parseOutcome: kind 'split'
  supervisor.ts           + разбиение, автозакрытие итогов детей, возобновление родителя, reassign
  store/inbox.ts          + owner_requested в входящих ведущего
  lead/commands.ts, lead/mcp.ts   + crewboard_decide_request
  server.ts, app.ts       + POST /api/request, очистка простаивающих MCP-сессий
  ui/components/actions.tsx       панель действий по статусу
  ui/components/request-line.tsx  состояние просьбы на узле и в панели
  ui/text.ts, ui/app.tsx, ui/components/{tree,context-panel}.tsx
packages/app/test/
  status.test.ts (строки), requests.test.ts, split.test.ts (supervisor), lead-flow.test.ts (решение через MCP), ui-now.test.tsx (действия)
```

---

### Task 1: Модель просьб, передачи и возобновления

**Files:**
- Modify: `packages/app/src/model/types.ts`, `model/project.ts`, `model/thresholds.ts`
- Test: `packages/app/test/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const REQUEST_ACTIONS = ['clarify', 'stop', 'handoff', 'start_now', 'cancel', 'reopen', 'revive', 'discuss'] as const
  export type RequestAction = (typeof REQUEST_ACTIONS)[number]
  // новые события (база как у остальных)
  | { type: 'owner_requested'; requestId: string; action: RequestAction; text?: string; provider?: ProviderId }
  | { type: 'request_decided'; requestId: string; decision: 'accepted' | 'declined'; reason?: string }
  | { type: 'reassigned'; provider: ProviderId; model?: string }
  | { type: 'unblocked' }
  | { type: 'reopened'; note: string }
  // AssignmentView
  request?: { id: string; action: RequestAction; text?: string; provider?: ProviderId; state: 'pending' | 'declined'; reason?: string }
  handoffs: Array<{ from: ProviderId; to: ProviderId }>
  // project.ts
  export function availableActions(node: AssignmentView, leadOnline: boolean): RequestAction[] | 'emergency_stop'[]
  ```
  `request` показывает последнюю просьбу, если она ждёт решения или была отклонена позже последнего значимого события узла. Принятая просьба не показывается: её результат виден по самому узлу.
  `availableActions`: `running`/`waiting_answer` → `clarify`, `stop`, `handoff`, `discuss`; `queued` → `start_now`, `cancel`, `discuss`; `done` → `reopen`, `discuss`; `cancelled`/`abandoned` → `revive`, `discuss`; `waiting_owner` → `discuss`; корень → `discuss`. При ожидающей просьбе → только `discuss`.

- [ ] **Step 1: Написать падающие строки в `status.test.ts`:**

  | Строка | События | Ожидается |
  | --- | --- | --- |
  | переоткрыто после закрытия | assigned, run_started, reported, closed, reopened | `waiting_answer` (запуска после reopened ещё нет, ход за ведущим) |
  | возвращено после отмены | assigned, cancelled, reopened | `queued` (запусков не было) |
  | after снят | assigned(after: [x]) при x не done, unblocked | у `buildTree` узел готов к старту: тест супервизора в Task 2 |
  | провайдер после передачи | assigned(codex), reassigned(claude) | `buildTree` → `provider: 'claude'`, `handoffs: [{from:'codex', to:'claude'}]` |
  | просьба ждёт | …, owner_requested(stop) | `request.state === 'pending'` |
  | просьба отклонена | …, owner_requested(stop), request_decided(declined, 'нужна для инструкции') | `request.state === 'declined'`, `reason` |
  | просьба принята | …, owner_requested(stop), request_decided(accepted) | `request` отсутствует |

  Таблица `availableActions` по статусам из Interfaces, плюс строка «ждёт решения → только discuss».
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** `deriveStatus`: `closed`/`cancelled` терминальны, только если после них нет `reopened`. После `reopened` статус считается заново по событиям позже него.
- [ ] **Step 4: Запустить.** Expected: PASS, весь пакет зелёный.
- [ ] **Step 5: Commit** `feat: model owner requests, handoffs and reopening`.

---

### Task 2: Просьбы владельца и решения ведущего

**Files:**
- Create: `packages/app/src/requests.ts`
- Modify: `store/inbox.ts` (owner_requested — событие для ведущего), `supervisor.ts` (`reassign`, учёт `unblocked`), `lead/commands.ts`, `lead/mcp.ts`, `server.ts`, `app.ts`
- Test: `packages/app/test/requests.test.ts`

**Interfaces:**
- Consumes: Task 1, `ProjectContext`, `supervisor.deliver`, `supervisor.cancelTree`.
- Produces:
  ```ts
  // requests.ts
  export function requestAsOwner(ctx: ProjectContext, i: { goalId: string; assignmentId: string; action: RequestAction; text?: string; provider?: ProviderId }, now: Date): Promise<{ requestId: string }>
  export function emergencyStop(ctx: ProjectContext, i: { goalId: string; assignmentId: string }, now: Date): Promise<void>
  export function decideRequest(ctx: ProjectContext, i: { goalId: string; assignmentId: string; requestId: string; decision: 'accepted' | 'declined'; reason?: string }, now: Date): Promise<void>
  // supervisor.ts
  reassign(goalId: string, assignmentId: string, provider: ProviderId, model?: string): Promise<void>   // стоп открытого запуска, событие reassigned, новый запуск в той же копии с контекстом
  // HTTP
  // POST /api/request  {project, goalId, assignmentId, action, text?, provider?} -> 200 {requestId} | 409 | 400 | 403 | 415
  // POST /api/emergency-stop {project, goalId, assignmentId} -> 204 | 409 (ведущий на связи)
  // MCP: crewboard_decide_request({project, goalId, assignmentId, requestId, decision, reason?})
  ```
  Действия при `accepted`: `clarify` → `steered` + `deliver('Уточнение от владельца: …')`; `stop`/`cancel` → `cancelTree(…, 'Остановлено по просьбе владельца')`; `handoff` → `reassign`; `start_now` → событие `unblocked` и такт; `reopen`/`revive` → событие `reopened` и `deliver('Владелец вернул работу: …')`. `discuss` записывается как `owner_requested` и сразу считается принятым: ведущий получает его во входящих, решения не нужно.
  Причина отказа (`reason`) обязательна при `declined`.

- [ ] **Step 1: Написать падающий `requests.test.ts`** (через `startApp`, MCP и HTTP):
  - Просьба `stop` на идущем узле → `crewboard_inbox` содержит `owner_requested`. `crewboard_decide_request(accepted)` → у фейка вызван `cancel`, узел `cancelled`, `request` не показывается.
  - Просьба `handoff` на Claude → после `accepted` у узла `provider: 'claude'`, новый запуск у фейка с агентом `claude/sonnet`, `handoffs` содержит переход.
  - Отказ без `reason` → ошибка инструмента. Отказ с причиной → `request.state === 'declined'`, причина видна в `GET /api/goals/:id`.
  - Вторая просьба, пока первая ждёт → `409`.
  - `accepted` для `stop`, когда узел уже `done` → ошибка инструмента, журнал без лишних событий.
  - `start_now` на узле с невыполненным `after` → после `accepted` узел запущен.
  - Аварийная остановка при ведущем на связи → `409`. При `leadLastSeen` старше `LEAD_OFFLINE_MS` (`now` приложения сдвинут) → `204`, узел `cancelled`, ведущий видит это во входящих.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** Всё внутри `ctx.exclusive`. Проверка источника и типа содержимого как у `/api/answer` (вынести в общую функцию `guardBrowserPost`).
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: turn tree actions into requests the lead decides`.

---

### Task 3: Разбиение работы исполнителем

**Files:**
- Modify: `packages/app/src/workers/protocol.ts`, `supervisor.ts`, `model/thresholds.ts`
- Test: `packages/app/test/split.test.ts`, `packages/app/test/protocol.test.ts` (строки)

**Interfaces:**
- Produces:
  ```ts
  export type WorkerOutcome = … | { kind: 'split'; summary: string; parts: Array<{ title: string; criteria: string[]; provider?: ProviderId }> }
  ```
  `workerPrompt` получает раздел «Если работу стоит разделить» с форматом блока.
  Супервизор при `split`: записывает `reported` (сводка до блока), создаёт до `MAX_SPLIT` поручений `assigned` с `parentId` = исполнитель, `actor: 'worker'`, `resultKind` родителя, затем `run_ended`. Пока у родителя есть незавершённые дети, он в статусе `running` со строкой «Ждёт свои поручения: N из M готовы». Итог ребёнка (`reported`) супервизор сразу закрывает (`closed`, `actor: 'system'`). Упавший ребёнок отменяется (`cancelled` с причиной падения). Когда все дети терминальны, родитель возобновляется через `deliver` с итогами детей в контексте.
  Вопросы детей идут ведущему, как и раньше: исполнитель-родитель не может ответить посреди запуска.

- [ ] **Step 1: Падающие тесты.** `protocol.test.ts`: строки `parseOutcome` для `split` — нормальный блок; строка без провайдера; неизвестный провайдер → `undefined`; пустые строки пропускаются; 30 строк → 30 частей (обрезка до `MAX_SPLIT` в супервизоре). `split.test.ts` на `FakeBackend`:
  - родитель разбил на две части (codex и без провайдера) → два ребёнка с правильными провайдерами, у родителя «Ждёт свои поручения: 0 из 2 готовы»;
  - оба ребёнка доложили → дети `done`, у фейка новый запуск родителя, его промпт содержит итоги обоих;
  - один ребёнок упал → он `cancelled`, родитель возобновлён, промпт содержит причину;
  - 30 частей → создано 8 детей.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.**
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: let workers split their work into child assignments`.

---

### Task 4: Действия в интерфейсе

**Files:**
- Create: `packages/app/src/ui/components/actions.tsx`, `ui/components/request-line.tsx`
- Modify: `ui/api.ts` (`request`, `emergencyStop`), `ui/text.ts`, `ui/app.tsx`, `ui/components/context-panel.tsx`, `ui/components/tree.tsx`, `server.ts`/`owner.ts` (в `ProjectSummary` поле `leadOnline` у цели)
- Test: `packages/app/test/ui-now.test.tsx`

**Interfaces:**
- Produces: `Actions({ node, leadOnline, onRequest, onEmergencyStop })`. Кнопки по `availableActions`. Для `clarify`, `reopen`, `revive` открывается поле текста. Для `handoff` выбор провайдера (кроме текущего). `discuss` копирует реплику «Обсудим поручение «<название>» (<goalId>/<id>): » в буфер и отправляет просьбу. Пока запрос идёт, кнопки `disabled`. Ошибка показывается в блоке, как у ответа на вопрос.
  `RequestLine({ request })`: «Запрошено: <действие>. Ведущий решает» или «Ведущий против: <причина>». Строка видна под узлом в дереве и в панели.
  Горячие клавиши, пока фокус в дереве: `U` уточнить, `S` остановить, `P` передать, `C` обсудить.

- [ ] **Step 1: Падающие тесты** на фейковом `Api`:
  - узел `running` показывает кнопки «Уточнить», «Остановить», «Передать», «Обсудить с ведущим»; узел `queued` — «Начать раньше», «Отменить»;
  - «Остановить» вызывает `api.request(…, 'stop')` один раз при двойном клике;
  - «Передать» → выбор «Claude» → `api.request(…, 'handoff', undefined, 'claude')`;
  - узел с `request.state === 'pending'` показывает «Ведущий решает» и только «Обсудить с ведущим»;
  - отклонённая просьба показывает причину;
  - ведущий не на связи → видна «Аварийная остановка», она вызывает `api.emergencyStop`;
  - клавиша `S` при фокусе в дереве запрашивает остановку выбранного узла.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать** в стиле прототипа: панель действий под заголовком контекста, кнопки `.btn`, без анимаций кроме нажатия.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: control work from the tree through the lead`.

---

### Task 5: Очистка простаивающих MCP-сессий

**Files:**
- Modify: `packages/app/src/server.ts`, `model/thresholds.ts`
- Test: `packages/app/test/lead-flow.test.ts`

**Interfaces:**
- Produces: `createHttpServer(api, { now?: () => number; mcpIdleMs?: number })`. У каждой сессии метка последнего запроса. Проверка раз в минуту (и метод `sweep()` для тестов) закрывает сессии старше `MCP_IDLE_MS`. Клиент закрытой сессии получает `404` и переподключается (поведение из плана 1).

- [ ] **Step 1: Падающий тест:** клиент подключился. Время сдвигается на `MCP_IDLE_MS + 1`, вызывается `sweep()`. Следующий вызов инструмента со старой сессией получает `404`, новый клиент работает.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.**
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: close idle MCP sessions`.

---

### Task 6: Проверка вживую

- [ ] **Step 1: Полный прогон** `pnpm build && pnpm typecheck && pnpm test && pnpm lint`.
- [ ] **Step 2: Живой сценарий** на стенде из плана 2a (`crewboard-app` в `.claude/launch.json`). Скрипт-ведущий ставит цель с поручением Codex, которому велено разбить работу на две части. Проверить в браузере: дети появились под исполнителем, после их итогов исполнитель возобновился. С экрана отправить просьбу «Передать» на DeepSeek. Скрипт-ведущий принимает её, а на просьбу «Остановить» отказывает с причиной. Проверить отображение на 1360 и 375 px.
- [ ] **Step 3: Commit** правок полировки, если были.
