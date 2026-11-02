# Crewboard 2a: экран «Сейчас» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец открывает `http://127.0.0.1:4700/` и видит живое дерево поручений текущей цели, отвечает на вопросы, поднятые ему ведущим, и переключается между проектами и целями.

**Architecture:** Сервер из плана 1 получает поток обновлений SSE (`/api/live`), JSON API для экрана и маршрут ответа владельца. Веб-интерфейс на React 18 собирается esbuild в `packages/app/dist/ui/` и отдаётся тем же сервером. Экран повторяет прототип `.superpowers/mockups/crewboard-now-v2.html`: строка-сводка, дерево, панель контекста, на узком экране шторка. Вкладки «История» и «Аналитика» видны, но неактивны до плана 3.

**Tech Stack:** React 18.3, esbuild, обычный CSS (токены и стили из прототипа), vitest, @testing-library/react, jsdom.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-lead-chat-design.md` (разделы «Экраны», «Потоки → Вопросы»).

## Дорожная карта

| План | Статус |
| --- | --- |
| 1. Фундамент | готов, влит в main (f7c35a9) |
| **2a. Экран «Сейчас» (этот)** | |
| 2b. Управление из дерева: просьбы к ведущему, решения ведущего, разбиение работы исполнителями, очистка простаивающих MCP-сессий | |
| 3. История и аналитика | |
| 4. Релиз | |

## Global Constraints

- Всё из Global Constraints плана 1 остаётся в силе (Node 24+, `.crewboard/`, порт 4700, статус только вычисляется, политика тестов, формат коммитов с `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- Язык интерфейса русский. Все видимые строки лежат в одном модуле `src/ui/text.ts`. Двуязычие решается в плане 4.
- Принципы движения из спецификации: UI-анимации до 300 мс, кривая `cubic-bezier(.23,1,.32,1)`, шторка `cubic-bezier(.32,.72,0,1)` 260–280 мс. Переключение вкладок и навигация стрелками не анимируются. Нажатие даёт `scale(.98)`. Под `prefers-reduced-motion` остаются только переходы прозрачности. Hover только под `(hover: hover) and (pointer: fine)`.
- Цвета провайдеров: Claude `#c96442`/`#e08463`, Codex `#2f7d5b`/`#55b38a`, DeepSeek `#3b63c4`/`#7b9cf0` (светлая/тёмная тема). Единственный акцент `#c2410c`/`#f0884f` отмечает то, что ждёт владельца. Мигает только индикатор «Идёт».
- Тёмная и светлая темы через `prefers-color-scheme` и переключатель (`data-theme` на `<html>`, выбор в `localStorage` под try/catch).
- Шторка вместо боковой панели при ширине до `980px`. Шапка перестраивается при ширине до `640px`.
- Без новых тяжёлых зависимостей: React 18.3 и `react-dom` уже есть в репозитории (версии из `packages/plugin`), иконки из `@phosphor-icons/react` ^2.1.7 (единственная новая зависимость).

## Review Focus

1. **Сервер перезапустился, пока экран открыт.** Экран показывает «Нет связи с сервером», после возвращения сам переподключается и перечитывает данные, без перезагрузки страницы. Тест в Task 5.
2. **Двойной клик по ответу.** Второй запрос не уходит, пока первый не завершён. Если ответ уже принят, сервер отвечает `409`, экран показывает актуальное состояние, а не ошибку. Тесты в Task 2 и Task 5.
3. **Выбранный узел исчез или сменилась цель.** Панель контекста выбирает узел «ждёт вас», иначе корень. Пустой панели нет. Тест в Task 4.
4. **Нет ни одной цели.** Пустое состояние объясняет, как подключить Claude Code: команда для копирования, без мёртвых кнопок. Тест в Task 4.
5. **Длинные названия и сотня узлов.** Заголовки обрезаются до двух строк, дерево прокручивается, частые события SSE не перерисовывают весь экран чаще раза в 250 мс. Тест в Task 3: склейка обновлений.

---

## Файловая структура

```
packages/app/
  scripts/build.mjs                + сборка ui: src/ui/main.tsx -> dist/ui/app.js, копия src/ui/index.html и styles.css
  src/
    store/event-store.ts           + onAppend(listener) — подписка на записи
    live.ts                        шина изменений проектов для SSE
    owner.ts                       ответ владельца на эскалацию
    server.ts                      + /api/live (SSE), /api/projects, /api/goals/:id/events, POST /api/answer, статика /
    app.ts                         + проводка live/owner/статики
    ui/
      index.html                   оболочка страницы
      styles.css                   токены и стили из прототипа v2
      text.ts                      все русские строки
      api.ts                       fetch-клиент и useLive (EventSource + склейка 250 мс)
      main.tsx                     точка входа
      app.tsx                      состояние: проект, цель, выбранный узел, тема
      components/summary.tsx
      components/tree.tsx
      components/context-panel.tsx
      components/question-box.tsx
      components/project-bar.tsx
      components/empty-state.tsx
      components/offline-banner.tsx
  test/
    owner.test.ts
    live.test.ts
    ui-now.test.tsx                (// @vitest-environment jsdom)
```

---

### Task 1: Шина изменений и поток SSE

**Files:**
- Modify: `packages/app/src/store/event-store.ts` (подписка `onAppend`)
- Create: `packages/app/src/live.ts`
- Modify: `packages/app/src/server.ts`, `packages/app/src/app.ts`
- Test: `packages/app/test/live.test.ts`

**Interfaces:**
- Consumes: `createEventStore`, `createApp`, `createHttpServer` (план 1).
- Produces:
  ```ts
  // event-store.ts
  onAppend(listener: (e: GoalEvent) => void): () => void      // возвращает отписку
  // live.ts
  export type LiveChange = { project: string; goalId: string; seq: number }
  export function createLive(): { publish(c: LiveChange): void; subscribe(fn: (c: LiveChange) => void): () => void }
  // server.ts: Api получает live: ReturnType<typeof createLive>
  // GET /api/live — text/event-stream; первая строка `event: hello`, затем `event: change\ndata: {"project","goalId","seq"}` на каждую запись; комментарий `: ping` каждые 25 с
  ```

- [ ] **Step 1: Написать падающий тест `live.test.ts`.** Поднять `createApp` с фейковым бэкендом (как в `lead-flow.test.ts`), открыть `fetch(url + '/api/live')` и читать тело потоком. Через MCP вызвать `crewboard_start_goal`. Ожидается: в потоке есть `event: hello`, затем `event: change` с `goalId` новой цели и `seq: 1`. Второй тест: после `server.close()` поток завершается, сервер не висит (тест укладывается в таймаут).
- [ ] **Step 2: Запустить.** Run: `pnpm --filter @crewboard/app test -- live` Expected: FAIL (маршрута нет, ответ 404).
- [ ] **Step 3: Реализовать.** `createApp` подписывается на `onAppend` каждого открытого проекта и публикует `LiveChange` с `project = ctx.repo`. SSE-ответ держит заголовки `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`. Подписчик снимается на `req.on('close')`. `close()` сервера завершает все открытые SSE-ответы.
- [ ] **Step 4: Запустить.** Expected: PASS, весь пакет зелёный.
- [ ] **Step 5: Commit** `feat: stream journal changes to the screen over SSE`.

---

### Task 2: API экрана и ответ владельца

**Files:**
- Create: `packages/app/src/owner.ts`
- Modify: `packages/app/src/server.ts`, `packages/app/src/app.ts`
- Test: `packages/app/test/owner.test.ts`

**Interfaces:**
- Consumes: `ProjectContext` (`exclusive`, `supervisor.deliver`, `store`), `buildTree`, `flatten`, `createRegistry`.
- Produces:
  ```ts
  // owner.ts
  export class ConflictError extends Error {}   // маршрут отвечает 409
  export function answerAsOwner(ctx: ProjectContext, i: { goalId: string; assignmentId: string; text: string }): Promise<void>
  // HTTP
  // GET  /api/projects -> ProjectSummary[]
  export type GoalSummary = { goalId: string; title: string; createdAt: string; status: Status; counts: Record<'waiting_owner' | 'running' | 'queued' | 'finished', number> }
  export type ProjectSummary = { repo: string; name: string; goals: GoalSummary[] }
  // GET  /api/goals/:goalId?project=…              -> AssignmentView (есть с плана 1)
  // GET  /api/goals/:goalId/events?project=…&assignmentId=…  -> GoalEvent[] этого узла
  // POST /api/answer  {project, goalId, assignmentId, text} -> 204 | 409 {error} | 400 {error}
  ```
  `finished` в `counts` складывает `done`, `cancelled` и `abandoned`. `name` это последний сегмент пути репозитория.

- [ ] **Step 1: Написать падающий тест `owner.test.ts`.** Сценарий через MCP и HTTP: цель, поручение, фейк завершается вопросом, `tick`, ведущий вызывает `crewboard_escalate` с `why`. Затем `POST /api/answer` с текстом «Шторка снизу». Проверки:
  - ответ `204`;
  - в журнале узла `answered` с `actor: 'owner'`;
  - у фейка новый запуск, его промпт содержит «Шторка снизу»;
  - `crewboard_inbox` ведущего возвращает это `answered`;
  - второй такой же `POST` отвечает `409`.
  Таблица `it.each` для `400`: нет `text`, пустой `text`, неизвестный `assignmentId`. `GET /api/projects` возвращает проект с этой целью и `counts.waiting_owner === 1` до ответа.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** `answerAsOwner` внутри `ctx.exclusive`: статус узла должен быть `waiting_owner`, иначе `ConflictError`. Записать `answered` (`actor: 'owner'`) и вызвать `supervisor.deliver` с текстом «Ответ владельца: <text>». Проекты для `/api/projects` берутся из реестра.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: let the owner answer escalated questions from the screen`.

---

### Task 3: Каркас интерфейса, сборка и живые данные

**Files:**
- Create: `packages/app/src/ui/index.html`, `ui/styles.css`, `ui/text.ts`, `ui/api.ts`, `ui/main.tsx`, `ui/app.tsx`
- Modify: `packages/app/scripts/build.mjs`, `packages/app/src/server.ts` (статика), `packages/app/package.json` (react, react-dom, @types/react, @types/react-dom, @phosphor-icons/react, @testing-library/react, @testing-library/user-event, jsdom), `packages/app/vitest.config.ts` (include `test/**/*.test.tsx`), `packages/app/tsconfig*.json` (`"jsx": "react-jsx"`, `lib` + `DOM`)
- Test: `packages/app/test/ui-now.test.tsx` (первые тесты)

**Interfaces:**
- Consumes: HTTP API из Tasks 1–2.
- Produces:
  ```ts
  // ui/api.ts
  export type Api = {
    projects(): Promise<ProjectSummary[]>
    goal(project: string, goalId: string): Promise<AssignmentView>
    events(project: string, goalId: string, assignmentId: string): Promise<GoalEvent[]>
    answer(project: string, goalId: string, assignmentId: string, text: string): Promise<'ok' | 'conflict'>
    live(onChange: (c: LiveChange) => void, onStatus: (online: boolean) => void): () => void
  }
  export function httpApi(base?: string): Api
  export function coalesce<T>(fn: (batch: T[]) => void, ms: number): { push(item: T): void; cancel(): void }
  // ui/app.tsx
  export function App(props: { api: Api }): JSX.Element
  ```
  Типы `ProjectSummary`, `AssignmentView`, `GoalEvent`, `LiveChange` импортируются из серверных модулей только как типы (`import type`), чтобы в бандл не попал серверный код.
  Сервер отдаёт `GET /` → `dist/ui/index.html`, `GET /app.js`, `GET /styles.css`. Если `dist/ui` нет (запуск из исходников), `/` отвечает текстом «Интерфейс не собран: выполните pnpm build».

- [ ] **Step 1: Написать падающие тесты** в `ui-now.test.tsx` на фейковом `Api` в памяти:
  - `coalesce` с таймерами vitest (`vi.useFakeTimers`): 20 вызовов `push` за 100 мс дают один вызов `fn` с 20 элементами через 250 мс.
  - `App` с одним проектом и одной целью рисует заголовок цели и строку-сводку «1 ждёт вас · 2 идут · 1 в очереди · 1 завершено» (по счётчикам фейка). Запрос по ролям: `getByRole('heading', { name: 'Кухня полного цикла' })`.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** Стили и токены перенести из прототипа v2 (без анимации появления вида). `App` хранит выбранные проект и цель в `localStorage` (try/catch), по умолчанию берёт первую цель, у которой есть `waiting_owner`, иначе самую свежую. Живые изменения склеиваются через `coalesce(…, 250)`: перечитывается только изменённая цель. Сборка: `esbuild` бандл `src/ui/main.tsx` → `dist/ui/app.js` (`format: 'esm'`, `minify: true`, `jsx: 'automatic'`), копия `index.html` и `styles.css`.
- [ ] **Step 4: Запустить тесты и сборку.** Run: `pnpm --filter @crewboard/app test && pnpm --filter @crewboard/app build` Expected: PASS, в `dist/ui` три файла.
- [ ] **Step 5: Commit** `feat: serve the Now screen shell with live updates`.

---

### Task 4: Дерево, сводка, контекст и пустое состояние

**Files:**
- Create: `packages/app/src/ui/components/summary.tsx`, `tree.tsx`, `context-panel.tsx`, `project-bar.tsx`, `empty-state.tsx`
- Modify: `packages/app/src/ui/app.tsx`
- Test: `packages/app/test/ui-now.test.tsx`

**Interfaces:**
- Consumes: `Api`, `App` (Task 3).
- Produces: компоненты без собственного сетевого кода. Данные приходят пропсами из `App`.
  - `Tree({ root, selectedId, onSelect })` — `role="tree"`, узлы `role="treeitem"` с `aria-current` у выбранного. Порядок детей: `waiting_owner`, `waiting_answer`, `running`, `queued`, затем свёрнутая группа «Завершено N» (`done`, `cancelled`, `abandoned`) с кнопкой `aria-expanded`.
  - `ContextPanel({ node, chain, events, onSelect, onAnswer, sheet, onClose })`.
  - Клавиатура: стрелки вверх и вниз по видимым узлам, `Esc` закрывает шторку.

- [ ] **Step 1: Написать падающие тесты** (запросы по ролям и видимому тексту):
  - Порядок: у корня дети с статусами `done`, `running`, `waiting_owner`, `queued`. Видимые `treeitem` идут в порядке `waiting_owner`, `running`, `queued`, а `done` скрыт в группе «Завершено 1». После клика по группе он виден.
  - Клик по узлу показывает в панели его название, строку «Откуда взялось» с цитатой и критерии.
  - Выбранный узел исчез из нового дерева (фейк меняет дерево и шлёт `live`): панель показывает узел `waiting_owner`, а если его нет, корень.
  - Нет проектов или целей: виден текст «Подключите Claude Code» и блок с командой `claude mcp add --transport http crewboard http://127.0.0.1:4700/mcp`, кнопка «Скопировать» вызывает `navigator.clipboard.writeText` с этой командой.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать** по прототипу v2: аватар провайдера, название в две строки, статус, строка «сейчас делает», цепочка «кто поручил» ссылками, критерии, вложенные поручения, история событий узла (из `api.events`), ссылки на рабочую копию (`cwd`). На ширине до 980 px панель становится шторкой (`matchMedia`), открывается выбором узла.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: show the live assignment tree with its context`.

---

### Task 5: Ответ на вопрос и потеря связи

**Files:**
- Create: `packages/app/src/ui/components/question-box.tsx`, `offline-banner.tsx`
- Modify: `packages/app/src/ui/components/context-panel.tsx`, `packages/app/src/ui/app.tsx`, `packages/app/src/ui/components/summary.tsx`
- Test: `packages/app/test/ui-now.test.tsx`

**Interfaces:**
- Consumes: `Api.answer`, `Api.live` (`onStatus`).
- Produces: `QuestionBox({ question, why, options, onAnswer })`. `onAnswer(text): Promise<'ok' | 'conflict'>`. Кнопки вариантов, поле своего ответа и кнопка «Ответить». Пока запрос идёт, все кнопки `disabled`.

- [ ] **Step 1: Написать падающие тесты:**
  - Узел `waiting_owner` с вариантами «Шторка снизу» и «Полноэкранный слой»: клик по варианту вызывает `api.answer(..., 'Шторка снизу')` ровно один раз, даже при двойном клике (`userEvent.dblClick`).
  - Свой ответ из поля уходит по кнопке «Ответить». Пустое поле кнопку не активирует.
  - `api.answer` вернул `'conflict'`: экран перечитывает цель и не показывает ошибку.
  - Клик по «ждёт вас» в сводке выбирает узел `waiting_owner`.
  - Кнопка «Ждёт вас» в шапке показывает сумму `waiting_owner` по всем проектам. Клик открывает проект и цель первого такого узла и выбирает его.
  - `live` сообщил `onStatus(false)`: виден баннер «Нет связи с сервером». После `onStatus(true)` баннер исчезает, а `api.projects` и `api.goal` вызваны повторно.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать.** `httpApi.live` использует `EventSource`: `onerror` → `onStatus(false)`, событие `hello` → `onStatus(true)`. Повторное подключение делает сам браузер. Сводка: «ждёт вас» — кнопка с акцентом, остальные счётчики текстом.
- [ ] **Step 4: Запустить.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: answer escalated questions and survive a lost connection`.

---

### Task 6: Сборка, проверка вживую и полировка

**Files:**
- Modify: по результатам проверки.

- [ ] **Step 1: Полный прогон.** Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint` Expected: всё зелёное.
- [ ] **Step 2: Живая проверка в браузере.** Поднять `node packages/app/dist/main.js serve --port 4712` с временным `CREWBOARD_HOME` и тестовым репозиторием. Скриптом-ведущим (как в плане 1) поставить цель с тремя поручениями (Codex, DeepSeek, Claude без ключа) и эскалировать вопрос. Открыть `http://127.0.0.1:4712/` во встроенном браузере. Проверить на ширине 1360 и 375 px, в обеих темах: дерево, сводка, шторка, ответ на вопрос из интерфейса доходит до исполнителя. Перезапустить сервер при открытой странице и убедиться, что баннер появляется и исчезает. Найденное исправить с тестом, если это поведение, или напрямую, если это стиль.
- [ ] **Step 3: Commit** `fix: polish the Now screen after the live check` (если были правки).

---

## Решения автора плана

- **Русский интерфейс без i18n на этом этапе.** Все строки в одном модуле, чтобы план 4 мог добавить английский без поиска по коду.
- **Без библиотек состояния и запросов** (React Query, Zustand). Экран один, данные перечитываются по событиям SSE, а собственный хук короче зависимости. Если в плане 2b или 3 экранов станет больше, это решение пересматривается.
