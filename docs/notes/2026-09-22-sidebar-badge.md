# dsh 0.1.5: отметка внимания у сессии в sidebar

Установленный dsh: `/Users/kjaly/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` (ниже `DSH`).
Профильные плагины: `~/.dsh/profiles/web/node_modules`.

Правило: каждое утверждение привязано к доказательству (путь и строки либо диапазон строк). Если файлы не дают ответа, явно сказано «не доказано».

## Вывод

Установленный sidebar не предоставляет плагину отдельного слота или callback для декорации строки конкретной сессии. `sidebar.workspaces` заменяет всю область просмотра рабочих пространств и сессий одним root-компонентом; `sidebar.panellist` выводит иконки глобальных панелей. В строке сессии dsh уже показывает статусы своих доменов (ожидающее UI-взаимодействие, выполнение, завершившийся вне выбранной сессии запуск), но нет признака «получено сообщение». Поэтому не доказано, что waker prompt даст плану отметку бесплатно.

## 1. Какие места sidebar может занять плагин

| Слот | Контракт и рендер | Что может вывести | Отношение к строкам сессии |
| --- | --- | --- | --- |
| `sidebar.panellist` | `kind: 'list'`, `scope: 'root'`, владелец даёт лишь `size` и `active` (`DSH/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:39-43,86-92`). Shell создаёт кнопку глобальной панели и рендерит занятый слот внутри места под glyph; label берёт из metadata (`DSH/dsh-client-ui-sidebar/lib/client.js:110-130`). Записи собираются по `id/order/label` и сортируются по `order` (`.../lib/client.js:344-361`). | Иконку панели, активное/неактивное состояние через `active`; само имя панели — metadata label. Наша текущая запись `dsh-orchestra` с `order: 100` — именно такая иконка, не строка сессии (`packages/plugin/src/client/index.tsx:20`). | Глобальный список панелей, один ряд на панель. Нет `sessionId` в owner props (`slots.d.ts:86-100`). Показать счётчик можно только как собственную подпись/иконку панели, если её renderer это нарисует; привязать значение к конкретной сессии этим слотом нечем. |
| `sidebar.workspaces` | `kind: 'single'`, `scope: 'root'`; это вся область от заголовка секции и поиска до сгруппированного/плоского списка и диалогов (`DSH/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:44-53`). Shell рендерит единственный occupant между панелями и подвалом (`.../lib/client.js:283-291`). Рабочая область регистрирует туда `WorkspaceBrowser` (`DSH/dsh-client-ui-workspace/lib/client.js:2794-2803`). | Один компонент всей области; props владельца shell — только `wide` и `expandSidebar` (`sidebar/.../slots.d.ts:103-110`). Сам browser получает список сессий и host actions через собственные стандартные/внедрённые props (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:82-145`). | API декорации отдельной строки нет. Чтобы нарисовать собственную точку в строке, пришлось бы владеть/заменить весь browser, воспроизвести его поиск, сортировку, группировку и действия; контракт не описывает совместное оборачивание его строк плагинами (`sidebar/.../slots.d.ts:44-53`; `workspace/.../slots.d.ts:4-9,82-145`). Это не честный малый badge extension. |
| `sidebar.workspaces.directoryFlow` | Дочерний single root-slot для интеракции выбора каталога, с props `open/busy/onPicked/onCancel/onError` (`DSH/dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:32-62`). | UI выбора каталога, не произвольное содержимое списка. | Не session row slot (`.../slots.d.ts:56-62`). |

Session-scoped slots из публичных типов `dsh-client-ui-sidebar`/`dsh-client-ui-workspace` для строки не обнаружены: основной slot sidebar и его дочерний flow имеют `scope: 'root'` (`dsh-client-ui-sidebar/.../slots.d.ts:39-53`; `dsh-client-ui-workspace/.../slots.d.ts:48-62`). Отрицательный поиск по закрытому набору файлов не доказывает отсутствие скрытого/неэкспортированного внутреннего hook: **не доказано**, что такой hook нигде в приложении нет. Для доказательства потребовались бы публичный контракт такого расширения и его render path в shell.

## 2. Что dsh уже отмечает

У каждой модели строки есть `pendingInteraction`, `running`, `completed`, `updatedAt` (`DSH/dsh-client-ui-workspace/lib/types/client/tree.d.ts:22-39`). Комментарий к `completed` точно описывает зелёную точку: запуск завершился, пока сессия не была выбрана, и её ещё не открыли (`tree.d.ts:34-35`). Отображение pending имеет приоритет над своей/дочерней активностью, а завершение даёт done-status (`dsh-client-ui-workspace/lib/types/client/rows/Rows.d.ts:71-73`; `lib/client.js:788-825`). Строка выводит status dot и title как отдельные части (`.../lib/client.js:935-940,992-1000`).

Точки «ожидается действие» не означают любое сообщение. Допустимые видимые pending kinds ровно `approval`, `plan-review`, `question` (`dsh-client-ui-workspace/lib/types/client/tree.d.ts:20-21`; `lib/client.js:410-414`); метки соответственно waiting approval, plan review, waiting answer, и этот статус перебивает running/done (`lib/client.js:788-825`). Источник — отдельный `useSessionPendingInteraction`/`SessionPendingInteractionSnapshot`, отображающий UI-потребителя, ожидающего пользователя (`dsh-client-ui-session/lib/types/client/index.d.ts:12-31,34-40`; `dsh-client-ui-workspace/lib/client.js:1464-1467`).

Наш waker посылает обычный queued prompt через `sessions.prompt({ mode: 'queue', content: [{type:'text', text}] })` (`packages/plugin/src/host/chat.ts:111-113`). Его дословный текст:

```text
[dsh-orchestra] Нужна реакция оркестратора

<taskId> «<title>» — <kind>: <message>

Разбери по протоколу. Для задач, ждущих приёмки: проверь diff и журнал, затем попроси человека принять — сам не принимай.
```

Это шаблон `wakeMessage` (`packages/plugin/src/host/chat.ts:88-97`); фактический prompt может содержать несколько строк задач. Сам факт получения/очереди такого сообщения **не доказан** как причина ни pending-interaction, ни зелёной точки: pending появляется из отдельного session-scoped publisher, а типы не связывают его с `sessions.prompt` (`dsh-client-ui-session/lib/types/client/index.d.ts:29-33,111-117`; `packages/plugin/src/host/chat.ts:111-113`). Зелёная точка относится к завершившемуся запуску, не к входящему сообщению (`workspace/lib/types/client/tree.d.ts:34-35`). Значит waker может получить отметку бесплатно только если сам диалог породит dsh-поддерживаемое ожидающее UI-взаимодействие или запуск завершится при нужных условиях; для обычного queued prompt это **не доказано**.

Порядок тоже не является отдельным unread-механизмом. В режиме «updated» новая/изменившаяся `updatedAt` поднимает сессию вверх; режимы — `manual | updated` (`dsh-client-ui-workspace/lib/types/client/tree.d.ts:40-41`; `lib/client.js:1366-1379`). Это сортировка по активности, не специальная сортировка по непрочитанным сообщениям. Будет ли именно host prompt обновлять значение и поднимать сессию — **не доказано** типами рассмотренных пакетов; нужны реализация `sessions.prompt`/host list projection и наблюдение за обновлением.

Заголовок не становится жирным в исследованной строке: title имеет обычный класс; выделяется фон выбранной строки, статус рисуется рядом (`dsh-client-ui-workspace/lib/client.js:965-1000`; CSS в начале `lib/client.js`, где `.sessionRow`/`.title` не задают жирность). Утверждение о глобальном unread/bold поведении за пределами этого renderer — **не доказано**.

## 3. Ближайшие честные альтернативы и цена

| Вариант | Что честно сообщает | Цена/ограничение | Доказательство |
| --- | --- | --- | --- |
| Счётчик/точка на нашей записи sidebar | «У оркестратора есть ожидающее внимание» в глобальном entry `dsh-orchestra`, не «именно эта чат-сессия непрочитана». У нас уже есть живой label badge у `sidebar.panellist` (`packages/plugin/src/client/index.tsx:20`; `packages/plugin/src/client/notify.tsx:297-301`). | Не стоит рядом с chat row; виден только пока видна панельная полоса, а схлопнутый sidebar показывает только glyph (`dsh-client-ui-sidebar/lib/client.js:123-130`). Текущий badge считает review-waiting на уровне приложения (`notify.tsx:38-39,297-301`), не waker-сообщения конкретного chat. Для waker нужно явно связать источник внимания и счётчик. | Слоты и текущая реализация выше. |
| Toast | «Нужна реакция» кратковременно всплывает, можно открыть связанный экран/план. | Временный сигнал, может исчезнуть до того, как человек увидит; не сохраняет маркер у строки. Уже есть собственный in-app toast, 12 секунд до автоисчезновения (`packages/plugin/src/client/notify.tsx:209-224,244-254`). Host waker отдельно отправляет native notification при включённой настройке (`packages/plugin/src/host/index.ts:43-45`; `host/notify.ts:7-17`). | Текущий код уведомлений. |
| Переименовать сессию | Человек может увидеть явный префикс вроде `[Оркестрация · 2]` в строке. | Меняет пользовательское название, может устареть/засорить его; не сбрасывается как unread при открытии. Rename — явное действие над сессией (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:114-115`); автопереименование при каждом wake API не доказано. | Контракт rename; пригодный автоматический update без вмешательства пользователя не найден. |
| Поднять сессию через порядок | В режиме `updated` активная сессия может оказаться выше, если её `updatedAt` изменится. | Косвенно и зависит от пользовательского режима; не маркирует непрочитанное, может нарушить ожидание порядка. В режиме manual нет такого promotion (`dsh-client-ui-workspace/lib/client.js:1366-1379`). Программного reorder действия сессии в группе требует `workspaceId` и anchor (`workspace/.../slots.d.ts:134-138`); принудительное изменение пользовательского порядка было бы особенно дорогим. | Алгоритм и контракт reorder. |

Рекомендуемая честная трактовка с доступными API: оставить/расширить свой sidebar badge как «есть внимание оркестратора» и сохранить toast/native notification. Не называть это unread конкретной сессии. Это рекомендация, выведенная из размещения слотов и семантики существующего badge (`sidebar/.../slots.d.ts:39-53`; `packages/plugin/src/client/notify.tsx:297-301`).

## 4. Идентификация привязанной сессии

`chats.json` — `Record<string, ChatBinding>`, где `ChatBinding.sessionId: string`; `readChats` читает этот файл из `<root>/.orchestration/chats.json` (`packages/plugin/src/host/chat.ts:7-9,22-24,32-45`). `bindChat` проверяет sessionId через `sessions.inspect`, сохраняет его без преобразования в binding и отправляет туда briefing (`chat.ts:158-168`); waker читает `chats[planId]` и посылает prompt в `binding.sessionId` (`chat.ts:226-238`).

В списке dsh каждая строка имеет `id: SessionId`, а renderer сравнивает `node.id === currentId`, открывает через `onOpen(node.id)` и кладёт `node.id` в drag payload (`DSH/dsh-client-ui-workspace/lib/types/client/tree.d.ts:22-25`; `lib/client.js:935-938,970-978`). `SessionId` — отдельный тип из `@deepseek-ai/dsh-session/types`, используемый workspace API (`dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts:28-29,101-103`). Следовательно, логический ключ сопоставления — `ChatBinding.sessionId` ↔ `SessionNode.id` (`SessionId`), сравнение по строковому значению. Локальное поле — строка, а не импортированный branded `SessionId`; существующая проверка `sessions.inspect` подтверждает принятие host, но compile-time бренд здесь не хранится (`packages/plugin/src/host/chat.ts:8,158-164`).

Фактическое наличие binding-сессии в видимом sidebar зависит от правил списка: blank session скрыта вне выбранной provisional row, archived session исключена (`workspace/lib/types/client/tree.d.ts:95-100`); строка также может находиться в свернутой группе (`tree.d.ts:55-58`). Поэтому badge, даже если бы он был, не гарантировал бы видимую строку.

## Что не доказано и что закроет пробел

- Совместим ли 0.1.5 плагин-декоратор со строкой другого плагина: **не доказано**. Контракты показывают root single `sidebar.workspaces`, но не описывают декоратор строк. Доказательство потребует опубликованного slot/API с session id и render point в `SessionNodeItem`, либо интеграционного примера установленного плагина.
- Учитывает ли host `sessions.prompt` как новую активность/обновляет ли `updatedAt`, и сохраняется ли такая активность при закрытой сессии: **не доказано**. Нужны host implementation соответствующего prompt/list projection и runtime-проверка текущего dsh.
- Создаёт ли конкретный orchestration protocol диалоговое pending interaction `question` при получении wake prompt: **не доказано**. Нужны регистрация домена и вызов pending publisher в этом протоколе; просто текст prompt этого не подтверждает.
- Устанавливает ли приложение unread/bold оформление вне `WorkspaceBrowser` renderer: **не доказано**. В рассмотренном renderer видны status dots и обычный title; для большего вывода нужна проверка UI приложения/runtime.
