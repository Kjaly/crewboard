# Crewboard 4: релиз — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Репозиторий содержит только новый Crewboard: один пакет `crewboard` версии 1.0.0, который ставится из исходников одной командой, с документацией на английском и русском, свежими скриншотами и видео.

**Architecture:** Сначала механическая чистка без изменения поведения: core сокращается до 43 файлов, которые реально нужны приложению и его файлам запуска воркеров, а пакеты `cli` и `plugin` удаляются вместе со всем, что на них ссылается. Затем переименование: `packages/app` становится пакетом `crewboard` с командой `crewboard`. Документация пишется заново. Скриншоты и видео снимаются с живого приложения на демо-данных, которые засевает отдельный скрипт.

**Tech Stack:** как раньше, плюс Playwright (уже закэшированный Chromium) и ffmpeg для видео.

**Spec:** `docs/superpowers/specs/2026-11-02-crewboard-lead-chat-design.md`, раздел «Критерии релиза».

## Дорожная карта

| План | Статус |
| --- | --- |
| 1, 2a, 2b, 3 | влиты (последний 94092fb) |
| **4. Релиз (этот)** | |

## Global Constraints

- Всё из Global Constraints предыдущих планов остаётся в силе.
- Задачи 1 и 2 — механическая чистка: поведение приложения не меняется, все тесты `packages/app` остаются зелёными после каждой.
- Локальные данные пользователя (`.orchestration/` в репозиториях, `~/.crewboard`) не трогаются. Чистка касается только отслеживаемых git файлов.
- Публикация в npm, `git push` и создание GitHub-релиза в этот план не входят: это действия наружу, их владелец делает или подтверждает отдельно.
- Документация: английский текст основной, русский читается естественно, а не дословно. У каждого руководства в `docs/en/` есть пара в `docs/ru/`. Каждая команда и флаг из документации существуют в собранном `crewboard`.
- Скриншоты и видео только с живого приложения на демо-данных, без локальных путей, имён аккаунтов и токенов.

## Review Focus

1. **Чистая машина.** `git clone`, `pnpm install --frozen-lockfile`, `pnpm build`, `node packages/crewboard/dist/main.js serve` работают без старых пакетов и без dsh. Проверка в Task 6 на временной копии репозитория.
2. **Ссылки в документации на удалённое.** Нет упоминаний `dsh-crewboard`, `orch`, `crewboard accept`, плагина и старых экранов. `scripts/check-docs.mjs` проверяет относительные ссылки и пары en/ru, плюс поиск по запрещённым словам в Task 4.
3. **Сборка релиза.** Архив пакета содержит `dist/main.js`, `dist/ui/*`, файлы запуска воркеров, `README.md`, `LICENSE` и не содержит `src`, `test`, `.crewboard`. Проверка `pnpm release:check` в Task 3.
4. **Команда ожидания в инструкциях ведущего.** MCP-инструкции и экран называют `crewboard wait`, а не `crewboard-app wait`. Тест в Task 3.
5. **Удалённый модуль core, нужный файлу запуска воркера.** Сборка запускает настоящий `cli-runner-main.js` с фейковым CLI в тестах core, которые остаются. Тест в Task 1.

---

### Task 1: Сократить core до нужного

**Files:**
- Delete: 70 файлов `packages/core/src/**` вне замыкания (список строится командой в Step 1) и тесты `packages/core/test/**`, которые импортируют удалённые модули.
- Modify: `packages/core/src/index.ts` (экспорт только оставшегося), `packages/core/package.json` (описание).

- [ ] **Step 1: Построить замыкание.** Временная точка входа с прямыми импортами того, что берёт приложение (`createBackends`, `nodeExec`, `normalize`, `publicText`, `cliModel`, `usageForRun`, `claudeProjectsDir`, `claudeProjectSlug`, типы) и двух файлов запуска (`dsh/runner-main.ts`, `runs/cli-runner-main.ts`). Сборка esbuild с `metafile` даёт 43 файла. Остальные удалить.
- [ ] **Step 2: Удалить тесты core, которые импортируют удалённое.** Оставшиеся тесты (в том числе `cli-runner.test.ts`, `dsh-runner.test.ts`, `cli-parse.test.ts`, `normalize`, `anthropic-policy.test.ts`, `codex-pricing.test.ts`, `claude-transcripts.test.ts`) должны пройти.
- [ ] **Step 3: Проверка.** Run: `pnpm --filter @crewboard/core typecheck && pnpm --filter @crewboard/core test && pnpm --filter @crewboard/app test` Expected: всё зелёное.
- [ ] **Step 4: Commit** `refactor: reduce core to what the app runs`.

---

### Task 2: Удалить старый CLI и плагин

**Files:**
- Delete: `packages/cli/`, `packages/plugin/`, `packages/porch/` (если не используется), `scripts/lint-i18n.mjs`, `scripts/bench-first-load.mjs`, `tools/model-pilot/` (если импортирует удалённое), старые `.github/workflows/*` шаги для плагина.
- Modify: корневой `package.json` (скрипты `lint:i18n` и `release:check` под новый пакет), `.github/workflows/ci.yml` и `release.yml`.

- [ ] **Step 1: Удалить пакеты и скрипты.** Перед удалением `tools/model-pilot` и `packages/porch` проверить поиском, что их ничто не импортирует.
- [ ] **Step 2: Обновить CI.** Шаги: install, build, typecheck, test, lint, release:check.
- [ ] **Step 3: Проверка.** Run: `pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm lint` Expected: зелёное, тестов только у `app` и `core`.
- [ ] **Step 4: Commit** `refactor: remove the dsh plugin and the old CLI`.

---

### Task 3: Пакет `crewboard` 1.0.0

**Files:**
- Move: `packages/app` → `packages/crewboard`.
- Modify: `package.json` пакета (`"name": "crewboard"`, `"version": "1.0.0"`, `"private"` убрать, `bin: { "crewboard": "./dist/main.js" }`, `files: ["dist", "README.md", "LICENSE"]`, `publishConfig.access: public`, repository/homepage/bugs, keywords), `src/main.ts` (имя команды в справке), `src/lead/mcp.ts` (инструкции: `crewboard wait --project <path>`), `src/ui/text.ts` (команда подключения не меняется: `claude mcp add --transport http crewboard <origin>/mcp`), `scripts/release-check.mjs` (один пакет), `LICENSE` копия в пакет.
- Test: `packages/crewboard/test/lead-flow.test.ts` (строка про инструкции).

- [ ] **Step 1: Падающий тест.** Клиент MCP после `connect` получает `instructions` сервера. Они содержат `crewboard wait --project` и не содержат `crewboard-app`.
- [ ] **Step 2: Запустить.** Expected: FAIL.
- [ ] **Step 3: Реализовать переименование.** Обновить все упоминания `@crewboard/app` и `crewboard-app` в коде, тестах и `.claude/launch.json` (локальный, не в git).
- [ ] **Step 4: `release:check`.** Скрипт делает `pnpm pack` в временную папку и проверяет состав архива: есть `package/dist/main.js`, `package/dist/cli-runner-main.js`, `package/dist/runner-main.js`, `package/dist/ui/index.html`, `package/dist/ui/app.js`, `package/dist/ui/styles.css`, `package/README.md`, `package/LICENSE`. Нет `package/src/`, `package/test/`. Бин `crewboard` указывает на существующий файл с шебангом. Run: `pnpm release:check` Expected: «release check: ok».
- [ ] **Step 5: Полный прогон и commit** `feat: ship the new Crewboard as crewboard 1.0.0`.

---

### Task 4: Документация на двух языках

**Files:**
- Rewrite: `README.md`, `README.ru.md`, `docs/README.md`, `docs/architecture.md`, `CONTRIBUTING.md`, `SECURITY.md` (локальный сервер без авторизации), `CHANGELOG.md` (запись 1.0.0 сверху, старые записи остаются ниже под заголовком «До 1.0»).
- Replace: `docs/en/*` и `docs/ru/*` новым набором парных руководств:
  - `getting-started.md` — установка из исходников, запуск, подключение Claude Code, первая цель;
  - `lead.md` — как работает ведущий, инструменты MCP, цикл `crewboard wait`, вопросы и эскалации, просьбы владельца;
  - `workers.md` — Codex (`codex login`), Claude (`ANTHROPIC_API_KEY`, политика API-ключа), DeepSeek через dsh, модели по умолчанию, разбиение работы;
  - `screen.md` — «Сейчас», просьбы из дерева, аварийная остановка, «История», «Аналитика», горячие клавиши;
  - `costs.md` — деньги, оценка по ценам API, «нет данных»;
  - `troubleshooting.md` — нет транскрипта, ведущий «не на связи», отказ запуска, порт занят.
- Delete: старые руководства, `docs/audits/`, `docs/evals/`, `docs/context-envelope.md`, старые скриншоты в `docs/assets/`, которые больше не используются. `docs/notes/` и `docs/superpowers/` остаются как история решений.
- Modify: `scripts/check-docs.mjs` — добавить проверку запрещённых слов (`dsh-crewboard`, `orch `, `crewboard accept`, `Accept`, `Send back`, `plugin --profile`) в `README*.md` и `docs/{en,ru}/`.

- [ ] **Step 1: Написать руководства** по коду, а не по памяти: каждую команду и флаг проверить в `node packages/crewboard/dist/main.js --help` и вживую на временном репозитории.
- [ ] **Step 2: Проверка.** Run: `pnpm lint:docs` Expected: ссылки и пары en/ru в порядке, запрещённых слов нет.
- [ ] **Step 3: Commit** `docs: rewrite the documentation for the lead-chat Crewboard`.

---

### Task 5: Скриншоты и видео

**Files:**
- Create: `scripts/seed-demo.mjs` (засевает журнал демо-цели в временный git-репозиторий без запуска воркеров: цель «Кухня полного цикла», поручения Codex/Claude/DeepSeek во всех статусах, вопрос владельцу, отклонённая просьба, разбиение, затраты, транскрипт в формате Claude Code в отдельной папке `CREWBOARD_CLAUDE_PROJECTS`), `scripts/capture-media.mjs` (Playwright: снимки и видео).
- Create: `docs/assets/now.png`, `now-light.png`, `now-mobile.png`, `request.png`, `history.png`, `analytics.png`, `walkthrough.mp4`, `walkthrough.gif`.

- [ ] **Step 1: `seed-demo.mjs`.** Пишет события через `createEventStore` из собранного пакета, чтобы формат совпадал с настоящим. Печатает путь к репозиторию и переменные окружения для запуска сервера.
- [ ] **Step 2: `capture-media.mjs`.** Запускает `crewboard serve` на демо-данных, открывает Chromium (1440×900, тёмная тема; 1440×900 светлая; 390×844 телефон), делает снимки экранов из списка и записывает видео прохода: «Сейчас» → ответ на вопрос → просьба «Передать» → «История» → «Аналитика». ffmpeg превращает запись в `walkthrough.mp4` (H.264) и `walkthrough.gif` (не больше 4 МБ).
- [ ] **Step 3: Посмотреть каждый снимок глазами** и убедиться, что в кадре нет локальных путей и имён.
- [ ] **Step 4: Вставить медиа в README и руководства**, прогнать `pnpm lint:docs`.
- [ ] **Step 5: Commit** `docs: add screenshots and a walkthrough video`.

---

### Task 6: Проверка релиза на чистой копии

- [ ] **Step 1: Полный прогон** `pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm release:check`.
- [ ] **Step 2: Чистая копия.** `git clone` репозитория в временную папку, `pnpm install --frozen-lockfile`, `pnpm build`, `node packages/crewboard/dist/main.js serve --port 4799`, `curl /api/health`, открыть экран в браузере, подключить скриптом-ведущим и поставить цель с поручением Codex. Expected: всё работает, пустое состояние и дерево видны.
- [ ] **Step 3: Commit** правок, если были. Обновить `CHANGELOG.md` датой релиза.
