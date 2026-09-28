# dsh 0.1.5: каталог моделей dsh и что стоит за воркерами (research к задаче 2l/1)

Установленный dsh (далее `DSH`):
`/Users/kjaly/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`.
Версия пакета dsh — `0.1.5-rc.1`
(`/Users/kjaly/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/package.json`), подпакетов
session-controller — `0.1.5-rc.2` (`DSH/dsh-api-session-controller/package.json`). Плагины профиля
(далее `PROFILE`):
`~/.dsh/profiles/web/node_modules`. Наш форк porch (далее `PORCH`):
`packages/porch/skills/pragmatic-orchestration`. Наш репозиторий (далее `ORCH`) — корень этого worktree.

Правило заметки: **каждое утверждение подписано доказательством** — путь к файлу и строка, либо команда
и её строка. Где доказать не удалось — так и написано («не доказано»).

## Два источника воркеров — и это не одно и то же

| Семейство | Кто владеет входом/ключами | Откуда список моделей | Как выбирается модель при запуске | Где в нашем коде |
| --- | --- | --- | --- | --- |
| **DeepSeek через dsh** | сам dsh: Settings → Models, ключ через credential-стор/`DEEPSEEK_API_KEY` | `ctx.sessionController.modelCatalog()` (LLM-реестр dsh) | ACP-опция `model` = `JSON.stringify([provider, model])`; провайдер у нас зашит `deepseek-official` | `ORCH/packages/core/src/dsh/runner.ts:19,123-125` |
| **Claude** | CLI: `claude auth login`, подписка | у CLI **нет** команды каталога (см. Q3) | `claude --model <id>` | `ORCH/packages/core/src/runs/cli-runner.ts:81` |
| **Codex** | CLI: `codex login`, подписка/квота | `codex debug models [--bundled]` (см. Q3) | `codex exec -m <id>` | `ORCH/packages/core/src/runs/cli-runner.ts:148-151` |
| **Devin** | CLI: `devin auth login` | `devin models list` (см. Q3) | модель лежит в профиле porch; porch передаёт её CLI (`--model`), у нас своего `devin/...` бэкенда нет | `PORCH/scripts/lib/backend_run.sh:178-180,509`; `ORCH/packages/core/src/backend/types.ts:42-44` |
| **Профили porch** | porch: `~/.config/porch/config.json`; вход — у каждого CLI свой | `porch --list-agents` (XML, локально) | `agents[id].model`; env `*_MODEL` перекрывает на один вызов | `ORCH/packages/core/src/preflight/preflight.ts:18-23`; `PORCH/scripts/lib/config.sh:126-169` |

Сегодняшний список воркеров в настройках склеен из двух частей: жёсткий `DIRECT_WORKERS`/`DIRECT_LABEL`
(`ORCH/packages/plugin/src/host/actions.ts:135-159`) и профили porch (`actions.ts:206-244`, маршрут
`GET /api/workers` — `actions.ts:352-363`). Задача 2l заменяет первую часть реестром.

---

## Q1. `ctx.sessionController.modelCatalog()`: форма, доступность, цена

### Форма ответа

`DSH/dsh-api-session-controller/lib/types/types.d.ts`:

- `ModelSelection` = `{ provider: string; model: string; reasoningEffort?: string }` (строки 76-81).
- `ModelCatalogModel` = `{ id; name; description?; reasoning? }` (строки 107-113).
- `ModelReasoning` = `{ efforts: ModelReasoningEffort[]; defaultEffort?: string }` (строки 96-106);
  `ModelReasoningEffort` = `{ id; name; description? }` (строки 96-101).
- `ModelProviderGroup` = `{ id; name; models }` (строки 114-119).
- `ModelCatalogFailure` = `{ id; name; message }` (строки 120-125).
- `ModelCatalog` = `{ default: ModelSelection; routableProviders: readonly string[];
  groups: readonly ModelProviderGroup[]; failures: readonly ModelCatalogFailure[] }` (строки 126-133).

Сигнатура — `SessionController.modelCatalog(): Promise<ModelCatalog>`
(`DSH/dsh-api-session-controller/lib/types/index.d.ts:93-97`), сервис объявлен как
`ctx.sessionController` (`index.d.ts:14-19`).

Реализация: `modelCatalog() { return buildModelCatalog(this.ctx) }`
(`DSH/dsh-api-session-controller/lib/index.js:2857-2859`; то же тело в
`lib/types/catalog.js:8-57` и `lib/index.js:1988-2035`). Поведение:

- `providers = ctx.llm.listProviders()` (catalog.js:9); для каждого — `listModels` + `resolveModelInfo`
  (catalog.js:10-38); исключение одного провайдера не роняет каталог, а попадает в `failures`
  (catalog.js:39-48).
- `groups` содержат **только непустые** каталоги: `.filter(group => group.models.length > 0)`
  (catalog.js:53-54). При этом `routableProviders` — все маршруты, включая пустые
  (комментарий `types.d.ts:129-130`).
- `default` — `ctx.agentDefaultModel.currentSelection()` (catalog.js:8). В этой установке это
  `deepseek-official / deepseek-flash / high` (`~/.dsh/settings.yaml:8-11`).
- Метод помечен `@Remote("modelCatalog")` (`DSH/.../lib/index.js:2483-2503,2559-2566`), то есть тот же
  вызов доступен и как Remote для клиента; на хосте это прямой вызов.

### Когда доступен хосту

- `modelCatalog()` **не требует сессии**: «Build the browser model catalog without requiring a Session»
  (`DSH/dsh-api-session-controller/lib/types/catalog.d.ts:4-5`). Нужен лишь смонтированный LLM-реестр.
- В web-профиле session-controller смонтирован: `- id: session-controller /
  name: '@deepseek-ai/dsh-api-session-controller'` (`DSH/dsh-web-app/cordis.patch.yml:104-106`).
- Наш плагин уже держит сервис необязательным: `HostContext.sessionController?`
  (`ORCH/packages/plugin/src/host/dsh.ts:29-36`), захватывает его через
  `ctx.inject(['sessionController'], ...)` (`ORCH/packages/plugin/src/host/index.ts:75-84`) и отдаёт в
  маршруты как `sessions: () => sessions` (`ORCH/packages/plugin/src/host/index.ts:101`). Текущий
  `SessionControllerFace` знает только `create/prompt/inspect` (`dsh.ts:22-26`) — задаче 2 надо добавить
  в него `modelCatalog()`.

### Сколько стоит вызов (ходит ли в сеть)

Сеть зависит от адаптера, но у двух адаптеров, которые монтирует dsh, её нет:

- `dsh-base` монтирует и `llm-deepseek`, и «спящий» `llm-pi-ai`
  (`DSH/dsh-base/cordis.patch.yml:87-108`); DeepSeek-адаптер регистрируется на маршрут
  `deepseek-official` (`DSH/dsh-llm-deepseek/lib/index.js:1840,2065-2071`).
- `DeepSeekAdapter.listModels` — синхронное чтение своей конфигурации:
  `Promise.resolve(this.config.options().models.map(...))` (`DSH/dsh-llm-deepseek/lib/index.js:1572-1574`);
  `resolveModel` — так же локально (строки 1575-1577). Список по умолчанию — `DEFAULT_MODELS`
  (строки 1841-1871: `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`,
  `deepseek-v4-flash-vision-exp`).
- `pi-ai`-адаптер тоже отвечает из снимка конфигурации: `snapshot.models.getModels(provider)`
  (`DSH/dsh-llm-pi-ai/lib/index.js:1784-1795`, `resolveModel` — 1796-1801).
- `LlmRuntime.listModels` лишь валидирует и отделяет метаданные
  (`DSH/dsh-llm/lib/index.js:2012-2033`), `ctx.agentDefaultModel.currentSelection()` синхронный
  (`DSH/dsh-agent-default-model/lib/types/index.d.ts:44-48`).

Но контракт адаптера — асинхронный и «advisory»: `LlmAdapter.listModels(_provider): Promise<...>`
(`DSH/dsh-llm/lib/types/index.d.ts:149-156`), то есть будущий адаптер вправе сходить в сеть. Вывод:
**сегодня `modelCatalog()` локальный и дешёвый; вызывать его можно при открытии настроек, а не только по
кнопке.** Кнопки/деньги нужны для проверки *доступа* (Q3), а не каталога.

Важное следствие: `buildModelCatalog` **не проверяет ключ**. Он не вызывает `resolveApiKey`; ключ
резолвится только при стриме (`resolveApiKey` — `DSH/dsh-llm-deepseek/lib/index.js:2038-2049`). Значит,
модель в `groups` ≠ «доступна»: отсутствие ключа всплывёт только на запуске. Это надо честно писать в
настройках («каталог», а не «доступ»).

Что именно пишет Settings → Models: это отдельная страница `dsh-client-ui-settings-models`, она сводит
зарегистрированные и объявленные маршруты (`ctx.remote.llm.listProviders()` +
`listConfigurableProviders()`, `DSH/dsh-client-ui-settings-models/lib/client.js:991-993`) и пишет
пользовательский документ `$DSH_HOME/settings.yaml` (`DSH/dsh-base/cordis.patch.yml:87-91`). В этой
установке в `settings.yaml` уже есть `llm-pi-ai.providers.deepseek.apiKeyEnv: DEEPSEEK_API_KEY`
(`~/.dsh/settings.yaml:4-7`), поэтому pi-ai-маршрут тоже может появиться в `groups`.

---

## Q2. `selectModel` и как dsh-воркер получает модель

### Точная форма `selectModel`

- `SessionSelectModelRequest extends ModelSelection { readonly sessionId: SessionId }` —
  `DSH/dsh-api-session-controller/lib/types/types.d.ts:264-267`; то есть
  `{ sessionId, provider, model, reasoningEffort? }`.
- `SessionSelectModelValue = { readonly selected: ModelSelection }` —
  `types.d.ts:268-271`.
- Сигнатура `selectModel(request): Promise<SessionSelectModelValue>` —
  `index.d.ts:87-92`.

Реализация (`DSH/dsh-api-session-controller/lib/index.js:605-634`): сначала
`resolveAgent(sessionId)` (**сессия обязательна**), затем `ctx.llm.resolveCallConfig({provider, model,
reasoningEffort?})` (строки 609-613), затем `selectForNextRequest(agent, selected)` (строка 619) и
`agentDefaultModel.saveSelection(selected)` (строка 621). Ошибка маршрута заворачивается в
`session/model-unavailable` (строки 626-632).

### Наш dsh-воркер идёт другим путём

Наш `dsh/<...>`-воркер **не** использует `selectModel` и не создаёт сессию session-controller: он
запускает отдельный процесс `dsh --profile acp` и говорит с ним по ACP
(`ORCH/packages/core/src/dsh/runner.ts:96` — `AcpConnection.spawn`; команда по умолчанию —
`{ command: 'dsh', args: ['--profile', 'acp'] }`, `runner.ts:18`). Модель берётся из id:
`dshModel(agent) = agent.slice(4)` (`ORCH/packages/core/src/backend/types.ts:39-40`), кладётся в
`RunnerArgs.model` (`ORCH/packages/core/src/dsh/backend.ts:54-62`) и уходит в ACP так:

`session/set_config_option` с `{ sessionId, configId: 'model', value: JSON.stringify([PROVIDER, model]) }`
и `PROVIDER = 'deepseek-official'` (`ORCH/packages/core/src/dsh/runner.ts:19,123-125`).

На стороне dsh это ровно «значение селекта»: `MODEL_CONFIG_ID = 'model'` и
`modelValue(provider, model) = JSON.stringify([provider, model])`
(`DSH/dsh-acp/lib/index.js:305,524-527`); `set()` берёт выбор из `choices.get(value)`
(строки 388-397), а `choices` строятся из `llm.listProviders()` + `llm.listModels()`
(строки 434-492). Значение обязано быть строкой (строка 390).

**Что из `ModelSelection` наш бэкенд может задать при запуске:**

- `provider` — сейчас фактически нельзя: константа `deepseek-official` зашита в `runner.ts:19`.
  Каталог же может содержать и pi-ai-маршруты (Q1). Если владелец захочет воркер на pi-ai-модели,
  одного `model` в записи реестра не хватит — нужен ещё провайдер (см. журнал, отклонение 1).
- `model` — задаётся (через `dsh/<model>` сегодня; в задаче 2 — из поля реестра).
- `reasoningEffort` — не задаётся. В ACP есть отдельная опция `reasoning_effort`
  (`DSH/dsh-acp/lib/index.js:306,398-407`), но наш runner её не шлёт, а `AcpConfig` процесса содержит
  только `provider`/`model` (`DSH/dsh-acp/lib/types/index.d.ts:18-26`).

Значение по умолчанию у ACP-процесса — `provider: deepseek-official`, `model: deepseek-v4-flash`
(`DSH/dsh-acp-app/cordis.patch.yml:16-21`). Провайдер `deepseek-official` в этом процессе есть, потому
что `dsh-base` монтирует `llm-deepseek` (`DSH/dsh-base/cordis.patch.yml:486-487`).

Сверка с сегодняшним кодом `ORCH/packages/core/src/runs/*`: cli-runner — это Claude/Codex; dsh-воркера
там нет. Модель dsh-воркера целиком определяется `runner.ts` (ACP), а не `runs/*`. Резолв профиля для
проверок — `resolveProfile`: `dsh/<m>` → `{ backend: 'dsh', model: m }`; `claude/<m>` → `claude-code`;
`codex/<m>` → `codex-cli` (`ORCH/packages/core/src/orchestration/backends.ts:67-70`).

---

## Q3. Что реально принимают CLI и где взять список моделей

Наши вызовы сегодня:

- Claude: `spawn(args.command, [...commandArgs, '-p', '--output-format', 'stream-json',
  '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
  ...(model ? ['--model', model] : [])])` (`ORCH/packages/core/src/runs/cli-runner.ts:78-83`).
- Codex: `...['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', ...(model ? ['-m', model] : []), next]`
  (первый ход) и `'exec', 'resume', ... {model}` (последующие) — `cli-runner.ts:139-152`.
- Devin напрямую не поддерживается: `cliKindOf` знает только `claude`/`codex`
  (`ORCH/packages/core/src/backend/types.ts:42-44`), поэтому `devin` идёт через porch.

Установленные CLI (проверено на этой машине):

| CLI | Путь | Версия | Флаг модели | Каталог |
| --- | --- | --- | --- | --- |
| claude | `/Users/kjaly/.local/bin/claude` | `2.1.216 (Claude Code)` | `--model <model>` — алиас (`'fable'`, `'opus'`, `'sonnet'`) или полное имя (`'claude-fable-5'`) | команды каталога **нет** |
| codex | `/opt/homebrew/bin/codex` | `codex-cli 0.155.1` | `-m, --model <MODEL>` | `codex debug models [--bundled]` |
| devin | `/opt/homebrew/bin/devin` | `devin 3000.11.1` | `--model <MODEL>` (env `DEVIN_MODEL`) | `devin models list [--format json]` |

Доказательства — вывод `--help` соответствующих бинарей (команды воспроизводимы):

- `claude --help`, строки 115-119: `--model <model>  Model for the current session...`.
  В списке `Commands:` (`claude --help`) нет ни `models`, ни команды листинга; поиск по всему выводу
  `claude --help` по слову `models` ничего не находит. Значит — **свободный ввод + проверка запуском**.
- `codex exec --help`, строки 41-42: `-m, --model <MODEL>  Model the agent should use`.
- `codex debug --help`: подкоманда `models  Render the raw model catalog as JSON`;
  `codex debug models --help`: флаг `--bundled  Skip refresh and dump only the bundled catalog shipped
  with this binary`. То есть `--bundled` — офлайн-вариант, без флага команда может обновлять каталог.
  Фактический офлайн-вывод `codex debug models --bundled`: 9 id — `gpt-6-astra`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.5`,
  `gpt-5.4`, `codex-auto-review`. **`gpt-6-sol` и `gpt-6-luna` в bundled-каталоге отсутствуют**, хотя
  сегодня они есть в `DIRECT_WORKERS` (`ORCH/packages/plugin/src/host/actions.ts:140,142`). Проверить,
  принимает ли их обновлённый (сетевой) каталог, без запуска не удалось — «не доказано» (см. ниже).
- `devin --help`, строки 7-8: подкоманда `models  List the models available to your account`;
  строки 66-71: `--model <MODEL> ... (e.g. "claude-sonnet-4", "claude-opus-4.6", "opus", "codex")`,
  env `DEVIN_MODEL`. `devin models list --help`, строки 5-13: `--format <FORMAT>` со значениями
  `text`/`json`.

Для нашей разведки важно: у Claude каталога нет вовсе; у Codex есть офлайн `--bundled` и, вероятно,
сетевой refresh; у Devin есть сетевой `models list`. Это ровно ложится в правило плана «проверка доступа
только по явной кнопке»: каталог Codex можно показать бесплатно (`--bundled`), а «ок/ошибка» — отдельным
пробным запуском.

Примечание: `devin auth status` под нашей песочницей падает с `PermissionDenied` на создание
лог-файла (`initializing rolling file appender failed`); проверка входа в нашем `preflightAgent` и так
разбирает текст `devin auth status` (`ORCH/packages/core/src/preflight/preflight.ts:63-66`), а не JSON.

---

## Q4. Устройство профилей porch и смысл `enabled`

Конфиг — `PORCH_CONFIG` или `~/.config/porch/config.json`
(`ORCH/packages/core/src/routing/routing.ts:26`; `ORCH/packages/core/src/porch/locate.ts:44-47`).
Форма: `agents[id] = { backend, model, enabled, label, ... }`. Документация porch перечисляет поля:
`enabled`, `backend`, `model`, `role`, `effort`, `label`, `review_instructions`, `supports_delegate`
(`PORCH/references/configuration.md:16-25`).

Читаем мы: `loadPorchProfiles` берёт `backend`, `model` и `enabled ?? false`; `label` там теряется и
дочитывается отдельно (`ORCH/packages/core/src/preflight/preflight.ts:18-23`;
`ORCH/packages/plugin/src/host/actions.ts:187-199`). `enabled` **не** значит «установлен»:

- В документации porch: «`enabled` — Default participation in `review ask` and the basic review pool»
  (`PORCH/references/configuration.md:18`).
- В коде porch `config_is_enabled` — это просто чтение булева поля
  (`PORCH/scripts/lib/config.sh:103-114`), а «установленность» бинаря — отдельное поле
  `backend-available`, считаемое через `shutil.which` (`config.sh:140-169`).
- Живая проверка нашим форком: `PORCH_CONFIG=~/.config/porch/config.json bash
  PORCH/scripts/porch --list-agents` печатает XML, где `enabled` и `backend-available` независимы.
  Примеры из вывода: `codex` → `enabled="true" backend-available="true"`; `gemini-cli` →
  `enabled="false" backend-available="false"`; `opencode` → `enabled="false" backend-available="true"`.

Следствие для 2l: профили porch — единственный источник для `devin`, `gemini-cli`, `opencode`,
`grok-build`; `enabled` нельзя показывать как «включён воркер» — это «участвует в пуле ревью porch».
«Установлен/вошёл» для чужих CLI проверяется отдельно, нашими `preflightAgent`-проверками
(`preflight.ts:29-68`).

---

## Q5. Есть ли готовый компонент выбора модели, который можно переиспользовать

Коротко: **готового переиспользуемого виджета нет; список рисуем свой**. Есть два разных места dsh:

1. `dsh-client-ui-model-selection` — «Model selection over the shared model catalog, Session projection,
   and session.selectModel» (`DSH/dsh-client-ui-model-selection/package.json`). Внутри есть компонент
   `ModelSelect` (`DSH/.../lib/types/client/ModelSelect.d.ts:9-11`), но:
   - он сидит в **одиночном session-scoped** слоте `conversation.input.model`
     (`DSH/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:230-235`;
     `.../model-selection/lib/types/client/slots.d.ts:1-6`);
   - его инжектируемое лицо — `{ available, directory, load, select }`, где `directory` — store
     конкретной сессии (`slots.d.ts:11-24`);
   - пакет — плагин (`package.json` `dsh.client`), а его публичные экспорты — `ModelDirectory`,
     `ModelDirectoryResolver`, `ModelSelectInjected`, `ModelKey`
     (`.../lib/types/client/index.d.ts:3-7`); сам `ModelSelect` наружу не экспортируется.
2. `dsh-client-ui-settings-models` — страница Settings → Models. Она отдаёт наружу только слоты-
   расширения `settings.models.provider-card` и `settings.models.footer`
   (`DSH/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts:20-45`) и типы store; это
   про ключи и провайдеров, а не готовый список моделей для выбора.

Каталог клиентская часть получает через Remote: `this.ctx.remote.session.modelCatalog()`
(`DSH/dsh-client-ui-model-selection/lib/client.js:46`). Значит, наш хост может отдать в свои настройки
тот же `ModelCatalog` (`{ groups, failures, default }`) своим маршрутом, а клиент нарисует простой
двухуровневый список (провайдер → модели) сам. Переиспользовать `ModelSelect` без зависимости от
`@deepseek-ai/*` нельзя — наш плагин намеренно не импортирует их ни в рантайме, ни по типам
(`ORCH/packages/plugin/src/host/dsh.ts:1-4`; тот же принцип в прошлой заметке — структура локальная).

---

## Чего доказать не удалось

- **Принимает ли Codex `gpt-6-sol`/`gpt-6-luna` и другие id вне bundled-каталога.** Проверено только,
  что их нет в `codex debug models --bundled`. Сетевой `codex debug models` и пробный запуск не
  выполнялись (это уже «проверка доступа», и она стоит времени). Что докажет: `codex debug models`
  (refresh) и/или один `codex exec -m <id>` с коротким промптом.
- **Точная цена `modelCatalog()` при нестандартных/будущих адаптерах.** Для смонтированных
  `llm-deepseek` и `llm-pi-ai` сеть не доказана как необходимая (код читает снимок конфигурации), но
  контракт `LlmAdapter.listModels` асинхронный и допускает сетевой адаптер. Что докажет: замер на
  конкретном наборе провайдеров или чтение нового адаптера.
- **Отдаёт ли `ctx.sessionController` сам плагин в web-профиле в рантайме.** Мы доказали монтирование
  в `dsh-web-app/cordis.patch.yml:104-106` и то, что наш хост захватывает сервис опционально; живого
  прогона `modelCatalog()` из нашего плагина не было.
- **Поведение `devin auth status`** под обычной оболочкой (без песочницы): у нас команда упала на
  создании лог-файла, JSON-разбор preflight не проверялся живьём.

## Итог для задачи 2 (что писать в реестр)

- `GET /api/workers` может отдавать `catalog` = `await deps.sessions?.()?.modelCatalog()` (или `null`,
  если сервиса нет) без цены и без сессии. Форма — `{ default, routableProviders, groups, failures }`.
- Запись `WorkerEntry` для `kind: 'dsh'` держит только `model`; провайдер `deepseek-official` зашит в
  `runner.ts`. Если в каталоге появятся pi-ai-маршруты, понадобится поле провайдера — иначе модель
  нельзя однозначно выбрать (отклонение 1 в журнале).
- Для `claude`/`codex` каталога у хоста нет; форма даёт свободный ввод + `POST /api/worker-check`
  поверх `preflightAgent` (`preflight.ts:25-111`). Для `codex` бесплатная подсказка — `codex debug
  models --bundled`.
- Для `porch` источник — `agents` из `~/.config/porch/config.json`; `enabled` показывать как «в пуле
  ревью», не как «установлен».
