# Crewboard: простой первый запуск — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Часть 4 дизайна «любой ведущий, любой исполнитель»: человек с установленным Claude Code или Codex запускает Crewboard одной командой, сразу видит, какие исполнители готовы, и подключает ведущего одной командой; занятый порт даёт понятную ошибку; пакет готов к публикации в npm и работает через `npx crewboard`.

**Architecture:** Новый модуль проверки окружения в crewboard проходит по реестру агентов и для каждого вызывает существующую предстартовую проверку core (`preflightAgent`): установлен ли CLI, версия, вход. Результат печатается командой `crewboard doctor`, коротко при `crewboard serve` и отдаётся экрану через `/api/doctor` для пустого экрана. Команда `crewboard connect <клиент>` сама выполняет `claude mcp add` / `codex mcp add` или печатает запись для dsh и адрес для прочих.

**Tech Stack:** Node 24, TypeScript, pnpm 11.5.2, vitest, Testing Library, React 18.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-any-lead-any-agent-design.md` (часть 4).

## Global Constraints

- Проверка окружения только читает: версии, справку, статус входа. Никаких учётных данных она не читает и не печатает.
- `crewboard connect` меняет настройки клиента ведущего только по явной команде пользователя и печатает, что именно выполнила.
- Публикация в npm в этот план не входит: это решение владельца при релизе. План доводит пакет до состояния, где публикация — одна команда.
- Каждый новый текст интерфейса — в обоих словарях; английские руководства — источник, русские — пара.
- Тесты: мало, про поведение; внешние команды — через внедрённую `exec` (фейк на границе).
- Коммиты — Conventional Commits без scope, с `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Порт занят: `crewboard serve` пишет одну понятную строку с выходом 1, без стека (тест в Task 1).
2. Ни одного CLI не установлено: `doctor` не падает, у каждого агента причина и подсказка, что поставить (строка в Task 2).
3. `connect claude`, когда `claude` не установлен: понятная ошибка, а не стек `ENOENT` (строка в Task 3).
4. Пакет из tarball без `node_modules` проекта: `crewboard --help` и `crewboard doctor` выполняются (Task 4, через `release-check`).
5. Проверка окружения висит на медленном CLI: у каждого вызова есть тайм-аут, `serve` не ждёт проверку, чтобы начать слушать порт (строка в Task 2).

---

### Task 1: Понятная ошибка занятого порта

**Files:**
- Modify: `packages/crewboard/src/server.ts` (`listen` отклоняет промис ошибкой сервера), `packages/crewboard/src/main.ts` (`serve` ловит `EADDRINUSE`)
- Test: `packages/crewboard/test/live.test.ts`

**Interfaces:**
- `listen(port)` отклоняется с ошибкой `{ code: 'EADDRINUSE' }`, если порт занят (сейчас ошибка `server.on('error')` не обработана и роняет процесс).
- `serve`: при `EADDRINUSE` печатает в stderr `crewboard: port <N> is in use — another Crewboard may be running (open http://127.0.0.1:<N>/), or start with --port <другой>` и выходит с кодом 1.

- [ ] **Step 1: Тест.** `live.test.ts`: «refuses a busy port with EADDRINUSE» — первое приложение слушает порт, второе `listen` на том же порту отклоняется с `code: 'EADDRINUSE'`.
- [ ] **Step 2:** запуск теста. Expected: FAIL (сейчас процесс получает необработанную ошибку).
- [ ] **Step 3: Реализация.**
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `fix: say plainly when the server port is in use`.

### Task 2: Проверка окружения

**Files:**
- Create: `packages/crewboard/src/doctor.ts`
- Modify: `packages/crewboard/src/main.ts` (команда `doctor`, короткая сводка после запуска `serve`), `packages/crewboard/src/server.ts` и `packages/crewboard/src/app.ts` (`GET /api/doctor`)
- Modify: `packages/crewboard/src/ui/api.ts`, `packages/crewboard/src/ui/components/empty-state.tsx`, `packages/crewboard/src/ui/i18n/{ru,en}.ts` (блок «Исполнители» на пустом экране)
- Test: `packages/crewboard/test/doctor.test.ts` (новый), `packages/crewboard/test/ui-now.test.tsx`

**Interfaces:**
- `type AgentReadiness = { id: string; label: string; ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> }`.
- `checkAgents(o: { agents: Agents; env: NodeJS.ProcessEnv; exec: Exec; lang?: 'en' | 'ru' }): Promise<AgentReadiness[]>` — для каждого включённого агента вызывает `preflightAgent` из core с профилем `{ id: coreId, backend, model, enabled: true }`; соответствие `run` → `backend`: `claude`→`claude-code`, `codex`→`codex-cli`, `dsh`→`dsh`, `opencode`→`opencode`, `cursor`→`cursor-agent`, `gemini`→`gemini-cli`, `grok`→`grok-build`, `devin`→`devin-cli`. Каждый вызов внешней команды — с тайм-аутом 10 с (через опции `exec`). Агенты проверяются параллельно.
- Вход Claude в режиме по умолчанию: если у установленного Claude Code есть `claude auth status` с машинным выводом (проверить `claude auth status --help` при реализации), проверка добавляет `signed-in` по коду выхода, не печатая вывод; если команды нет — записать решение в журнал выполнения и не проверять вход.
- `crewboard doctor`: таблица в терминале — агент, готов ли, первая непройденная проверка с подсказкой; выход 0, если готов хотя бы один агент, иначе 1.
- `crewboard serve`: после того как порт слушается, проверка запускается в фоне и печатает одну строку `workers ready: Codex, Claude · not ready: DeepSeek (dsh not found)`.
- `GET /api/doctor` → `AgentReadiness[]` (результат кэшируется на 60 с, чтобы экран не запускал CLI на каждый показ).
- Пустой экран: под командами подключения — список агентов с отметкой «готов» / «не готов» и подсказкой из первой непройденной проверки.

- [ ] **Step 1: Тесты.** `doctor.test.ts`, таблица с фейковой `exec`: `['all installed', …, все ok]`, `['nothing installed', exec отвечает ENOENT, каждый агент ok: false и у первой проверки есть fix]`, `['a slow CLI', exec не отвечает дольше тайм-аута, агент ok: false с причиной про тайм-аут, остальные проверены]`. `ui-now.test.tsx`: на пустом экране фейковый API отдаёт Codex готовым и DeepSeek неготовым с подсказкой — оба видны с отметками.
- [ ] **Step 2:** запуск тестов. Expected: FAIL.
- [ ] **Step 3: Реализация** по интерфейсам.
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: check which workers are ready at startup and on demand`.

### Task 3: Подключение ведущего одной командой

**Files:**
- Create: `packages/crewboard/src/connect.ts`
- Modify: `packages/crewboard/src/main.ts` (команда `connect`, справка)
- Test: `packages/crewboard/test/doctor.test.ts` (описание `connect`)

**Interfaces:**
- `connectLead(o: { client: 'claude' | 'codex' | 'dsh' | 'other'; url: string; exec: Exec }): Promise<{ ran?: string; print?: string; error?: string }>`:
  - `claude`: выполняет `claude mcp add --transport http crewboard <url>` и возвращает `ran` с текстом команды;
  - `codex`: выполняет `codex mcp add crewboard --url <url>`;
  - `dsh`: ничего не выполняет, возвращает `print` с записью профиля (как на пустом экране) и путь `~/.dsh/cordis.patch.yml`, куда её добавить;
  - `other`: возвращает `print` с адресом;
  - CLI не найден или команда упала — `error` с причиной и тем, что поставить; без стека.
- `crewboard connect <claude|codex|dsh|other> [--port N]`: печатает результат; выход 0 или 1.

- [ ] **Step 1: Тесты.** Таблица `connectLead` с фейковой `exec`: `claude` вызывает `claude` с аргументами `['mcp','add','--transport','http','crewboard','http://127.0.0.1:4700/mcp']`; `codex` — `['mcp','add','crewboard','--url',…]`; `dsh` ничего не вызывает и печатает `streamable-http`; `claude` при ENOENT — `error`, а не исключение.
- [ ] **Step 2:** запуск тестов. Expected: FAIL.
- [ ] **Step 3: Реализация.**
- [ ] **Step 4:** `pnpm --filter crewboard test`. Expected: зелёный.
- [ ] **Step 5: Commit** `feat: connect the lead with one crewboard command`.

### Task 4: Пакет для npx

**Files:**
- Modify: `scripts/release-check.mjs` (распаковать tarball во временную папку и выполнить `node package/dist/main.js --help` и `node package/dist/main.js doctor` с пустым `CREWBOARD_HOME`, без `node_modules` проекта; `doctor` может вернуть 1 — проверяется, что он отработал без исключения)
- Modify: `packages/crewboard/package.json` (`engines.node: ">=24"`, `description`, `keywords`, `repository`, `homepage`, `bugs`, `license`, если чего-то нет)
- Modify: `docs/releasing.md` (публикация одной командой и что проверить после неё: `npx crewboard@<версия> --help`)

**Interfaces:**
- `release-check` печатает `release check: ok (crewboard@<версия>, <N> files; --help and doctor ran from the tarball)`.

- [ ] **Step 1:** Расширить `release-check` и манифест.
- [ ] **Step 2:** `pnpm build && pnpm release:check`. Expected: строка с `--help and doctor ran from the tarball`.
- [ ] **Step 3: Commit** `build: check the packed crewboard runs on its own`.

### Task 5: Документация первого запуска

**Files:**
- Modify: `README.md`, `README.ru.md` (установка: «после публикации — `npx crewboard serve`; из исходников — как сейчас»; `crewboard doctor`; `crewboard connect claude`), `docs/{en,ru}/getting-started.md` (шаги 1, 3 и 4 — через `doctor` и `connect`), `docs/{en,ru}/troubleshooting.md` (порт занят; исполнитель не готов — смотрите `crewboard doctor`), `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1:** Тексты. Команда `npx crewboard` подаётся как доступная после публикации пакета, без обещания, что он уже в npm.
- [ ] **Step 2:** `pnpm lint && pnpm docs:build`. Expected: зелёные.
- [ ] **Step 3: Commit** `docs: first run with doctor and connect`.

## Финал

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
- [ ] Живая проверка на этой машине: `node packages/crewboard/dist/main.js doctor` показывает реальную готовность Claude, Codex и DeepSeek; второй `serve` на занятом порту даёт одну строку ошибки; `connect other` печатает адрес. `connect claude` и `connect codex` вживую не выполняются, чтобы не менять настройки владельца; они покрыты тестами с фейковой `exec`.
- [ ] Финальное ревью ветки свежим ревьюером.

## Решения плана (вне дизайна)

- Проверка окружения переиспользует предстартовую проверку core (`preflightAgent`), а не пишет свою: она уже знает версии, справку и вход каждого адаптера.
- `crewboard connect` для dsh только печатает запись профиля: у dsh нет команды добавления MCP-сервера, а править `cordis.patch.yml` за пользователя рискованно.
- В живой проверке `connect claude/codex` не запускаются на машине владельца: это изменило бы его настройки; поведение проверено тестами.
- Имя `crewboard` в npm на 2026-11-02 свободно (`npm view crewboard` → 404).
