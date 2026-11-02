# Crewboard: надёжность и контроль — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Часть 1 дизайна «любой ведущий, любой исполнитель»: аварийная остановка всегда, состояние «Доложено» у частей работы, входящие ведущего не теряются, Claude-исполнитель работает с настройками и обычным входом пользователя.

**Architecture:** Статусы по-прежнему выводятся из журнала (`model/project.ts`). Входящие получают подтверждение «выдано этой MCP-сессии → подтверждено её следующим вызовом» поверх файла `inbox.json`. Режим запуска Claude (`native` или `isolated`) выбирается переменной окружения и записывается в `args.json` запуска; политика «только API-ключ» действует только в `isolated`.

**Tech Stack:** Node 24, TypeScript, pnpm 11.5.2, vitest, Testing Library, MCP SDK 1.32.2, React 18.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-any-lead-any-agent-design.md` (часть 1 и раздел «Решения владельца»).

## Global Constraints

- Журнал только дописывается; статусы выводятся, не хранятся. Старые журналы открываются без миграции.
- Каждый новый текст интерфейса — в `src/ui/i18n/ru.ts` и `src/ui/i18n/en.ts` одной формы.
- Тесты: мало, про поведение; новая ветка поведения — строка в существующей таблице `it.each`. Тексты интерфейса и промптов не тестируются.
- Crewboard никогда не читает, не хранит и не передаёт учётные данные Claude.
- Английские руководства в `docs/en` — источник, `docs/ru` — их пара с теми же именами файлов; `pnpm lint` проверяет документацию.
- Коммиты — Conventional Commits без scope, с концовкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Ведущий оборвался, не обработав выданные события: новая сессия получает их снова (тест в Task 3).
2. `crewboard wait` после вызова `crewboard_inbox` не просыпается сразу же на уже выданных событиях, иначе ведущий крутится вхолостую (тест в Task 3).
3. Старый журнал, где части исполнителя уже закрыты системным `closed`, по-прежнему показывает их «Готово» (строка в таблице Task 2).
4. Вложенное разбиение: части частей становятся «Готово», когда ведущий закрывает верхний узел (строка в таблице Task 2).
5. В режиме `native` Claude-исполнитель запускается без `ANTHROPIC_API_KEY`, а продолжение такого запуска (steer) не отказывается как «непроверенный» (тесты в Task 4).

---

### Task 1: Аварийная остановка всегда

**Files:**
- Modify: `packages/crewboard/src/model/project.ts` (`availableActions`)
- Modify: `packages/crewboard/src/requests.ts` (`emergencyStop`)
- Modify: `packages/crewboard/src/ui/i18n/{ru,en}.ts` (`system.emergency_stop`, `emergencyHint`, новый `leadAwayHint`)
- Modify: `packages/crewboard/src/ui/components/actions.tsx` (подсказка `leadAwayHint`)
- Modify: `docs/{en,ru}/screen.md`, `docs/{en,ru}/lead.md`
- Test: `packages/crewboard/test/status.test.ts`, `packages/crewboard/test/requests.test.ts`

**Interfaces:**
- Produces: `availableActions(node, leadOnline)` включает `'emergency_stop'` для любого живого узла (`running`, `waiting_answer`), независимо от `leadOnline`. Сигнатура не меняется.

- [ ] **Step 1: Тесты.** В `status.test.ts` тест «offers only discussion while a request waits…» переписать в таблицу:

```ts
it.each([
  ['lead online, running', 'running', true, undefined, true],
  ['lead away, running', 'running', false, undefined, true],
  ['request pending, lead online', 'running', true, 'pending', true],
  ['queued', 'queued', true, undefined, false],
])('emergency stop: %s', (_n, status, online, request, expected) => {
  const base = request ? tree(ev({ type: 'owner_requested', requestId: 'r1', action: 'clarify', text: 'x' })) : tree()
  expect(availableActions({ ...base, status }, online).includes('emergency_stop')).toBe(expected)
})
```

В `requests.test.ts` тест «stops at once without the lead only while the lead is away» заменить на «stops at once even while the lead is online»: `POST /api/emergency-stop` сразу отвечает 204, узел `cancelled`, во входящих ведущего есть `cancelled` от `owner`.

- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/status.test.ts test/requests.test.ts`. Expected: новые строки и тест падают.
- [ ] **Step 3: Реализация.** В `availableActions` добавлять `'emergency_stop'` при `live` всегда (и при ожидающей просьбе: `['discuss', 'emergency_stop']`). Комментарий над функцией обновить. В `emergencyStop` убрать зависимость от присутствия ведущего; причина в журнале — `'Emergency stop by the owner'`, код `emergency_stop`. Словари: `system.emergency_stop` — «аварийная остановка владельцем» / «emergency stop by the owner»; `emergencyHint` — «Остановка сработает сразу, в обход ведущего. Ведущий узнает о ней из входящих.» / «Stops at once, without the lead. The lead hears about it in its inbox.». Обычная просьба «Остановить» не меняется. Если ведущий не на связи (`!leadOnline`), подсказка у просьб дополняется фразой «Ведущий не на связи: ответа может не быть, есть аварийная остановка.» / «The lead is offline: there may be no answer; the emergency stop works now.» (новый ключ `leadAwayHint`, показывается в `actions.tsx` над кнопками, когда `!leadOnline` и узел живой).
- [ ] **Step 4:** тот же запуск. Expected: PASS. Затем `pnpm --filter crewboard test`.
- [ ] **Step 5: Документация.** `docs/{en,ru}/screen.md` (таблица действий и абзац про аварийную остановку) и `docs/{en,ru}/lead.md` (абзац «One action does not wait for the lead…»): остановка доступна всегда, ведущий узнаёт из входящих.
- [ ] **Step 6: Commit** `feat: let the owner stop running work at any time`.

### Task 2: Состояние «Доложено» у частей работы

**Files:**
- Modify: `packages/crewboard/src/model/types.ts` (`Status`)
- Modify: `packages/crewboard/src/model/project.ts` (`deriveStatus`, `doingOf`, `availableActions`, новый `isSettled`)
- Modify: `packages/crewboard/src/supervisor.ts` (убрать системное закрытие частей; `resumeAfterSplit`, подсчёт `children`)
- Modify: `packages/crewboard/src/store/inbox.ts` (`isLeadEvent` с учётом владельца поручения)
- Modify: `packages/crewboard/src/ui/i18n/{ru,en}.ts`, `packages/crewboard/src/ui/components/{badges,summary,tree}.tsx`
- Modify: `docs/{en,ru}/screen.md` (таблица статусов), `docs/{en,ru}/workers.md` (абзац о разбиении)
- Test: `packages/crewboard/test/status.test.ts`, `packages/crewboard/test/split.test.ts`, `packages/crewboard/test/event-store.test.ts`

**Interfaces:**
- Produces: `Status` получает значение `'reported'`. `isSettled(s: Status): boolean` — `isTerminal(s) || s === 'reported'`, экспорт из `model/project.ts`. `Doing` получает вид `{ kind: 'reported_to_parent' }`.
- Consumes: `doingOf`, `deriveStatus`, `StatusContext` — как есть.

Правила вывода (из решений дизайна):
- часть, выделенная исполнителем (`assigned` с `actor: 'worker'`), чей запуск закончился итогом (`reported` после последнего `run_started`, `run_ended` `completed`), и без `closed`/`cancelled` → `'reported'`;
- родитель `done` → такая часть `done` (на любой глубине, потому что статусы выводятся сверху вниз);
- родитель `cancelled` или `abandoned` → `abandoned` (существующее правило);
- части, закрытые системным `closed` в старых журналах, остаются `done`.

- [ ] **Step 1: Тесты.** В таблицу `deriveStatus` (`status.test.ts`) добавить строки, используя `ctx(parentStatus)` и событие `assigned` с `actor: 'worker'`:
  - `['часть исполнителя доложила', …, ctx('running'), 'reported']`;
  - `['часть доложила, родитель закрыт', …, ctx('done'), 'done']`;
  - `['часть доложила, родитель отменён', …, ctx('cancelled'), 'abandoned']`;
  - `['часть закрыта системой в старом журнале', … + ev({ type: 'closed', actor: 'system', summary: 'ok' }), ctx('running'), 'done']`.
  В `split.test.ts` поправить ожидания: после итога части она `reported`, родитель продолжает работу; добавить тест «closing the parent finishes its reported parts, nested ones too»: разбиение на две части, одна из которых сама разбилась; после `supervisor.close` верхнего узла все узлы под ним `done`.
  В `event-store.test.ts` (описание `lead inbox`) строка: итог части исполнителя не попадает во входящие ведущего.
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/status.test.ts test/split.test.ts test/event-store.test.ts`. Expected: новые строки падают.
- [ ] **Step 3: Модель.** `deriveStatus`: правило «доложено» и правило «родитель done» до проверки `abandoned`. `isSettled` экспортировать. `doingOf` для `'reported'` → `{ kind: 'reported_to_parent' }`. `availableActions` для `'reported'` → `['discuss']`.
- [ ] **Step 4: Супервизор.** Убрать запись системного `closed` для частей исполнителя (`if (outcome.kind === 'report' && workerOwned) …`). В `resumeAfterSplit` и в подсчёте `{ kind: 'children', done, total }` (`model/project.ts`) считать готовыми узлы с `isSettled`. Провал запуска части по-прежнему отменяет её с кодом `run_failed`.
- [ ] **Step 5: Входящие.** `isLeadEvent(e, workerOwned: ReadonlySet<string>)`: `reported` от части исполнителя — не событие ведущего. `pending()` строит множество частей исполнителя по событиям `assigned` с `actor: 'worker'` каждой цели.
- [ ] **Step 6: Экран.** Словари: `status.reported` — «Доложено» / «Reported»; `doing` для `reported_to_parent` — «Доложено, проверит родитель» / «Reported; the parent checks it». Сводка (`summary.tsx`, `countTree`) считает `'reported'` вместе с «идёт» (`running`); дерево не сворачивает такие узлы в «Завершено». Значок статуса — как у `waiting_answer`, без акцента.
- [ ] **Step 7:** `pnpm --filter crewboard test`. Expected: всё зелёное.
- [ ] **Step 8: Документация.** Строка «Доложено» / «Reported» в таблице статусов `docs/{en,ru}/screen.md`; в `docs/{en,ru}/workers.md` абзац о разбиении: части не закрываются сами, а ждут, пока ведущий закроет родителя.
- [ ] **Step 9: Commit** `feat: show split-off parts as reported until the lead closes their parent`.

### Task 3: Входящие ведущего хотя бы один раз

**Files:**
- Modify: `packages/crewboard/src/store/inbox.ts` (`take`, `unseen`, `release`)
- Modify: `packages/crewboard/src/lead/commands.ts` (`inbox`, новый `releaseSession`)
- Modify: `packages/crewboard/src/lead/mcp.ts` (идентификатор сессии на сервер, освобождение при закрытии, текст `LEAD_INSTRUCTIONS` шаг 2)
- Modify: `packages/crewboard/src/app.ts` (`waitPending` считает `unseen`)
- Modify: `docs/{en,ru}/lead.md` (как работает inbox)
- Test: `packages/crewboard/test/event-store.test.ts`, `packages/crewboard/test/lead-flow.test.ts`

**Interfaces:**
- Produces в `createInbox(store)`:
  - `take(session: string): Promise<GoalEvent[]>` — подтверждает (пишет в `inbox.json`) всё, что было выдано этой сессии прошлым вызовом, затем возвращает все неподтверждённые события ведущего и запоминает их как выданные этой сессии;
  - `unseen(): Promise<GoalEvent[]>` — неподтверждённые события, не выданные ни одной живой сессии;
  - `release(session: string): void` — забыть выданное сессии (без подтверждения).
  Выданное хранится в памяти процесса: перезапуск сервера = всё неподтверждённое выдаётся снова. `pending()` и `ack()` остаются.
- Produces в `LeadCommands`: `inbox(i: { project: string }, session: string): Promise<GoalEvent[]>`, `releaseSession(session: string): void` (освобождает сессию во всех проектах, где она брала события).
- Consumes: `createLeadMcp(commands)` уже вызывается один раз на MCP-сессию (`server.ts`): там создаётся `session = randomUUID()`, `server.server.onclose = () => commands.releaseSession(session)`.

- [ ] **Step 1: Тесты.** В `event-store.test.ts`, описание `lead inbox`, таблица:

```ts
it.each([
  ['the same session does not get a batch twice', async (i) => { await i.take('s1'); return (await i.take('s1')).length }, 0],
  ['a new session gets what the old one never confirmed', async (i) => { await i.take('s1'); i.release('s1'); return (await i.take('s2')).length }, 1],
  ['what is handed out is not unseen', async (i) => { await i.take('s1'); return (await i.unseen()).length }, 0],
])('%s', async (_n, act, expected) => { /* журнал с одним вопросом */ expect(await act(inbox)).toBe(expected) })
```

В `lead-flow.test.ts` тест «a lead that drops out gets its events again»: исполнитель задаёт вопрос; первая MCP-сессия вызывает `crewboard_inbox` и видит вопрос; клиент закрывается; вторая сессия (новый `Client` к тому же серверу) вызывает `crewboard_inbox` и снова видит вопрос.
- [ ] **Step 2:** `pnpm --filter crewboard vitest run test/event-store.test.ts test/lead-flow.test.ts`. Expected: FAIL (`take` не определён, вторая сессия получает пусто).
- [ ] **Step 3: Реализация** по интерфейсам выше. `commands.inbox` также касается `touchLead` для целей выданных событий, как сейчас. `waitPending` считает `(await ctx.inbox.unseen()).length`. `LEAD_INSTRUCTIONS`, шаг 2: «crewboard_inbox returns every event you have not confirmed; calling it again confirms the previous batch. Act on every event before the next call.»
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: всё зелёное, включая старый `lead inbox` тест на `pending/ack`.
- [ ] **Step 5: Документация.** `docs/{en,ru}/lead.md`: события остаются во входящих, пока ведущий не вызовет `crewboard_inbox` снова; оборвавшийся ведущий получит их заново.
- [ ] **Step 6: Commit** `fix: keep the lead's inbox events until the lead confirms them`.

### Task 4: Claude-исполнитель с настройками и входом пользователя

**Files:**
- Modify: `packages/core/src/runs/cli-runner.ts` (`CliRunnerArgs.claudeAuth`, `driveClaude`, проверка при старте)
- Modify: `packages/core/src/runs/cli-backend.ts` (опция `claudeAuth`, `launch`, `assertGuardedSteer`)
- Modify: `packages/core/src/orchestration/backends.ts` (чтение `CREWBOARD_CLAUDE_AUTH`)
- Modify: `docs/{en,ru}/workers.md`, `docs/{en,ru}/getting-started.md` (шаг 4), `docs/{en,ru}/troubleshooting.md` (раздел про `anthropic_api_key_missing`), `SECURITY.md`, `CHANGELOG.md`
- Test: `packages/core/test/cli-runner.test.ts`

**Interfaces:**
- Produces: `type ClaudeAuth = 'native' | 'isolated'`, экспорт из `core/src/runs/cli-runner.ts` и `core/src/index.ts`. `CliRunnerArgs.claudeAuth?: ClaudeAuth` (отсутствие = `'native'`), записывается в `args.json`. `createCliBackend({ …, claudeAuth?: ClaudeAuth })`. `createBackends` берёт режим из `CREWBOARD_CLAUDE_AUTH` (`isolated` → `'isolated'`, иначе `'native'`).
- Поведение:
  - `native`: `claude` запускается без `--bare`, без `assertAnthropicLaunchAllowed` и без отказа `classifyAnthropicRoute` для бэкенда `claude-code`; Claude Code сам выбирает вход (подписка или ключ). Продолжение такого запуска (`steer`) разрешено: `assertGuardedSteer` пропускает записи с `claudeAuth: 'native'`.
  - `isolated`: ровно прежнее поведение — `--bare`, политика `anthropic-api-only-2026-09-28`, все её коды отказа.
  - Отказ для Anthropic-модели на чужом harness (dsh, opencode) не меняется.

- [ ] **Step 1: Тесты** в `cli-runner.test.ts`, с существующим фейковым `claude`:
  - таблица `it.each` по режиму: `['native', env без ANTHROPIC_API_KEY, запускается, argv без '--bare']`, `['isolated', env без ключа, отказ anthropic_api_key_missing, процесс не стартует]`;
  - тест «steers a native Claude run»: запуск в `native`, `backend.steer` не бросает `anthropic_unverified_run`.
  Существующие тесты политики (отказы по `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` и т. д.) явно получают `claudeAuth: 'isolated'` / `CREWBOARD_CLAUDE_AUTH=isolated`, их ожидания не меняются.
- [ ] **Step 2:** `pnpm --filter @crewboard/core vitest run test/cli-runner.test.ts`. Expected: строка `native` и тест steer падают.
- [ ] **Step 3: Реализация** по интерфейсам. Комментарии у `--bare` и в `anthropic-policy.ts` уточнить: политика — режим `isolated`, по умолчанию пользователь запускает Claude Code со своим входом. Crewboard по-прежнему не трогает учётные данные: никакого чтения токенов, только запуск бинарника.
- [ ] **Step 4:** `pnpm --filter @crewboard/core test && pnpm --filter crewboard test`. Expected: всё зелёное.
- [ ] **Step 5: Документация.** `workers.md`: Claude работает с вашими настройками и вашим входом в Claude Code (подписка или ключ); `CREWBOARD_CLAUDE_AUTH=isolated` — прежний изолированный режим только по `ANTHROPIC_API_KEY`; предупреждение про «обычное индивидуальное использование» с датой проверки 2026-11-02 и ссылками на статью поддержки 15036540 и страницу Legal and compliance. `getting-started.md` шаг 4: Claude готов, если вы вошли в Claude Code. `troubleshooting.md`: раздел про `anthropic_api_key_missing` относится к режиму `isolated`. `SECURITY.md`: строка про ключ заменяется на «Crewboard never reads, stores or forwards Claude credentials; it runs the official Claude Code binary as you.» `CHANGELOG.md`: раздел `## [Unreleased]` с пунктами всех четырёх задач.
- [ ] **Step 6:** `pnpm lint && pnpm release:check`. Expected: зелёные.
- [ ] **Step 7: Commit** `feat: run Claude workers with the user's own settings and sign-in`.

## Финал

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
- [ ] Ручная проверка на демо (`scripts/seed-demo.mjs`): аварийная остановка видна при ведущем на связи; часть со статусом «Доложено» видна в дереве.
- [ ] Финальное ревью ветки свежим ревьюером.

## Решения плана (вне дизайна)

- Показ канала оплаты Claude (подписка или ключ) на экране и в аналитике переносится в часть 2 вместе с учётом затрат по любому агенту: сейчас Claude Code не сообщает канал в событиях, которые читает core, и это требует отдельного исследования формата.
- Флаги дизайна «изоляция» и «только API-ключ» в этой части — один переключатель `CREWBOARD_CLAUDE_AUTH=isolated`: `--bare` и так не умеет вход по подписке. В части 2 реестр может разделить их.
- «Доложено» в сводке считается вместе с «идёт»: работа по этой ветке ещё не принята.
