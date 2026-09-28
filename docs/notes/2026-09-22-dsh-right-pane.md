# dsh 0.1.5: как плагин живёт в правой панели (research к задаче 2k/1)

Установленный dsh: `/Users/kjaly/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
(в тексте ниже `DSH` = этот каталог; `~/.dsh/profiles/web/node_modules` — установленные плагины профиля).

Правило заметки: **каждое утверждение подписано доказательством** — путь к `.d.ts` или номер строки в бандле
`lib/client.js`. Где доказать не удалось — так и написано («не доказано»).

## Коротко для задачи 3

Плагин в правой панели — это **две стадии**:

1. **Тип** (что вкладка есть) кладётся в реестр `ctx.sidebarRightTabs.register(definition)`.
   У страничного типа (нашего) нет `patterns`/`canOpen`; его открывают по `kind`, адрес `sidebar://<kind>`
   панель составляет сама.
2. **Тело и живой заголовок** кладутся в keyed-слоты `sidebar.right.pane.tab` и `sidebar.right.pane.tab.title`
   через `slots.inject(slot, () => slots.register({ name: slot, key: <definition.id> }, Компонент))`.

`key` — это **`definition.id`** (идентификатор реализации), а не `kind`: место отрисовки ищет запись слота по
`entryKey: definition?.id ?? tab.kind` (`DSH/dsh-client-ui-sidebar-right/lib/client.js:737`).

Сессию вкладка получает **не из `tabInfo()`**, а как обычный проп сессионного слота (`sessionId` +
`useSessions`); cwd берётся как `useSessions((s) => s.byId[sessionId]?.cwd)`.

## Q1. Регистрация типа вкладки: точная форма, `key`, реестр, адреса

### Объявление слотов

`DSH/dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts`:

- `sidebar.right.pane.tab` (строки 26–31): `kind: 'keyed'`, `scope: 'session'`, `hookContext: TabHookContext`,
  `inject: SidebarRightTabInjected`.
- `sidebar.right.pane.tab.title` (строки 40–45): то же самое; «тип с живым заголовком регистрируется здесь…
  без регистрации чип показывает `title(address)`, снятый при открытии».

То есть форма `slots.register` для обоих слотов — `slots.register({ name: '<слот>', key: '<id>', ... }, Компонент)`.

### Что такое `key` (доказано кодом)

`DSH/dsh-client-ui-sidebar-right/lib/client.js:716-740` — `TabSlot`: `entryKey: definition?.id ?? tab.kind`.
Значит keyed-слот ищет нашу запись по `id` из определения типа. Все готовые регистрации это подтверждают:

- `DSH/dsh-client-ui-sidebar-files/lib/client.js:701-711`: `key: FILES_ID` для тела и заголовка; `FILES_ID`
  из `lib/types/client/definition.d.ts` («This implementation's identity in the tab system, and the key its
  body registers under»).
- `DSH/dsh-client-ui-sidebar-documentpreview/lib/client.js:26946-26964`: `key: TEXTPREVIEW_ID`.
- `DSH/dsh-client-ui-sidebar-right/lib/client.js:3749-3762`: встроенный guide — `key: GUIDE_ID`.

Рядом с `key` регистрация может нести `locale`, `store`, `children`, `inject` (files `client.js:701-707`,
documentpreview `client.js:26946-26960`) — это необязательные поля Slot-стандарта, для заглушки не нужны.

### Реестр `SidebarRightTabRegistry`

`DSH/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`:

- `SidebarRightTabDefinition` (строка 68): `id` (уникален), `kind` (дискриминатор), `patterns?` (глобы),
  `priority?` (`extension | builtin | fallback`, строка 43), `canOpen?`, `title(address)`, `guide?`.
- `register(definition): () => void` (строка 153); «a second registration in the same band, or any registration
  meeting a `fallback` of the same kind, is a wiring mistake, and so is an `id` already in use».
- `candidates(address)` (строка 184) — ранжирование: полоса приоритета → длина совпавшего глоба → порядок
  регистрации; `canOpen` может ветировать (комментарий строки 179–180).
- `claim(address, kind?)` (строка 198): без `kind` — лучший кандидат; с `kind` — тип берёт адрес, если его
  `canOpen` согласен, глобы не смотрятся.

Реализация: `DSH/dsh-client-ui-sidebar-right/lib/client.js:3355-3383` (проверка `ids`/`kinds`, `coexists`),
`3445-3461` (`candidates`), `3475-3493` (`claim`).

**Следствие для нас:** страничный тип (не viewer) объявляет **без** `patterns` и `canOpen` — ровно как
`files` («The type is a page, not a viewer: it claims no address», `files/lib/types/client/definition.d.ts`)
и guide (`right/lib/client.js:3584-3591`).

### Адреса

- Ресурс: `dsh-resource://<type>/…` — `DSH/dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:109`
  («a `dsh-resource://<type>/…` address»); конкретика файлов —
  `dsh-context/lib/client.js:5788-5848` (`dsh-resource://file/session/<sessionId>/<path>`).
- Страница: `sidebar://<kind>` — `.../contract/seed.d.ts` (`pageAddress`) и бандл
  `DSH/dsh-client-ui-sidebar-right/lib/client.js:242-250`; «a caller names the kind and never sees or composes
  the address». Поэтому нам `patterns` не нужны: `openTab(kind)` сам соберёт `sidebar://dsh-orchestra`.

## Q2. Как вкладка открывается, что показывает чип, переживает ли смену сессии

### Программно

- `ctx.sidebarRight.openTab(kind, options?)` — `service.d.ts:71-77` (`ISidebarRight.openTab`), реализация
  `right/lib/client.js:1231-1234` (`placeTab`), `1276-1285` (адрес `pageAddress(kind)` + `definition.title`).
- `openResource(address, options?)` — `service.d.ts:64-69`; внутри вкладки её собственные действия:
  `tab.actions.openTab(...)` / `tab.actions.openResource(...)` — `contract/slots.d.ts:96-115`.
- `openTabIn(sessionId, kind)` / `openResourceIn` — `service.d.ts:99-107`, для действий вкладки в своей сессии.

`openTab` **раскрывает колонку в том же действии**: `openContent` начинается с
`planSetExpanded(state, true)` (`right/lib/client.js:501`); то же обещает комментарий `service.d.ts`
(«The column expands in the same step»).

### Руками

- Капсула на странице guide: `tab.actions.openTab(entry.kind, { replaceTab: true })`
  (`right/lib/client.js:181`) — открывает тип вместо guide.
- Кнопка «плюс» в полосе вкладок открывает guide: `addTab: (paneId) => openTab(GUIDE_KIND, { paneId,
  revealIfOpened: false })` (`right/lib/client.js:678-682`).
- Страничная вкладка уникальна в панели: `contentId === pageAddress(kind)` — `right/lib/client.js:506-521`
  (`revealIfOpened: false` для страниц). Значит повторный `openTab` фокусирует уже открытую вкладку.

### Чип

- Начальный текст — `definition.title(address)`, снятый при открытии (`tab-registry.d.ts:102-107`;
  бандл `right/lib/client.js:321-329`, `seedRecord`).
- Если тип зарегистрировал `sidebar.right.pane.tab.title`, чип рисует живой компонент
  (`contract/slots.d.ts:40-45`, бандл `right/lib/client.js:762-770`). Без него — снятый текст.

### Смена сессии

Хранилище панели — `SidebarRightState.bySession` (`stores.d.ts`), по одному экземпляру на сессию; runtime
панели раздаёт store по session-scope (`stores.d.ts` комментарий, `service.d.ts` разд. «adoption»).
Вкладка принадлежит поверхности своей сессии и не переезжает в чужую; при возврате в сессию её layout
берётся из того же `bySession`. **Не доказано** отдельным тестом dsh: что запись не вычищается при
переключении — но ни в `stores.d.ts`, ни в бандле нет удаления по сессии, только `closeTab` по явному
действию (`right/lib/client.js:534-550`).

## Q3. Что вкладка знает о сессии и как получить cwd

`SidebarRightTabInfo` (`contract/slots.d.ts:117-139`) **не содержит `sessionId`**: внутри `sidebar`
(expanded/fullscreen), `panel.id`, `tab` (record + `visible`, `navigation`, `signal`, `actions`).
`tabInfoFactory` подставляет только `standard.sessionId` в замыкание (`right/lib/client.js:3601-3614`) —
сам хук отдаёт уже перечисленное.

Сессия приходит как стандартный проп сессионного слота:

- `DSH/dsh-client-ui-session/lib/types/client/index.d.ts:34-48`: `GlobalStandardProps.useSessions:
  UseSessions`, `SessionStandardProps.sessionId: SessionId`, `useSession`, `useProjection`.
- `DSH/dsh-client-ui-session/lib/types/client/index.d.ts:7`: `UseSessions = SnapshotSelectorHook<SessionListState>`.
- `DSH/dsh-api-session-controller/lib/types/client/sessions/service.d.ts:61-66`: `SessionListState.byId:
  Record<SessionId, SessionSummary>`; `32-38`: `SessionSummary.cwd?: string`.

Канонический способ (готовый плагин, не догадка): `files`, `FilesBody.d.ts:24-25` —
`FilesBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & ...`, а тело деструктурирует
`{ useTabInfo, sessionId, useSessions, ... }` и читает
`const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd)`
(`DSH/dsh-client-ui-sidebar-files/lib/client.js:418-421`). Если cwd нет — панель показывает
состояние «no-workspace» (там же, 436-442).

`dsh-context` подтверждает тот же набор пропов словами: «the `sidebar.right.pane.tab` seat is
session-scoped and delivers the same framework standard kit (`sessionId`, `useProjection`, `useChat`,
the locale `t` seat)» (`~/.dsh/profiles/web/node_modules/dsh-context/lib/client.js:10763-10766`).

Итог для нас: `tabInfo()` — про вкладку (id, navigation, signal, actions), а `sessionId`/`cwd` — через
пропы слот-рантайма. Рабочая папка = `useSessions(...).byId[sessionId].cwd`; ничего своего изобретать не надо.

## Q4. Из вкладки на наш `main` и обратно в сессию

- Наш большой экран — keyed-слот `main` (`DSH/dsh-client-ui-layout/lib/types/client/index.d.ts:44-51`:
  «Central panel selected by sidebar entry id… other keys receive no Session binding»). Мы уже регистрируем
  его как `slots.register({ name: 'main', key: PANEL_ID }, OrchestraPanel)` (`packages/plugin/src/client/index.tsx:20`).
- `ctx.layout.selectPanel(panelId)` — `DSH/dsh-client-ui-layout/lib/types/client/service.d.ts:24-30`:
  «Select a global central panel without changing the current Session… `null` to show the Conversation…
  @throws if the selected main key is not registered». Тип `MainPanelId` — брендированная строка (строка 15);
  на рантайме достаточно нашего `PANEL_ID`.
- Обратно: `ctx.uiWorkspace.openSession(sessionId)` — `DSH/dsh-client-ui-workspace/lib/types/client/navigation.d.ts:8-13`
  (`UiWorkspace.openSession`): «Select a Session and show its Conversation as one UI navigation action».
  Доступ — `ctx.uiWorkspace` (declare module, там же строки 63-68). Сессию для возврата берём из пропа
  `sessionId`/привязки плана (задача 4).

## Q5. Примеры среди установленных плагинов

| Плагин | Что делает | Доказательство |
| --- | --- | --- |
| `dsh-client-ui-sidebar-files` | page-тип `files`: реестр `ctx.sidebarRightTabs.register(filesDefinition(t))` + оба keyed-слота под `FILES_ID` | `DSH/.../dsh-client-ui-sidebar-files/lib/client.js:681-711`; типы `lib/types/client/definition.d.ts`, `FilesBody.d.ts`, `FilesTitle.d.ts` |
| `dsh-client-ui-sidebar-documentpreview` | `fallback`-viewer `text` с `patterns`/`canOpen`; те же два слота под `TEXTPREVIEW_ID`; дочерний keyed-слот `sidebar.right.tab.document` | `.../lib/client.js:26920-26964`; `lib/types/client/definition.d.ts`; `TextPreview.d.ts:16`, `TextTitle.d.ts:13` |
| `dsh-client-ui-sidebar-right` | сам хост слотов: регистрирует guide через тот же публичный двухстадийный путь | `.../lib/client.js:3704-3762` |
| `dsh-context` (сторонний) | **лучший пример для нас**: опциональный `sidebarRightTabs` через отложенный `ctx.inject([...])`, регистрация типа, тела с `locale`, живого заголовка; kind неймспейсится (`dsh-context`), чтобы не столкнуться с чужим `context` | `~/.dsh/profiles/web/node_modules/dsh-context/lib/client.js:10759-10851` |
| `dsh-bill` (сторонний) | правой панелью **не пользуется**: `inject: ['slots']`, регистрирует `conversation.composer.dock`, `conversation.chat.turnTail`, `sidebar.footer.action`, `conversation.view`, `settings.section` | `~/.dsh/profiles/web/node_modules/dsh-bill/lib/client.js:2290-2390`; `package.json` `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-conversation"]` |

## Наша минимальная регистрация (что уже лежит в плагине)

- `packages/plugin/src/client/right-pane.tsx` — стадия 1 (тип `dsh-orchestra` / kind `dsh-orchestra`,
  заголовок «Оркестрация», guide-капсула) + стадия 2 (оба keyed-слота с `key: dsh-orchestra`); тело-заглушка
  «Панель появится в задаче 2».
- `packages/plugin/src/client/index.tsx` — вызов `registerRightPaneTab(ctx, slots)` **после** существующих
  трёх слотов. Флаг доступности — наличие `ctx.sidebarRightTabs`: её нет → ничего не регистрируем, плагин
  остаётся загружаемым на старых линиях dsh (по образцу `dsh-context/lib/client.js:10773-10780`).
  Отложенный `ctx.inject(['sidebarRightTabs'], …)` — API cordis:
  `DSH/cordis/lib/types/registry.d.ts:104-111` («Run a callback once the requested services are available…
  unloaded and re-run whenever a required service changes»); `ctx.get(name)` вернёт `undefined`, если сервис
  ещё не предоставлен — `DSH/cordis/lib/types/reflect.d.ts:10-16`.
- `hard inject` остаётся `['slots']` — как требует существующий `test/client-apply.test.ts:18`.
- Тест `packages/plugin/test/client/right-pane.test.tsx`.

## Чего доказать не удалось

- Пакет `@deepseek-ai/dsh-client-ui-slots` **не лежит на диске** (в `DSH` его нет; в `client/dsh.ts` это
  отмечено). Поэтому `PropsRuntime`, `SlotHookFactory`, `BoundActions`, точная форма `SlotMap` и сигнатура
  `slots.register` не прочитаны из его `.d.ts`. Они выведены из: (а) declaration-merge в
  `dsh-client-ui-session/lib/types/client/index.d.ts:34-57`; (б) использований в чужих `.d.ts`
  (`FilesBody.d.ts`, `TextPreview.d.ts`, `TextTitle.d.ts`); (в) вызовов в бандлах. Наши локальные типы
  описаны структурно и намеренно узко.
- `@deepseek-ai/dsh-client-ui-dockkit` тоже не на диске: `TabId`, `TabRecord`, `PaneId` известны только по
  ре-экспорту `dsh-client-ui-sidebar-right/lib/types/client/index.d.ts` и по использованию в бандле.
- Поведение «вкладка переживает смену сессии» проверено по коду (`bySession`, отсутствие удаления), но не
  живым прогоном dsh.
- Реальный вызов `ctx.inject` с поздним появлением сервиса не проверялся в рантайме dsh; проверена форма
  вызова и то, что наш `apply` без сервиса не падает.
