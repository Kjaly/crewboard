# Аудит кодовой базы после первого дня

Дата: 2026-09-23. Аудит выполнен как задача 1 плана 2s.
Срез: `de0e4e2`. Исходное дерево чистое. Исходники не изменялись; временные стенды, фикстуры и измерители — в `/tmp/orch-s10-*`. Коммит не делался: условие задания «только заметка» приоритетнее чекбокса commit в плане. Волны 2–6 не выполнялись.

Приоритет означает цену для владельца: **P0** — потеря/искажение решения человека; **P1** — неработающий сценарий, скрытая рассинхронизация; **P2** — стоимость сопровождения/ожидания; **P3** — небольшая уборка. Размеры задач: small / medium / large. Внутри разделов важное идёт раньше косметики. Факт по коду, эксперимент и непроверенное предположение разделены.

Главный вывод: нужен не новый набор защитных `try/catch`, а один проверенный адаптер жизненного цикла сервисов dsh. При этом нельзя превращать аудит в переписывание ядра или графа. Отдельный ELK, чистые вычисления плана, host-адаптеры и подтверждение человеком — правильные границы.

## 1. Граница dsh — начать здесь

### На чём проверен контракт

Проверены локальные установленные типы/реализации. Здесь `DSH` означает `/Users/kjaly/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` (не плавающую интернет-документацию).

- `DSH/cordis/lib/index.js:675`: непривилегированное чтение сервиса бросает `cannot get property ... without inject`; optional chaining этого не предотвращает.
- `DSH/dsh-client-ui-layout/lib/types/client/service.d.ts:30`: `selectPanel(panelId: MainPanelId | null)`.
- `DSH/dsh-client-locale/lib/types/client/index.d.ts:49`, `:119`, `:125`, `:133`, `:159`: `active` — поле snapshot; `getLocale()` и `getSnapshot()` возвращают snapshot; `subscribe()` и `addLanguage()` возвращают disposer. Это не `locale.active`.
- `DSH/dsh-api-session-controller/lib/types/index.d.ts:66`, `:86`, `:97`, `:138`: inspect/create/modelCatalog/prompt соответствуют локальным faces.
- `DSH/dsh-settings/lib/types/index.d.ts:243`: `settings.get(namespace)` существует. `DSH/dsh-client-locale/lib/index.js:22` сам получает его через `ctx.inject(['settings'], ...)`.
- `docs/notes/2026-09-22-dsh-right-pane.md:29`, `:54`, `:129`, `:151`: проверенный ранее контракт keyed slots, реестра и `useSessions`. Он согласуется с текущими локальными `.d.ts`; это хорошая разведка, её не следует заменять догадками.

### Полная карта точек соприкосновения плагина

| Место | Что предоставляет dsh и как используется | Оценка формы |
| --- | --- | --- |
| `packages/plugin/src/client/index.tsx:11`, `:16`, `:23` | Статическая инъекция `slots`; `get('slots')`; `slots.inject` / `register` для sidebar.panellist, main, settings.section | Статически объявленная зависимость — правильно. Проверка наличия не проверяет форму. Комментарий «must never throw» шире реализации: `get`, `inject`, `register` вне общего guard. |
| `packages/plugin/src/client/layout.ts:13` | `get('layout')`, затем `ctx.layout`, затем deferred inject, затем `selectPanel` | Метод правильный, доступ всё ещё ошибочен: B1. |
| `packages/plugin/src/client/i18n.ts:64`, `:77`, `:92` | `locale.getSnapshot/getLocale`, `subscribe`, `addLanguage`, context events `locale/change` и `dispose` | Snapshot — правильно. Прямое `.active` — совместимость с тестовыми double, не доказанный современный API. Доступ защищён, lifecycle неполон: B2. |
| `packages/plugin/src/client/right-pane.tsx:60`, `:91` | Deferred `sidebarRightTabs.register`; два keyed slot под `definition.id` | Правильная двухступенчатая регистрация. Собственные копии structural types; результат register явно не сохраняется. Проверить scoped auto-disposal Cordis, не объявлять утечку без этого. |
| `packages/plugin/src/client/right-panel.tsx:21`, `:25` | Props `sessionId`, selector-hook `useSessions`, чтение `byId[id].cwd` | Подтверждено исследованием k1. Это переданные props, им не нужна инъекция. `repoForCwd` — собственное сопоставление с longest-prefix, не API dsh. |
| `packages/plugin/src/client/notify.tsx:300` | Привязка layout; собственный SSE и React root | SSE — API самого плагина, а не сервис dsh. Отсутствует teardown при выгрузке: B2. |
| `packages/plugin/src/host/index.ts:19`, `:41`, `:62`, `:65` | Статические `tools`, `systemPrompt`; `effect`; `register`, `section` | Правильно: обязательные зависимости и disposers принадлежат контексту. |
| `packages/plugin/src/host/index.ts:44` | `settings.get('locale').preference` | Сам метод и namespace верны; сервис не инъецирован: B3. Preference также не равна browser-derived active language. |
| `packages/plugin/src/host/index.ts:84`, `:116` | Deferred sessionController и webServer; child.effect; очистка sessions при dispose | Правильный образец lifecycle для общего адаптера. Без controller маршруты остаются и дают 503. |
| `packages/plugin/src/host/chat.ts:106`, `:118`, `:121`, `:159`; `packages/plugin/src/host/actions.ts:371`, `:597`, `:606` | `prompt({mode:'queue',content},signal)`, `inspect`, `create({cwd})`, `modelCatalog` | Получают уже инъецированный controller через deps/getter. Не повторяют чтение ctx. `modelCatalog` опционален, ошибки превращаются в отсутствие каталога; это деградация, не доказательство доступа к модели. |
| `packages/plugin/src/host/index.ts:26`; `packages/core/src/workspaces/workspaces.ts:10` | Реестр dsh читается из `~/.dsh/storages/workspace.json`, `tables.workspaces` | Файловый адаптер, не публичный service contract. Форма проверяется, но путь и формат привязаны к установке: B4. |
| `packages/plugin/scripts/build.mjs:6`, `:100`; `packages/plugin/cordis.patch.yml:5` | React от shell; `window.__ModuleLoader__.load`; регистрация профиля | Правильно изолировано в сборщике/манифесте. Build-тест проверяет wrapper и отсутствие Node/dsh runtime imports в клиенте. |

Транзитивная граница тоже существует: `packages/core/src/dsh/runner.ts:18`, `:124` запускает `dsh --profile acp` и вызывает ACP `session/set_config_option` с `deepseek-official`; `packages/core/src/cost/dsh-bill.ts:16`, `:25` читает records.jsonl стороннего dsh-bill. Не надо смешивать эти Node-адаптеры с browser accessor. Их формы закреплять отдельными fixtures/контрактными тестами. Ядро **не зависит от React или runtime-пакетов dsh**, но утверждать, что оно «не знает dsh», буквально неверно: эти интеграции в нём намеренно есть.

### Находки

**B1 · P1 · `packages/plugin/src/client/layout.ts:22`, `:27`; `packages/plugin/src/client/notify.tsx:301`.** `faceOf(ctx)` вызывается до инъекции, его fallback читает `ctx.layout` вне `try`. Эксперимент с getter, бросающим ровно ошибку Cordis, показал: `bindLayout` бросает, callback `inject` вообще не достигается. В `apply` исключение поглощается вокруг всего `startReviewCenter`, поэтому возможен не только неработающий «Открыть», но и отсутствие установки SSE/тостов. **Цена:** владелец пропускает готовую работу; третий независимый способ чтения снова возвращает старую поломку. **Задача:** сначала контрактный тест строгого контекста, затем получать layout исключительно внутри общей инъекции; недоступность выражать состоянием capability. **Размер: medium** (вместе с адаптером ниже).

**B2 · P1 · `packages/plugin/src/client/i18n.ts:105`, `:107`, `:109`, `:113`; `packages/plugin/src/client/layout.ts:11`; `packages/plugin/src/client/notify.tsx:306`.** Locale unsubscribe выбрасывается; если исходный ctx и child дают один face, подписка создаётся дважды. На double с одним face измерено **2 subscribe, 0 unsubscribe после dispose**. Layout сохраняется в module-global без production cleanup. EventSource хранится в локальной переменной, ни close, ни unmount на dispose нет; даже `resetReviewCenter` не закрывает source. **Цена:** при повторном apply/замене сервиса старый context продолжает влиять на язык и уведомления; lifecycle нельзя проверить тестовым reset. **Задача:** scoped binding, idempotent adoption по identity, disposer на подписку/собственную регистрацию/stream/root; тест acquire → replace → dispose → reapply. Не удалять чужой язык. **Размер: medium**.

**B3 · P1 · `packages/plugin/src/host/index.ts:46`; `packages/plugin/src/host/dsh.ts:38`; `packages/plugin/test/host-i18n.test.ts:5`.** Четвёртый вариант той же ловушки: `settings` не в `inject` и читается с root ctx. Catch делает английский fallback, скрывая неверный доступ. Тест зовёт `hostLang('ru')` напрямую и не касается ctx. **Цена:** русский shell и русская панель могут подтверждать действия английским окном; типы убеждают, что сервис доступен. **Задача:** deferred binding settings с очисткой, контрактный тест hostile root/разрешённого child, явная политика для отсутствующего preference (не выдавать host preference за активную локаль браузера). **Размер: small** после B1.

**B4 · P2 · `packages/core/src/workspaces/workspaces.ts:10`, `:20`; `packages/plugin/src/host/service.ts:108`.** Home-based путь фиксирован; ошибки чтения/формата неотличимы от пустого реестра; watch ставится только при start. В отличие от billing (`packages/core/src/cost/dsh-bill.ts:16`) этот reader не учитывает `DSH_HOME`. **Цена:** нестандартная установка или смена формата скрывает репозитории; новый workspace/новая `.orchestration` живёт на polling до перезапуска. **Задача:** инъецируемый storage-path reader с last-good/диагностикой ошибки и динамическим набором watchers; fixture реального формата, тест добавления workspace после start. Не утверждаю, что произвольный `DSH_HOME` обязательно поддержан всеми версиями shell: это требует проверки host storage contract. **Размер: medium**.

### Как должен выглядеть один accessor

`packages/plugin/src/client/dsh.ts:6` сейчас — набор optional guesses, а фактические faces разбросаны по layout/i18n/right-pane. Нужен **один механизм разрешения**, с отдельными типизированными картами client и host; не один огромный сервис и не runtime import `@deepseek-ai/*`.

```ts
// Эскиз контракта, не готовая правка.
type ClientServices = {
  layout: { selectPanel(key: string): void }
  locale: {
    getSnapshot(): { active: string }
    subscribe(fn: () => void): () => void
    addLanguage(input: LanguageRegistration): () => void
  }
  sidebarRightTabs: TabRegistryFace
}
// Только адаптер читает child[name]. validate проверяет нужные методы.
// onAvailable возвращает cleanup; child.effect владеет cleanup и сбросом ref.
bindDshService(ctx, 'locale', validateLocale, locale => {
  adopt(locale.getSnapshot())
  return locale.subscribe(() => adopt(locale.getSnapshot()))
})
```

Accessor обязан: инъецировать до чтения; не повторять root fallback внутри callback; проверять callable-форму; сбрасывать ref на потерю capability; отличать отсутствие optional сервиса от нарушения формы; публиковать одну диагностическую запись, а не молча ловить всё. Compatibility с `getLocale()` — явный адаптер версии, `.active` не включать в основной тип. Обязательные slots/tools/systemPrompt остаются статическими зависимостями. Проверка обязательна на строгом fake с throwing getters, задержанным inject и disposal; один smoke в реальном dsh нужен для loader/slot props. Это задача B1, не повод переписывать Cordis.

## 2. Дублированные знания

**D1 · P0 · `packages/plugin/src/host/actions.ts:477`, `:492`; `packages/core/src/orchestration/review.ts:49`; `packages/core/src/orchestration/snapshot.ts:118`.** Пакетная приёмка обходит индивидуальный verdict: пишет только «принято человеком (пачкой)». Snapshot определяет `closed: negative` по тексту последней accept-note с `вердикт: negative`. После приёмки отрицательного результата пачкой отрицательная семантика исчезает из snapshot; экономический экран уже не может её учесть. Это признано в журнале задачи r1, но цена больше «заметка без вердикта». **Цена:** владелец видит закрытие без сохранённого отрицательного результата. **Задача:** сохранять verdict каждой задачи при batch в одной plan-write, перед подтверждением показывать отрицательные/спорные элементы; тест single/batch parity до snapshot/economics. Не запрещать человеку принять спорное. **Размер: medium**.

**D2 · P1 · `packages/core/src/orchestration/snapshot.ts:52`, `:73`; `packages/plugin/src/client/review.ts:16`; `packages/plugin/src/client/views/accept-batch.tsx:15`; `packages/plugin/src/host/chat.ts:221`.** Три понятия смешаны: число `in_review`, число `needsHuman` и «можно принять сейчас». Review/lens правильно переиспользуют `acceptableTasks`, однако helper живёт внутри React-view. Background summary считает только `in_review`; готовые решения там теряются из общего ожидания. `needsHuman` в `packages/core/src/plan/graph.ts:68` истинно даже для заблокированного decision, поэтому суммировать его нельзя. **Цена:** исчезающее ожидание человека при переключении плана и разные числа в rail/queue/badge. **Задача:** core выдаёт отдельные `waitingHuman`/reviewable facts для всех планов; client считает из одного browser-safe selector, host проверяет тем же правилом на актуальных данных. Различать status counts и readiness, а не механически заменить все счётчики. **Размер: medium**.

**D3 · P1 · `packages/plugin/src/client/provider.ts:12`; `packages/plugin/src/client/workers.ts:6`, `:8`; `packages/plugin/src/shared/types.ts:56`; `packages/plugin/src/host/actions.ts:207`; `packages/core/src/routing/registry.ts:1`.** Ручной MODELS, статический WORKERS, двухэлементный PORCH_CLAUDE и более полный PORCH_DIRECT описывают одни сущности. Host уже строит workers из registry, но node получает только id и рисует встроенное имя; переименование владельцем туда не доходит. **Цена:** выбор и подпись расходятся с настройками, новый worker требует нескольких патчей. **Задача:** добавить разрешённую worker identity в snapshot/catalog, один pure canonical-id map для UI и host; формировать selectable list из registry с сохранением текущего неизвестного id. Не смешивать identity модели и точный id backend: отключение porch и direct сейчас различается намеренно. **Размер: medium**.

**D4 · P1 · `packages/plugin/src/host/actions.ts:419`; `packages/plugin/src/client/settings.tsx:379`, `:389`.** Удаление registry, точных routing ids и alias routing разнесено между двумя файлами и двумя POST клиента. После ошибки второго запроса удалённый worker ещё назначается через alias; CLI/API не выполняют клиентскую компенсацию. **Цена:** владелец удалил исполнителя, а задачи всё ещё уходят к нему. **Задача:** одно host/core действие удаления с каноническими alias, сериализацией и восстановлением после частичной записи; клиент только отображает результат. Тест сбоя между записями и CLI/HTTP parity. **Размер: medium**.

**D5 · P1 · `packages/plugin/src/host/actions.ts:467`, `:469`; `packages/core/src/orchestration/verdict.ts:5`.** После t6 host подставляет `why`/`mismatch` коды (`blocked`, `no_files`, `claim_missing`) в нативное человеческое подтверждение как готовую фразу. **Цена:** самый ответственный экран показывает внутренний код вместо причины; тесты словаря этого не замечают. **Задача:** host presentation mapping кодов, контрактный тест реального detail → confirm на ru/en для каждого кода. **Размер: small**.

**D6 · P2 · `packages/plugin/src/client/provider.ts:37`; `packages/plugin/src/client/summary.ts:35`; `packages/plugin/src/client/insight.ts:23`; `packages/plugin/src/client/i18n.ts:121`.** Три реализации elapsed duration с отдельными ключами повторяют minute/hour rounding; relative-time buckets — иной контракт и должны остаться отдельными. **Цена:** расходящиеся подписи/округления на границах часа, три места для исправления. **Задача:** единый pure duration formatter, явно отделить relative age и trace mm:ss; зафиксировать 59/60/3599/3600 секунд, invalid/future. **Размер: small**.

**D7 · P2 · `packages/plugin/src/client/panel/report.tsx:4`; `packages/core/src/orchestration/verdict.ts:7`; `packages/plugin/src/client/routing.ts:4`.** RISK_WORDS и kind→class fallback по-прежнему зеркала с keep-in-sync. Корневой runtime-import core действительно затянет Node, но это не обоснование бесконечно копировать факты. **Цена:** подсветка отчёта и маршрутизация расходятся после независимого изменения. **Задача:** отдавать классификацию из core или сделать узкий browser-safe leaf export только данных/чистых функций; убрать runtime-зависимость selector от `views/accept-batch.tsx`. **Размер: medium**. Саму границу «клиент импортирует из root core только типы» сохранить.

**D8 · P2 · `packages/plugin/src/client/worktree-copy.ts:13`; `packages/plugin/src/client/views/graph/layout.ts:22`; `packages/plugin/src/client/views/graph/graph-view.tsx:820`.** Перевод используется как protocol identity (worktree policies, decision lane), а поиск кнопки «Уточнить» зависит от текста и отдельно импортирует ru. **Цена:** редактура перевода меняет значения данных/поиск элемента; lazy dictionary не сможет убрать ru из initial chunk. **Задача:** отдельные стабильные protocol constants с сохранением legacy wire values; кнопка получает ref/action id; display-переводы остаются только display. **Размер: medium**.

**D9 · P2 · `packages/core/src/watch/rules.ts:1`; `packages/plugin/src/client/summary.ts:88`; `scripts/lint-i18n.mjs:17`, `:38`; `packages/plugin/src/client/i18n.ts:39`.** Страж ищет только буквальную кириллицу в client/host после regex-strip комментариев. Он не видит русский текст из core, `\u` escapes и неизвестные ключи `t(string)`. Attention.message/hint всё ещё показываются напрямую. **Цена:** зелёный lint при смешанном языке, опечатка ключа становится текстом UI. **Задача:** codes+params для attention, тип ключей по en, AST-проверка вызовов и placeholders; не переводить пользовательский отчёт. **Размер: medium**.

Проверка словарей на этом срезе: **685 en / 684 ru**, единственный en-only — намеренный `internal.testFallback`; **0 отсутствующих literal `t('…')` keys**, **0 несовпадений наборов placeholders** у парных keys. Динамические keys этим поиском не доказаны. Старые 31/42 exemptions уже не действуют: `scripts/lint-i18n.mjs:7` содержит только host/prompt. KEEP_REASON уже передаёт коды (`packages/core/src/worktree/gc.ts:33`): не заводить задачу повторной миграции t6. Это успешно закрытый долг, а не новая находка.

## 3. Мёртвое: удалять только доказанное

Поиск: `rg -n 'journalPath|resetVendorMarks|ORCHESTRA_TAB_LABEL' packages` с исключением generated `dist/lib`; отдельно просмотр импортов/re-экспортов во всех `packages/*/src` и `packages/*/test`. История: `git log -S <symbol>` / `git log --diff-filter=A -- <file>`. Публичные core exports без внутреннего потребителя не считаю мёртвыми: у библиотеки может быть внешний потребитель.

**X1 · P3 · `packages/plugin/src/client/panel/report.tsx:13`, `:26`.** `journalPath`/JOURNAL имеют только определение и вызов regex внутри самой функции: потребителей и тестов нет. Появились `d0acb25` (2026-09-22, j2); использование убрано `b472427` (2026-09-23, verdict UI). **Цена:** ложный второй механизм извлечения журнала, который следующему worker легко оживить по ошибке. **Задача:** удалить helper и regex, не трогая действующий verdict journal fact. **Размер: small**. Tree shaking уже убирает это из клиентского entry, значимой экономии загрузки не обещаю.

**X2 · P3 · `packages/plugin/src/client/vendor-mark.tsx:27`.** `resetVendorMarks` объявлен test seam, но `rg` по packages/src/test находит только определение. Пришёл с `9856437` (2026-09-22, vendor marks). **Цена:** неработающее обещание изоляции tests, лишняя поверхность. **Задача:** либо реально использовать для теста cache retry/reset, либо удалить export/function; не удалять `available` и `inFlight`, они работают. **Размер: small**.

CSS: скан всех `.orc-*` selectors дал **20 имён без literal-вхождения** за пределами styles, но они принадлежат динамическим семействам (`orc-ev--${group.kind}`, `orc-gedge--${edge.state}`, `orc-garrow--${state}`, `orc-prov--${identity.mark}`, `orc-tl__bar--${seg.kind}`, status/tone/verdict suffixes). Доказательства: `packages/plugin/src/client/panel/tabs.tsx:48`, `views/graph/graph-view.tsx:900`, `:911`, `vendor-mark.tsx:43`, `views/timeline.tsx:83`. **Доказанных неиспользуемых CSS-правил в этом проходе — 0**; рекомендаций удалить эти 20 нет. В истории `a44fd31` (2026-09-23) уже удалены `.orc-report__facts`, `__journal`, `.orc-run__sep`; журнал задачи r10 фиксирует, как пришлось вернуть ошибочно удалённые живые styles. Отсутствие literal string — недостаточное доказательство.

Не путать лишний export с мёртвым телом: `statusTone`, `runsWord`, `quotaWindow`, `troubled`, `reportVisible`, `reviewWaiting` имеют локальных потребителей. `ORCHESTRA_TAB_LABEL` используется тестом `packages/plugin/test/client/right-pane.test.tsx:58`, значит без изменения теста он не доказанно мёртвый. Отдельных тестов полностью исчезнувшей UI-функции не обнаружено; действующий пример тестов устаревшего **контракта** — porch precedence, T1 ниже.

## 4. Тесты и следы параллельных слияний

**T1 · P1 · `packages/core/src/porch/locate.ts:30`; `packages/core/test/porch.test.ts:1`; журнал задачи g1.** Production-выбор porch намеренно зависит от наличия `/dist/` или `/lib/` в пути исходника, чтобы старые тесты оставались зелёными. Это решение записано прямо в журнале. Более того, regex требует slash **после** `lib`; после bundling `here = dirname(import.meta.url)` кончается на `/plugin/lib`, и такая строка сама по себе условие не выполняет. **Цена:** tests и runtime выбирают разные бинарники; bundle может не предпочесть vendored fork вопреки обещанию. **Задача:** явный dependency/anchor для discovery; одинаковый алгоритм в source и bundle; fixtures «vendored/installed/missing», smoke built host и CLI. Переписать устаревшие ожидания, а не production ради них. **Размер: medium**. Не согласен с g1: запрет менять старые tests из плана не оправдывает две семантики исполнения.

**T2 · P1 · `packages/plugin/test/host-i18n.test.ts:5`; `packages/plugin/test/i18n.test.ts:96`; `packages/plugin/test/client-apply.test.ts:1`.** Есть полезные отдельные locale regressions, но нет единого строгого lifecycle-double для всего apply. Обычные plain objects дают читать любой сервис; тесты host dictionary не проходят settings injection. **Цена:** три уже случившихся сбоя не превращены в общий запрет класса ошибок, B1/B3 продолжают жить. **Задача:** покрыть host/client apply со строгим guard, delayed inject, malformed face, replace/dispose, реальные props tab; добавить сценарий toast → main panel. **Размер: medium**, часть B1–B3.

**T3 · P2 · `packages/plugin/test/service.test.ts:48`, `:52`.** Два fixed sleep (50/80 мс) вместо ожидания наблюдаемого snapshot. Первый полный прогон аудита реально получил goal `A` вместо `A2`; повтор без изменений прошёл. **Цена:** ложные красные сборки, привычка перезапускать и игнорировать failures. **Задача:** ждать subscription/condition и отдельно управлять debounce; всегда stop в finally. **Размер: small**. Это **1 воспроизведённый flake**, а не доказательство процентной частоты.

Исторический второй flake — камера `packages/plugin/test/client/graph-lens.test.tsx:61`: журналы o2/r9 сообщали failures под нагрузкой; `381d84e` (2026-09-22) заменил предположение о первом кадре на settle внутри waitFor. В двух полных прогонах здесь не воспроизведён. Не считать его действующей неисправностью без нового случая. Третья историческая гонка — одновременные build/test удаляют один `lib` (`packages/plugin/scripts/build.mjs:31`, журнал m1); в аудите такие записи не запускались параллельно.

**T4 · P2 · `packages/plugin/test/build.test.ts:12`; `packages/plugin/vitest.config.ts:5`; `packages/core/package.json:9`.** Tests используют alias core/src, но дочерний esbuild требует core/dist. На чистом worktree `pnpm test` сначала падает на unresolved core. **Цена:** заявленная единая команда checks не воспроизводима без скрытого шага. **Задача:** явная build-зависимость тестового pipeline либо isolated build fixture с source resolution; output build-теста в отдельной temp-dir, чтобы не гоняться с обычным build. **Размер: small**. В этом аудите после `pnpm --filter @dsh-orchestra/core build` полный `pnpm test` зелёный.

**T5 · P2 · `packages/plugin/test/index.test.ts:110`; `packages/plugin/test/client/decision-panel.test.tsx:75`; `packages/plugin/test/client/__snapshots__/decision-panel.test.tsx.snap:1`.** Число disposers `45` — устройство регистрации, а не доказательство отсутствия живых подписок после dispose. Большой DOM snapshot обычной панели полезен как локальный guard, но не доказывает ни видимость по CSS, ни безопасную приёмку. Snapshot менялся в `c4c2977`, `52d1f61`, `a44fd31`; регенерация сама по себе не свидетельство правильности. **Цена:** workers правят счётчик/снимок при merge и получают зелёный без проверки lifecycle/пользовательского решения. **Задача:** сохранить route-contract assertions; вместо голого числа проверить снятие регистраций и невозможность callback после teardown; snapshot дополнить целевыми assertions stable controls. **Размер: small**.

**T6 · P3 · `packages/plugin/test/client/board.test.tsx:2`, `:6`; `packages/plugin/test/chat-bind.test.ts:1`; `packages/plugin/test/client/plans-list.test.tsx:7`, `:9`.** Найдены **22 test-файла с повторными import declarations из одного модуля**, из них **20** — отдельный `afterEach as resetLangAfterEach`. Это не 22 ошибки runtime. Во многих файлах reset hook добавлен в самый конец (`graph-view.test.tsx:91`), импорт сейчас наверху, а не внизу; буквальный прежний симптом «import снизу» не подтверждён на этом HEAD. Источник основной волны — `00f18c0` (2026-09-23). **Цена:** сложно увидеть порядок очистки и общую test fixture; лишний merge-шум. **Задача:** объединить imports и cleanup+locale reset в одном afterEach; не перезаписывать snapshots ради косметики. **Размер: small**.

Дорогие пробелы адресованы поведением, а не числом tests: batch negative parity (D1), worker-delete partial failure (D4), код вердикта в native confirm (D5), изменившийся контракт с сохранёнными чекбоксами (L3 ниже), lifecycle настоящего Cordis (B1–B3), новоподключённый workspace (B4), budget queue detail requests (P4). Существующие тесты single accept, batch all-or-nothing по unknown id, GC dirty/unmerged/running и геометрии графа сохранять.

## 5. Вес и скорость — измерено

Среда: Node **v24.16.0**, macOS arm64, существующие lockfile/dependencies. Название CPU sandbox не разрешил прочитать; его не предполагаю. Нет network/backend paid calls. Числа — локальные Node/jsdom замеры, **не browser FPS и не production latency**.

### Бандл и metafile

Повторена browser-часть `packages/plugin/scripts/build.mjs:63` с тем же CSS-transform, target es2022, CJS, external React, minify, добавлен `metafile:true`, `write:false`. Применён тот же ModuleLoader wrapper. Результат совпал с собранным `lib/client.js`: **397 491 B = 388,17 KiB**, gzip **91 745 B**. Ceiling 420 KiB = 430 080 B, запас **32 589 B**. `lib/elk.js` отдельно **1 460 278 B**, не входит в client.js.

| Input по bytesInOutput | Байт | Доля client.js |
| --- | ---: | ---: |
| `packages/plugin/src/client/dict/ru.ts:1` | 106 559 | 26,8% |
| `packages/plugin/src/client/styles.ts:1` | 62 717 | 15,8% |
| `packages/plugin/src/client/dict/en.ts:1` | 36 360 | 9,1% |
| `packages/plugin/src/client/views/graph/graph-view.tsx:115` | 25 042 | 6,3% |
| `packages/plugin/src/client/settings.tsx:1` | 20 085 | 5,1% |
| `packages/plugin/src/client/panel/task-panel.tsx:1` | 12 772 | 3,2% |
| `packages/plugin/src/client/panel/trace.tsx:1` | 10 057 | 2,5% |
| `packages/plugin/src/client/right-panel.tsx:1` | 9 675 | 2,4% |

Metafile: `/tmp/orch-s10-metafile.json`; измеритель `/tmp/orch-s10-measure.mjs`. Для воспроизведения не надо менять tracked build script: скопировать его browser build config в temp-script, вместо outfile-write запросить metafile/write:false и сортировать `Object.values(result.metafile.outputs)[0].inputs` по `bytesInOutput`. Сумма двух словарей — **142 919 B / 35,95%**; React и Node отсутствуют в browser inputs, ELK грузится отдельно.

**P1 · P2 · `packages/plugin/scripts/build.mjs:75`; `packages/plugin/src/client/i18n.ts:3`; `packages/plugin/test/build.test.ts:31`.** По умолчанию esbuild экранирует Unicode в ASCII; два словаря всегда статически импортированы. Эксперимент **только** с `charset:'utf8'`: **342 446 B**, gzip **89 598 B**; экономия **55 045 raw B (13,85%)**, но лишь **2 147 gzip B (2,34%)**. **Цена:** лишний initial parse/transfer, pressure на source minification. **Задача:** сначала UTF-8 output с проверкой encoding реального dsh loader; прогноз после этой единственной правки **342 446 B** на том же срезе (эксперимент уже построен), затем отдельный lazy-ru asset после D8. **Размер: small** для charset, **medium** для lazy locale.

После UTF-8 ru занимает **52 914 B**, en **35 938 B**. Арифметический ориентир initial English chunk без ru: **289 532 B плюс loader overhead**; это прогноз границы, **не замер реализованного code splitting**. Для русского интерфейса нельзя обещать ту же экономию: нужно загрузить ru и сохранить en fallback либо гарантировать полноту словаря. Дополнительные chunks dsh автоматически не публикует (`packages/plugin/src/host/assets.ts:21`), потребуется host asset route и cache/retry тест. С потолком как tripwire согласен; не согласен выдавать его повышение за оптимизацию. Исходники ужимать вручную не надо: текущая CSS-minification на этапе сборки правильна.

### Большой план

Фикстура: chain из N задач ready, id t0…tN−1, один dep на предыдущую, без runs/notes; в pure client-замере lane на каждые 100 задач, в disk snapshot — без lanes. Для pure functions 5 warm-up + 20 измерений, median; для `buildRepoSnapshot` настоящий temp plan через initPlan/updatePlan, 2 warm-up + 10 измерений, median, backend не вызывается. Включены load/parse/derive/summarize, исключены внешние processes, реальные event logs и много фоновых планов.

| N | Полный buildRepoSnapshot, мс | deriveViews, мс | criticalPath, мс | foldGraph, мс | lensTasks ready, мс | graph dependencies через filter, мс | Prototype adjacency index, мс |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0,769 | 0,023 | 0,072 | 0,116 | 0,032 | 0,127 | 0,017 |
| 1 000 | 4,926 | 0,225 | 2,754 | 1,153 | 0,495 | 11,353 | 0,142 |
| 5 000 | 46,829 | 0,727 | 45,918 | 3,149 | 1,803 | 99,516 | 0,462 |

Колонки измерены отдельными сериями, их нельзя складывать/вычитать как профиль одного вызова. В частности 11,353 мс dependencies не часть server snapshot.

**P2 · P2 · `packages/core/src/plan/graph.ts:81`, `:94`.** `criticalPath` мемоизирует массив всего пути для каждого узла; chain хранит O(N²) элементов. **Цена:** длинный план платит памятью и десятками миллисекунд на каждый обход, хотя deriveViews дешёвый. **Задача:** хранить длину и predecessor, реконструировать только финальный путь; сохранить tie-breaking. **Размер: small**. Отдельный парный benchmark prototype: 100 — **0,037 → 0,055 мс** (не выигрыш); 1 000 — **1,608 → 0,314**; 5 000 — **47,784 → 1,207**. Выходные массивы на всех трёх fixtures совпали. Это прогноз порядка **1–2 мс** для этой стадии после изменения, не обещание времени всего snapshot. Добавить branching/tie/cycle-validation tests перед правкой. Измеритель `/tmp/orch-s10-critical.cjs`.

**P3 · P2 · `packages/plugin/src/client/views/graph/graph-view.tsx:164`, `:166`, `:160`; `packages/plugin/src/client/store.ts:269`.** Graph tasks для каждого node заново фильтруют весь edges; новое `shown.tasks` также вызывает setManual с новым объектом, заново строя folds. **Цена:** quadratic подготовка и повторный React render на семантически одинаковый snapshot. **Задача:** adjacency Map за один проход (измеренный прогноз **99,516 → около 0,462 мс** на 5 000); structural sharing репозитория, не игнорирующее attention/positions/time, и idempotent manual state; выделить memoized node с устойчивыми props. **Размер: medium**.

React Profiler/jsdom на **200 ready nodes / 10 lanes**, stable onSelect, reduced motion, заглушенный rAF (camera frames не измеряются): после settled mount выбор одного узла вызвал **1 commit / 10,97 мс / 200 VendorMark renders**. JSON-clone неизменного repo дал **5 commits / суммарно 55,39 мс / 1 000 VendorMark renders**. Счётчик добавлялся через esbuild onLoad в памяти; source file не менялся. Скрипт `/tmp/orch-s10-profile.mjs`. Для устранённого семантически пустого update целевой прогноз **0 graph subtree renders**; для перехода selection между двумя независимыми node — **не более 2 node renders** при отключённой chain-подсветке. Это счётные цели, не измеренный «после» браузер и не гарантия для hover/chain/lens. Прежде чем обещать FPS, нужен browser profile; по этим данным можно обосновать именно selector/identity, а не замену графового движка.

**P4 · P2 · `packages/plugin/src/client/queue.tsx:40`; `packages/plugin/src/client/right-panel.tsx:12`; журнал задачи j2.** Каждая смонтированная review-row получает full detail ради первой строки отчёта; detail включает git/event work. Это признанное изменение прежнего lazy контракта; нет budget-теста на большой queue. **Цена:** очередь масштабируется количеством дорогих requests; «очередь короткая» — предположение автора, не гарантия. **Задача:** лёгкий review summary/batched endpoint, full detail по раскрытию; budget-тест N rows. **Размер: medium**. Число/latency реальных git-processes на рабочем репозитории здесь не измерялось, поэтому ms-экономию не заявляю и выше измеренных P2/P3 по скорости не ставлю.

Архитектура графа, которую оставить: `packages/plugin/src/client/views/graph/graph-view.tsx:221` отделяет shapeKey от status и не раскладывает граф заново из-за статуса; camera/springs работают через refs/DOM в кадре, не через React setState на каждом пикселе. Lens сохраняет полный граф, folded graph — derived view. Это правильнее тотального rewrite или виртуализации без профиля.

## 6. Что workers честно оставили

Прочитан **41** журнал отклонений на срезе (сами журналы ушли вместе с рабочей историей). Ниже — индекс по задачам и сверка с нынешним кодом; журнал — свидетельство решения, а не автоматически незакрытая задача.

### Действующие дополнительные долги

**L1 · P0 · `packages/core/src/worktree/gc.ts:268`, `:274`; журнал задачи o2.** Автоуборка после приёмки вызывает `gcRemove`, обходя KEEP_RECENT. План 2o говорил «последние 3 … остаются, даже если подходят под правило» и требовал вызвать уборку своей задачи. Не согласен с выводом журнала, что из вызова следует обязательное удаление: корректный вызов может вернуть recent/kept. **Цена:** уничтожается свежая рабочая копия, которую владелец рассчитывал сохранить по плану; clean/merged checks не сохраняют саму копию. **Задача:** явно выбрать и записать единый retention contract, по умолчанию соблюдать KEEP_RECENT; проверить recent на пути auto-accept, а не только gcCandidates. Изменение политики обозначить поведением, не refactor. **Размер: small**. Не утверждаю потерю незакоммиченных данных: проверки clean/merged и отсутствие force здесь правильны.

**L2 · P1 · `packages/plugin/src/client/views/graph/graph-view.tsx:641`; `packages/plugin/src/host/actions.ts:504`; журнал задачи m4.** Tidy — последовательность `/pos`; protocol не адресует plan/revision. Клиент останавливает будущие записи при смене плана, но уже посланную не отзывает. **Цена:** частичный результат и риск применения позиции к текущему на сервере другому плану с тем же task id; один undo в UI не означает atomic write. **Задача:** batch positions с planId/expected rev, одно обновление плана; тест смены плана и отказа в середине. **Размер: medium**.

**L3 · P1 · `packages/plugin/src/client/panel/decision-brief.tsx:27`, `:59`; журнал задачи r9.** Чекбоксы localStorage адресованы task/plan, а сами пункты — индексом строки без версии контракта. **Цена:** обновлённое условие приёмки выглядит уже проверенным человеком. **Задача:** content hash/revision контракта в ключе; при изменении сбросить или перенести только доказанно одинаковые пункты; тест reorder/insert/change. **Размер: small**.

**L4 · P2 · `packages/core/src/preflight/preflight.ts:43`; `packages/core/src/dsh/runner.ts:19`; `packages/plugin/src/client/settings.tsx:433`.** Codex preflight подтверждает binary/quota, не login/model access; provider dsh жёстко deepseek-official. UI честно ограничивает каталог и говорит «вход не подтверждён». **Цена:** неверная модель/отсутствие входа обнаруживается на запуске; другие providers недоступны. **Задача:** явные capabilities binary/auth/model, отдельная пользовательская probe модели (не скрытый платный preflight), provider поле только с end-to-end поддержкой runner. **Размер: medium**. Не удалять GPT ids лишь по отсутствию в старом bundled каталоге журнала l1 — это не доказательство недоступности сейчас.

**L5 · P2 · `packages/plugin/src/host/chat.ts:125`, `:284`; журнал задачи i1.** Первый snapshot становится baseline даже для несообщённого внимания, возникшего во время downtime; `openChat` допускает несуществующий plan через catch undefined. **Цена:** пропущенное пробуждение / бесхозная связь из опечатки. **Задача:** отдельно решить restart catch-up с persisted keys, валидировать plan перед созданием сессии; тест downtime/restart и invalid plan. **Размер: medium**. Baseline против flood — намеренный trade-off, его нельзя тихо изменить как уборку.

**L6 · P2 · `packages/plugin/src/host/actions.ts:597`; `packages/core/src/orchestration/control.ts:26`; журналы задач p1 и w1.** Нет транзакции между dsh session и plan files; split может оставить сессию, steer может быть записан backend-у до ошибки note, status-check не гарантирует последующее потребление. **Цена:** частичный результат и ручная сверка владельцем. **Задача:** idempotent operation record/recovery для split и steer, fault-injection на каждом шаге; ack потребления — отдельный backend contract. **Размер: large** для end-to-end ack/recovery. Слово `delivered` сегодня честно означает запись, не исполнение; не обещать больше.

**L7 · P2 · журналы задач m1 и l3; `packages/plugin/test/client/decision-panel.test.tsx:75`.** DOM/геометрия не закрывают реальный shell lifecycle, native confirm, pointer-capture и CSS на разных ширинах. Несколько workers честно не смогли запустить браузер; это не становится визуальной проверкой от количества green tests. **Цена:** очередной сбой найдёт владелец после merge. **Задача:** один smoke-пакет в реальном dsh: ru/en boot и переключение, toast Open, right-pane session switch, native accept single/batch, drag/tidy, widths 1280/1920, reduced motion. **Размер: medium**. Этот аудит не выдаёт jsdom profile за выполненный smoke.

**L8 · P3 · `packages/plugin/src/host/actions.ts:516`, `:526`, `:280`; журнал задачи k2.** `plan-init` всё ещё не делает CLI `ensureGitExclude` и дважды refresh-ит через handler+post wrapper. **Цена:** служебные файлы попадают в git status; лишний обход. **Задача:** общий init use-case для CLI/HTTP, одна refresh после commit. **Размер: small**. Отдельных ms для этого пути нет; не заявлять крупную оптимизацию.

### Индекс задач (все журналы, без пропущенных «не получилось»)

Журналы ушли вместе с рабочей историей, поэтому ниже остаются идентификаторы задач. «Закрыто» относится только к названному долгу, не сертифицирует весь feature. Для открытых проблем цена/задача/размер заданы идентификаторами выше; намеренные ограничения не являются требованием всё переделать.

| Задача | Что осталось к этому HEAD |
| --- | --- |
| `f2` | Cap accepted=6 и fit readability — намеренно; adaptive column stretch не реализован и не нужен без UX-основания. Timeline overlap с now требует визуальной проверки L7. |
| `f3` | Static worker mapping D3 жив. Ожидание SSE при plan-use — текущий контракт store/API; overlay был развит в f5. |
| `f5` | jsdom не доказывает CSS visibility; L7. Overlay/отключённая анимация узкого режима — намеренно, не долг. |
| `g1` | Разная precedence source/built остаётся: T1. Help placement — закрыто/косметика. |
| `g2` | Class mirror D7, static run list D3. Routing по умолчанию auto и serial save — правильное поведение; не откатывать. |
| `g4` | Alias identity D3, двукратный usedIn (host:168/client:443) ещё есть. Локальный пересчёт нужен для unsaved draft: общий pure selector допустим, удалять локальное обновление нельзя. Exact disabled id — backend-семантика. |
| `g5` | Ручная canonical карта D3; переменная высота DnD rows всё ещё меряется высотой grabbed row (`settings.tsx:94`): проверить L7 с multiline labels. Rollback queue намеренный. |
| `h1` | Background decision blind spot остаётся D2; pointer-capture исключения уже есть, не чинить повторно. Toast-root lifecycle — B2. |
| `i1` | 503 вместо отсутствующего route — правильное решение. Restart baseline/unknown-plan L5; typed optional services B1–B3. |
| `j1` | Report parsing boundaries/clip — явный bounded protocol. Дополнительное events чтение для предыдущего completed run намеренно: `core/src/orchestration/detail.ts`; не удалять ради одного запроса. |
| `j2` | Eager row detail P4; batch sheet по-прежнему не показывает reportLine (`views/accept-batch.tsx`). Добавлять только вместе с лёгким summary, не размножать detail calls. Journal helper больше не нужен X1. |
| `k1` | Shapes исследованы; вынужденные локальные type copies — B1. Body-заглушка уже заменена. Старый 300KB gate заменён текущим измерением P1. |
| `k2` | Sync reader/watch limits B4, init/exclude/double refresh L8. hasPlan-before-degraded реализован клиентом правильно. |
| `k3` | Slots props ещё требуют реального smoke L7; eager details P4. Прямой захват layout заменён accessor, но B1 остался. |
| `k6` | Session-row extension/unread semantics всё ещё не доказаны, новых догадок не добавлять. Глобальный badge — review debt, не unread конкретного чата (`notify.tsx:290`). |
| `l1` | Provider limitation L4 честно ограничен UI; отсутствие моделей в тогдашнем offline catalog не текущий verdict о доступности. |
| `l2` | UI реестра уже есть; двухфайловое удаление/alias D4, provider L4 остаются. |
| `l3` | Auth/model L4; alias deletion частично компенсирован клиентом, atomicity D4; live screenshot L7. |
| `m1` | Freshness только acceptedAt/activeSince, не любое изменение; поле updatedAt задачи всё ещё отсутствует (`core/src/orchestration/snapshot.ts:9`). Если нужен иной freshness — отдельное расширение snapshot, не приписывать repo.updatedAt всем задачам. L7. |
| `m1c` | Long folded stack расширяется по x, pinned coordinates восстанавливаются после раскрытия — намеренно. Непересечение проверено геометрией, внешний вид L7. |
| `m4` | Partial write/plan switch L2 жив; унаследованные ручные overlaps не повод двигать соседнюю lane. |
| `n1` | Скриншотов живого shell и реальной установки в этом журнале нет; L7. README обновлять после волн, как план требует. |
| `o1` | Legacy acceptedAt fallback «давно» остаётся намеренным; не выдумывать timestamp (`client/dead-ends.ts`). |
| `p1` | Сохранение dependencies при split правильно. Session/file partial operation L6; CLI повреждённый chats.json трактует пустым (`cli/src/commands/plan.ts`) — в recovery-задаче L6 сохранять повреждённый файл, не затирать. |
| `q6` | Узкие шесть tabs/длинные пути требуют L7; перенос фактов в один header — сделан. |
| `r1` | Exact command matching заменён w2; fixture typecheck сейчас green. Batch verdict D1 остаётся; plain-text acceptance storage legacy совместимость всё ещё нужна. |
| `r7` | RISK_WORDS mirror D7 жив. Отсутствующая денежная оценка не zero — правильная семантика, сохранить. |
| `u3` | minify уже в сборщике, старый размер устарел. Clamp camera и мгновенный scroll — намеренно. Исторический camera flake исправлялся T3. |
| `u4` | Snapshot не содержит finishedAt; runFact до приёмки показывает dash — честно. При расширении worker identity D3 добавить finishedAt, не подменять его updatedAt. |
| `o2` | KEEP_RECENT конфликт L1. o3 UI сделан. Unix du — допустимая macOS граница, размер может быть неизвестен. No-force сохранён. |
| `o3` | Source CSS minification откачена, build transform есть. KEEP_REASON mirror снят t6. Alias two-POST D4 и Codex auth L4 живы. |
| `r10` | Source styles восстановлены; запас 9 байт устарел, P1 даёт новый замер. SourceLine может перестать совпадать с изменённым report: fallback раскрытия сохранён; visual L7. |
| `r9` | Checklist positional storage L3; dependency detail N calls — тот же класс P4. Snapshot не доказывает CSS. |
| `t2` | Exemptions migration завершена до 1; snapshot getter исправлен. Locale unsubscribe B2 ещё открыт. |
| `t3b2` | Escape-encoded RISK_WORDS остаётся D7/D9; пользовательские report/contract тексты переводить не надо. |
| `t3d` | Policy display теперь локализован, wire data из ru — D8. Ошибка, сохранённая как строка в state, не переводится задним числом: низкая цена, отдельной срочной задачи нет. |
| `t3e` | CLI-owned help переведён, upstream diagnostics всё ещё могут быть русскими. Attention на экране — D9, не «данные пользователя». |
| `t4` | Legacy CLI literals в scope хвоста закрыты t3e; host settings binding B3 остаётся неверным. Раздельные host/client/CLI dictionaries по runtime — правильно. |
| `t6` | Verdict/GC codes внедрены; attention оставлен D9; host consumer не адаптирован до конца D5. Старые acceptance notes сохранять. |
| `w1` | status/write race, note-after-write и отсутствие consumption ack реальны L6; UI больше не обещает исполнение — правильно. |
| `w2` | Heuristic checks и подделываемость отчёта остаются намеренным пределом (`verdict.ts:24`). Не превращать green report в proof of execution. Для более сильной гарантии нужна отдельная task на structured execution evidence, large; цена без неё — обязательная ручная проверка. |

## Что архитектурно правильно и что делать первым

- `packages/core/src/plan/graph.ts:45`: чистое вычисление view status отдельно от persisted status; `packages/core/src/plan/store.ts` владеет обновлением плана. Не переносить это в React.
- `packages/plugin/src/host/service.ts:37`: chat augmentation остаётся в host, core snapshot не узнаёт session-controller. `packages/plugin/src/shared/types.ts:1` импортирует core types; browser bundle реально не содержит Node. Сохранить эти границы.
- `packages/plugin/src/host/index.ts:84`: optional sessionController и стабильные 503 маршруты лучше отсутствующих маршрутов; cleanup через child.effect — образец B1.
- `packages/plugin/src/host/actions.ts:471`, `:491`; `packages/core/src/worktree/gc.ts:220`: человек подтверждает приёмку, сервер перепроверяет GC; нет force/rm обхода. Исправлять parity и retention, не автоматизировать решение за человеком.
- `packages/plugin/scripts/build.mjs:17`, `:81`: CSS сжимается сборщиком, ELK отдельно; это уже правильные исправления прежнего бюджетного давления.
- `packages/core/src/orchestration/control.ts:25`; `packages/core/src/orchestration/verdict.ts:24`: отделены «записано исполнителю» и «доказано исполнение», а отсутствие отчёта не считается успехом. Сохранить честность сигнала.

Порядок задач по цене владельцу: **B1–B3** (один строгий dsh boundary и тесты), затем **D1/L1/L3** (смысл и сохранность человеческой приёмки), **D4/D5/D2** (скрытые расхождения), **T1/T3/T4** (зелёные проверки должны означать реальное поведение), затем **D3/D8/P1–P3** по замерам. Удаления X1/X2 и imports T6 — последняя короткая волна, не главный результат аудита.

## Проверки и предел доказательств

- Первый `pnpm test`: core/CLI прошли; plugin — unresolved `core/dist` в build suite плюс watcher flake `A` вместо `A2`. Лог `/tmp/orch-s10-test.log`. Это не скрыто повторным запуском.
- `pnpm --filter @dsh-orchestra/core build` — exit 0, только generated output.
- Повторный **`pnpm test` — exit 0: 99 файлов, 471 тест** (core 34/174, CLI 8/18, plugin 57/279). Лог `/tmp/orch-s10-test2.log`.
- **`pnpm typecheck` — exit 0**, все три пакета. Лог `/tmp/orch-s10-typecheck.log`.
- Build suite собрал plugin/ELK/supervisors и проверил запуск supervisor fixture. Отдельный полный `pnpm build` не требовался и не выдаётся за выполненный.
- `git diff --check` — чисто; `git status --short` — только `?? docs/notes/2026-09-23-codebase-audit.md`.
- Изменён только этот note; исходники/tests/планы не правились. Live dsh, paid workers, network requests и browser production profile не запускались. Предсказанные значения помечены отдельно от измерений.
