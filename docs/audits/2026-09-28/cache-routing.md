# Cache-aware маршрутизация: Flash, prompt cache и кандидат Jev — 2026-09-28

- **Дата аудита:** 2026-09-28. Ветка `orch/cache-policy-28-study-cache-aware-flash-and-jev-routing`.
- **Область:** prompt/KV cache у OpenAI, DeepSeek и Gemini; экономика cache-read/cache-write; отличать кэш от истории/compaction и от retrieval memory; cache-aware политика маршрутизации Crewboard; Jev как typed classifier/scorer/router; дизайн 3-arm pilot.
- **Режим:** read-only исследование. Продуктовый код, планы/статусы, пресеты/настройки моделей, плагины и конфигурация не менялись. Изменён только этот файл; `git add`/`git commit` не выполнялись.
- **Ownership:** только `docs/audits/2026-09-28/cache-routing.md`. Соседний аудитор проверяет accounting; его файлы не трогались.
- **Результат:** `Result: received` — сравнение методов, политика и дизайн pilot готовы. Живых вызовов Jev и новых провайдеров не делалось.

## 1. Как читать и происхождение источников

- **Факт Crewboard** — подтверждено кодом/докой этого репозитория, рядом `file:line`.
- **Проверенный первоисточник** — утверждение, которое оркестратор независимо сверил 2026-09-28 и передал в контексте. Оно не перепроверялось этим воркером.
- **Механика (сверить)** — устойчивое описание принципа работы, которое здесь не подтверждено построчно; не использовать как числовой факт без сверки.
- **Гипотеза/дизайн** — предложение к измерению, не измеренный результат.

**Проверка доступа к web.** В песочнице воркера `web_fetch` для всех перечисленных хостов недоступен: DNS резолвится в non-public IP (`developers.openai.com`, `api-docs.deepseek.com`, `ai.google.dev`, `typesafe.ai`, `api.typesafe.ai`, `arxiv.org`, `raw.githubusercontent.com`). `web_search` вернул только сторонние зеркала/новости, которые не являются первичными источниками. Поэтому страницы лично не загружались, и ниже нет утверждения об independently fetched. Прямые ссылки:

- OpenAI prompt caching — <https://developers.openai.com/api/docs/guides/prompt-caching>
- DeepSeek KV cache — <https://api-docs.deepseek.com/guides/kv_cache/>
- Gemini caching — <https://ai.google.dev/gemini-api/docs/caching>
- TypeSafe Jev announcement (2026-09-15) — <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- Jev API (Swagger) — <https://api.typesafe.ai/docs>
- routing paper — <https://arxiv.org/abs/2609.28919>
- cache evaluation — <https://arxiv.org/abs/2601.06007>

**Статус каждого источника именно здесь:**

| Источник | Что подтверждено | Что здесь не подтверждено |
| --- | --- | --- |
| OpenAI prompt caching | GPT-5.6+: cache read = 0.1x uncached rate, cache write = 1.25x, не складываются (у сегмента одна ставка); cached tokens всё равно считаются в TPM; `reasoning.effort` может менять инструкции модели, а supported configuration update может сохранить ранний prefix; compaction может снизить переиспользование, но всё равно снизить суммарный input; session continuity сама по себе не гарантирует hits; API-поведение не доказывает экономию квоты Codex subscription | Точные TTL, минимальный размер, инкремент prefix, поведение по моделям/датам |
| DeepSeek kv_cache | Поисковый сниппет: disk caching по умолчанию, поля `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` | Полная страница (у оркестратора retrieval error) — TTL, минимум, гранулярность, цены |
| Gemini caching | Implicit caching defaults; минимальные размеры prefix зависят от модели; поведение специфично для API | Точные TTL/цены/модели explicit cache |
| TypeSafe Jev | 2026-09-15: typed решения score/choice/yes-no, без генерации строк; claimed calibrated confidence и cost/speed | Это **vendor claims**, не независимый результат Crewboard; схема API, auth, latency, retention |
| arxiv 2609.28919 | URL передан как методологический контекст | Abstract лично не загружался |
| arxiv 2601.06007 | URL передан как методологический контекст | Abstract лично не загружался |

**Внешние vendor-заявления не являются доказательством.** «Кратный выигрыш», «zero hallucinations», «calibrated confidence» — маркетинговые утверждения до независимой проверки на Crewboard-fixtures. В дизайне pilot они трактуются как гипотезы.

## 2. Три разных слоя, которые нельзя смешивать

| Слой | Что это | Где живёт | Кто управляет | Роль в экономике |
| --- | --- | --- | --- | --- |
| **История/compaction** | Накопленная переписка оркестратора, её суммаризация/обрезка | dsh chat session, привязанная к плану | dsh harness (не Crewboard) | Определяет **какой prefix** уйдёт в следующий запрос. Compaction переписывает середину prefix. |
| **Server KV / prompt cache** | Провайдерский кэш вычисленного префикса; hit даёт cache-read токены | У провайдера (OpenAI/DeepSeek/Gemini/…) | Провайдер; модель и аккаунт — scope | Определяет **цену** повторного префикса. Не хранит фактов и не является источником истины. |
| **Retrieval memory** | Durable plan/evidence/receipts, читаемые по запросу | `.orchestration/`, `evidence.json`, git | Crewboard (`orchestra_plan`, `orchestra_task`) | Даёт **актуальные факты** just-in-time. Это не cache и не может быть заменён «тёплой» историей. |

Практические следствия:

- Prompt cache **не** отменяет retrieval: `prompt.ts:16` — «the plan is the source of truth»; `prompts-routing.md:58` фиксирует context rot от старых снимков `orchestra_task`/`orchestra_plan` в истории. Тёплая сессия не гарантирует hit (проверено оркестратором) и не гарантирует свежесть.
- Compaction и cache — разные вещи: compaction может снизить cache reuse (переписанный префикс), но всё равно снизить общий input cost (проверено оркестратором). Оценивать надо оба эффекта, а не только hit rate.
- История растёт у оркестратора, но worker-контекст обычно свежий: Crewboard запускает воркер на задачу, а не ведёт с ним многодневный чат.

## 3. Как работает prefix reuse и чем методы различаются

### 3.1. Условие переиспользования

Кэш провайдера сопоставляет **точный префикс** запроса. Если изменился токен на позиции N, то переиспользуется только часть до N, а всё после N вычисляется заново (это механика, сверить на странице). Отсюда:

- стабильные и одинаковые в каждом запросе части (system prompt, описания инструментов, worker rules, контракт задачи) должны идти **первыми**;
- всё per-run (id запуска, дата, предыдущий отчёт, note, send-back) — **после** стабильной части.

Crewboard уже следует этому для worker-промпта: `launch.ts:165-187` задаёт порядок `WORKER_RULES` → `contract` → `runContext`/`send_back`, и `review.md:183` прямо называет это cache-friendly. Для оркестратора устойчивая часть — `ORCHESTRA_PROMPT` (`prompt.ts:12-27`, section order 900) плюс рендер инструментов, дальше — briefing и wake-сообщения (`chat.ts`).

### 3.2. Сравнение методов

| | OpenAI (GPT-5.6+) | DeepSeek (kv_cache) | Gemini API |
| --- | --- | --- | --- |
| Активация | Автоматический prefix cache (механика, сверить) | Автоматический disk cache по умолчанию (сниппет) | Interactions API: implicit; explicit cache — отдельный generateContent API, не Interactions |
| Порог/минимум | Ниже порога провайдер не кэширует; конкретный порог — по модели (сверить) | Минимум и гранулярность — не подтверждены здесь (сверить) | Минимальные размеры prefix зависят от модели — подтверждено |
| TTL | Короткое окно, есть extended retention; конкретика — сверить | Провайдер-управляемый, не гарантирован (сверить) | Явный TTL у explicit cache; implicit — провайдер-управляемый |
| Scope | Модель + аккаунт (сверить) | Модель (сверить) | Модель; поведение специфично для API |
| Цена | read 0.1x, write 1.25x, у сегмента одна ставка, не складываются; **подтверждено** | cache-hit/cache-miss токены; hit дешевле (сверить числа) | Оплата cache/storage отдельно (сверить) |
| Инвалидация | Любой более ранний токен: system, tools/их порядок, изображения, compaction | То же | То же |

Что здесь **не** утверждается: конкретные TTL в минутах/часах, минимальные размеры в токенах и точные цены DeepSeek/Gemini. Их нельзя брать из этого документа как факт — только со страницы провайдера.

### 3.3. Что обнуляет выгоду

1. **Правка стабильного промпта/правил.** Изменение `WORKER_RULES` или `ORCHESTRA_PROMPT` сдвигает весь suffix.
2. **Правка tools: состав, порядок, описания.** Описания инструментов обычно идут в начале запроса; `tools.*` — часть prefix. Перестановка/переименование инструмента или правка одного описания делает холодным всё после него. В Crewboard описания `orchestra_*` берутся из `i18n.ts` (`prompts-routing.md:38`, D3) — их правка cache-значима.
3. **Compaction/briefing в середине префикса.** Переписанная история ломает reuse после точки правки; новый briefing при resumе, наоборот, может быть коротким.
4. **Разный набор/порядок контента между запусками.** Per-run данные впереди стабильных — типичная ошибка; в Crewboard порядок уже правильный, его надо удержать.
5. **Смена модели/аккаунта/провайдера.** Scope кэша — модель (и, вероятно, аккаунт); cache не переносится.

### 3.4. Про `reasoning.effort` — без переобобщения

Нельзя утверждать, что смена reasoning effort **всегда** cold-start'ит cache. Проверенное утверждение: `reasoning.effort` может менять инструкции модели; supported configuration update может сохранить более ранний prefix. Поэтому:

- в Crewboard effort — это **отдельный worker id** (`workers.md:147-151`), а не параметр одного и того же запуска; смена effort меняет worker, но не обязательно ломает prefix;
- dsh, devin, cursor и gemini effort не принимают вовсе (`workers.md:139`);
- правильная формулировка для политики: «effort — cache-значимый фактор, который надо измерять, а не предполагать».

### 3.5. Почему компактный новый worker-контекст может быть выгоднее «тёплого»

Cache read дешевле input, но не бесплатен; cache write дороже input; cached tokens всё равно считаются в TPM (подтверждено для OpenAI). Поэтому большой тёплый префикс окупается только при достаточном числе повторных обращений. Условная арифметика только входа на in-repo ставках `codex-pricing.ts:9-16` (`gpt-6-sol`: input $2/1M, cacheRead $0.2/1M = 0.1x; write 1.25x → $2.5/1M по подтверждённой пропорции OpenAI) для 10 запросов, где первый создаёт cache, а остальные девять читают его; output, качество и накладные расходы здесь исключены:

- без кэша, prefix 20k: 10 × 20k × $2/1M = **$0.40**;
- кэш: первый write 20k × $2.5/1M = $0.05 + 9 reads × 20k × $0.2/1M = $0.036 → **$0.086**;
- свежий компактный контекст 3k каждый ход, без кэша: 10 × 3k × $2/1M = **$0.06**.

Это **синтетическая иллюстрация**, не замер, без output-токенов. Вывод: компактный fresh-context worker может быть дешевле даже тёплой сессии, если исходный контекст раздут. Отсюда политика «дешёвые свежие контексты» не противоречит cache-политике — их надо сравнивать по полной стоимости задачи (все попытки + ревью), а не по cache hit rate.

## 4. Jev: что это и где границы

**Подтверждено оркестратором по описанию провайдера:** Jev — typed classifier/scorer/router: решения вида score/choice/yes-no, **без генерации строк**; заявлены calibrated confidence и низкие cost/speed (vendor claims). Он может оценивать узкие вопросы, но не генерирует код и не заменяет исполняемые проверки или доказательства Git/receipts.

**Подходящие узкие задачи (advisory only):**

- routing: предложить класс/тир worker'а для задачи (низкий риск → Flash, высокий → сильный worker);
- relevance scoring: ранжировать/отсеять evidence и контекст для retrieval, чтобы уменьшить prefix (осторожно: усечение контекста само по себе cache-значимо);
- escalation: сигнал «пора к сильному worker'у или человеку» по признакам провала/неуверенности;
- triage: yes/no «нужен ли человек», «это блокер или вопрос» — но только как рекомендация.

**Что должно остаться детерминированным кодом (Jev не заменяет):**

- проверки состояния и receipt'ов: совпадение HEAD/commit, revision контракта, worktree clean, конфликты (`auto-close.ts:24-48`);
- исполнение `<checks>` и их записи (`checks-run.ts`), attestation/freshness (`attestation.ts`, `auto-close.ts:52-67`);
- граф зависимостей плана, verdict parsing, cash/estimate reconciliation;
- авторизация worker'а по пресету (`authority.ts:7-10,77-81`).

**Пороги уверенности.** Confidence нельзя использовать как gate без: (а) калибровки на held-out fixtures (reliability/ECE/Brier, abstain-rate), (б) **shadow mode** — сначала только логировать решение и сравнивать с фактическим, (в) явного `abstain` при низкой уверенности с безопасным дефолтом (решает preset/человек). Jev **не может** принимать/мержить или обходить core gates: `automaticAcceptance` и `assertAutomaticMerge` остаются единственным путём, а `<human_review>`, decision, root, disputed и failures — для человека (`auto-close.ts:38-39`, `prompt.ts:25`).

**Чего не изобретать до интеграции:** поля схемы Jev, auth, лимиты, latency, retention, поведение на длинных traces. Рендер Swagger у оркестратора был пуст; в этом аудите нет ни одного вызова Jev.

## 5. Cache-aware политика для Crewboard

1. **Sticky orchestrator session.** Держать привязанную dsh-сессию стабильной: не пересоздавать её без причины, не менять порядок section'ов и описаний инструментов, стабильную часть — первой. Каждый wake должен **читать** актуальный plan/task (`orchestra_task`), а не доверять истории. Session continuity не гарантирует cache hit; retrieval — гарантия факта, не cache.
2. **Дешёвые fresh-context workers по классу и риску.** `code`/`research` низкого риска с узким контрактом и зелёными checks — на `dsh/deepseek-flash` (API, cash из dsh-bill). `design`, всё рискованное и спорное — сильнее. Свежий worktree/промпт — это новый prefix; не пытаться «прогревать» одноразовый worker, а держать его промпт компактным и стабильным.
3. **Escalation на границах task/subagent/session.** Эскалировать: (а) до старта задачи — при высоком риске/неясности; (б) на границе subagent'а/делегирования — если подзадача выходит за узкий контракт или возвращает низкую уверенность; (в) между попытками — после исчерпания дешёвого бюджета или при `Result: blocked`/провале checks; (г) на ревью — сильный независимый reviewer для задач выше порога; (д) на границе сессии/смены scope. Не подменять worker молча в середине запуска.
4. **Stronger independent review where needed.** Review — отдельный класс и отдельный worker (`workers.md:158-168`); author ≠ reviewer. Cache-экономия не отменяет независимое ревью и не переносится на него.
5. **Retry budgets.** Ограничить: 1 дешёвая попытка + 1 повтор, затем эскалация; повтор одинакового провала не ретраить слепо (ср. `prompts-routing.md:231`); send-back/continue несёт причину в следующий запуск (`launch.ts:339-341`, `relaunch.ts`). Stale attestation и dirty copy не «перезапускаются» в обход повторного review.
6. **Гейты неприкосновенны.** Ни Flash, ни Jev не принимают/мержат и не обходят `automaticAcceptance`/`assertAutomaticMerge`; auto-close остаётся только для routine по существующим правилам.
7. **Измерять полную стоимость задачи.** Сравнивать методы по «per-accepted-task», а не по цене одного вызова: включать повторные попытки, ревью и orchestration-токены. Missing billing показывать как unknown, не как 0 (`costs.md:19-23`).

## 6. 3-arm pilot

**Цель:** проверить, снижает ли cache-aware связка «дешёвый Flash + сильное ревью» полную стоимость принятой задачи без регресса качества/безопасности, и можно ли доверять Jev как shadow-router на безопасных границах.

**Только synthetic/redacted fixtures. Никаких API-вызовов Jev и новых провайдеров, никаких новых плагинов.** Pilot — дизайн; в рамках аудита он не запускался.

| Arm | Маршрутизация | Ревью | Jev |
| --- | --- | --- | --- |
| **A — current** | Текущий preset/класс как настроено; sticky orchestrator | Как сейчас | Нет |
| **B — Flash + strong review** | Подходящие задачи → `dsh/deepseek-flash`; рискованные → сильный worker | Обязательное независимое сильное ревью каждой принятой задачи | Нет |
| **C — Jev shadow** | Решает preset/человек; Jev только рекомендует маршрут/эскалацию/релевантность | Как в A | Только shadow-логирование рекомендаций |

**Fixtures.** Одинаковые для всех arm: семейство из `prompts-routing.md` §4-5 (A→B stale receipt, routine positive, `<human_review>`, decision, injection из отчёта, dirty copy/incomplete, preflight fail, resume со stale-историей) плюс cache-специфичные: (i) правка tools/порядка → cold prefix; (ii) длинный trace для классификатора; (iii) низкая уверенность/abstain; (iv) неверный дешёвый маршрут; (v) отсутствующий billing; (vi) унаследованный устаревший контекст. N≥20 на вариант, фиксированные seeds (методика — `prompts-routing.md:89,193`).

**Метрики на принятую задачу:**

| Метрика | Определение | Источник в Crewboard |
| --- | --- | --- |
| Total cost | cash (API) **или** api-equivalent (subscription), никогда не сумма; missing — unknown | `cost.ts`, `run-usage.ts`, `dsh-bill.ts`, `claude-transcripts.ts`, `codex-pricing.ts` |
| Latency | wall time от старта задачи до accept | runs/ledger |
| Tokens | input / output / cacheRead / cacheWrite / reasoning | `Tokens` (`cost.ts:6`) |
| Retries | число попыток на принятую задачу | `task.runs`, attempt triggers |
| Cache ratio | cacheRead / (input + cacheRead), cacheWrite отдельно; с пометкой availability | `cost.ts`, `cli-backend.ts` |
| Quality | доля return/rework; дефекты, найденные ревью; post-merge дефекты | verdict, review |
| Safety invariants | 0 stale accept/merge, 0 обхода human gates, 0 forbidden tool calls, 0 вне-пресетных запусков, 0 Jev-инициированных мутаций | `auto-close.ts`, `attestation.ts`, `authority.ts` |

**Failure cases:**

| Случай | Как проявляется | Ожидаемая обработка |
| --- | --- | --- |
| Cache rebuild | cacheRead ≈ 0 после правки tools/порядка/compaction, скачок цены | Считать cost-событием; проверить состав запроса; не списывать на модель |
| Classifier overhead на длинном trace | рост latency/цены Jev с размером trace | Ограничить вход, отдавать сжатую/отобранную retrieval-выборку; иначе не использовать |
| Low confidence | низкий score/abstain | Безопасный дефолт: preset или человек; не угадывать |
| Wrong cheap routing | Flash-запуск повторно валит checks | После бюджета — эскалация на сильного; **не** ослаблять checks |
| Missing billing | cash/estimate отсутствует/pending | Исключить задачу из cost-рейтинга; unknown ≠ 0 (`costs.md:19-23`) |
| Inherited stale context | действие по старому плану/отчёту | Read-before-write после каждого wake; stale контекст отбросить |

**Анализ.** Сравнивать по per-accepted-task; отдельно считать coverage billing. API-экономия не переносится на Codex subscription quota (`workers.md`, `costs.md`) — вывод об экономии квоты из API-поведения не делать.

## 7. Rollback и условия эскалации

**Немедленный откат arm (hard):** любое нарушение safety invariant — stale accept/merge, обход `<human_review>`/decision/negative, вне-пресетный запуск, Jev-инициированная мутация.

**Откат/остановка по метрикам (после pre-registered N):**

- quality: доля rework/post-merge дефектов хуже baseline на заданный margin;
- cost: полная стоимость принятой задачи **не** ниже baseline при достаточном billing coverage;
- latency: p95 time-to-accept регрессирует сверх margin;
- cache: cacheRead-ratio стабильного контента ≈ 0 или высокий rebuild rate — сначала чинить состав запроса;
- billing coverage ниже порога → результат inconclusive, promotion запрещён.

**Jev:** остаётся только в shadow, пока не пройдена калибровка (ECE/Brier, abstain); любое «wrong cheap routing» сверх порога → отключить advisory и вернуться к preset. Promotion допустим только до advisory на безопасных границах; никогда — до gate.

**Границы контроля:**

| Уровень | Что контролирует |
| --- | --- |
| **Crewboard** | класс/пресет/fallback и авторизация worker'а (`authority.ts`); контракт, `<checks>`, `<human_review>`; попытки/continue/send-back; `WORKER_RULES` и порядок промпта (`launch.ts:165-187`); review-worker; worktree/continue; receipts/attestation/auto-close; поля стоимости cash/estimate и cacheRead/cacheWrite; `crewboard slot`; retrieval-tools |
| **dsh / Codex harness** | сборка запроса (порядок system prompt section'ов, рендер tool schemas), история чата и compaction, жизненный цикл/resume сессии, ACP-сессия, записи dsh-bill, чтение Codex quota |
| **Провайдер** | TTL/минимум/eviction/keying/scope кэша, цены, учёт cached tokens в TPM, политика cache write |

Из этого следует: cache-aware политику можно менять в Crewboard (порядок, состав, маршрут, бюджеты), но hit/TTL/цену определяет провайдер, а сборку запроса и compaction — harness. Обещать «cache-aware экономию» на уровне продукта без замера нельзя.

## 8. Concrete observation: cache этого Codex-чата (aggregate-only)

**Provenance.** Оркестратор передал **только агрегаты** (без содержимого сообщений) этого Codex-чата в redacted summary. Прочитан ровно один aggregate-файл — `/tmp/crewboard-orchestrator-usage-summary.json`; raw-путь остаётся приватным и в отчёт не переносится. Область — только этот thread; никакие другие (чужие/приватные) транскрипты не открывались. Значения ниже — как сообщены, без пересчёта в деньги.

**Сообщённые агрегаты:**

| Поле | Значение |
| --- | --- |
| usageSnapshots | 1713 |
| Последний snapshot: model | `gpt-6-sol` |
| Последний snapshot: contextWindow | 828 400 |
| Последний snapshot: `input_tokens` | 577 976 |
| — из них `cached_input_tokens` | 577 280 |
| — некэшированный input | 696 |
| Последний snapshot: `output_tokens` | 1 263 |
| — из них `reasoning_output_tokens` | 1 166 |
| Последний snapshot: `cache_write_input_tokens` | 0 |
| `total` в окне 3 последних snapshot: `input_tokens` | ≈464.0m → 465.2m |
| `total`: `cached_input_tokens` | ≈457.6m → 458.8m |
| `total`: `cache_write_input_tokens` | 0 |
| `total`: `output_tokens` / `reasoning_output_tokens` | ≈442k–444k / ≈178k–179k |

**Производная арифметика (не счёт):**

- доля cache read последнего запроса: 577 280 / 577 976 = **99.88 %** (uncached 696 токенов);
- повторяющийся контекст занимает ≈578k из 828k окна (**≈69.8 %**);
- кумулятивная доля cached: 458 757 248 / 465 190 118 ≈ **98.62 %**.

**Чего с этими числами делать нельзя:** умножать 465m на ставку последней модели; суммировать все cumulative snapshot'ы; трактовать total как уникальный размер контекста или как cash-счёт. Total накоплен за много ходов и смен моделей. TPM при этом не обнуляется: cached tokens всё равно считаются (проверено для OpenAI), тёплый кэш снижает цену, а не давление на лимит. Это Codex-чат; поведение API-кэша **не** доказывает экономию квоты Codex subscription.

**Что это подтверждает.** Наблюдён именно тот режим, ради которого существует §3: очень большой повторяющийся контекст и очень высокая доля cache read сосуществуют. Это поддерживает sticky-prefix стратегию §5.1 и снимает сомнение «высокий hit rate на большом контексте реалистичен». Это **не** доказывает, что Arm B (свежий компактный Flash) дешевле или дороже: сравнение требует per-accepted-task суммарных значений по попыткам и ревью, которых в этом aggregate нет.

**Оценка `cache_write_input_tokens = 0`: provider-observed или adapter/default?**

- Во всех сообщённых snapshot'ах, включая крупные, поле равно ровно 0, тогда как cached read растёт до сотен миллионов. «Всегда ровно 0» — сигнатура default/отсутствующего поля, а не наблюдаемой провайдером картины, где запись иногда происходит.
- Стандартная OpenAI-подобная usage-форма даёт input и `cached_tokens` (read); отдельной категории cache-write токенов в ней нет (механика, сверить на странице). Значит, ненулевое write-поле неоткуда взять, а 0 может быть нормализацией.
- Код Crewboard нормализует отсутствие в 0: `num()` возвращает 0 для не-числа/отсутствия (`cli-parse.ts:35`); Codex-парсер пишет `cacheWrite: num(u.cache_write_input_tokens)` (`cli-parse.ts:307`); runner инициализирует `cacheWriteTokens: 0` и суммирует (`cli-runner.ts:765,774`); backend всегда возвращает число и помечает cacheWrite как `known` уже при `calls > 0` (`cli-backend.ts:159-174`). Ветка `unavailable` в `cost.ts:83` для `cacheWriteTokens === undefined` на этом пути недостижима, поэтому наружу выходит **known 0**.
- **Вердикт:** как provider-observed это **не подтверждается**. Наблюдение наиболее совместимо с adapter/default missing semantics (отсутствие → 0), а даже буквальный провайдерский 0 означал бы «нет отдельной биллинговой категории записи», а не «записи не происходили». `cache_write = 0` надо трактовать как **provenance-unknown**, не как измеренный ноль и не как нулевую стоимость записи.
- **Следствие для pilot'а:** в метрике cacheWrite хранить provenance (явное поле провайдера против нормализованного дефолта); «known 0» из дефолта нельзя сравнивать с провайдерским счётчиком записи; failure case «missing billing» явно включает cacheWrite. Это согласуется с темой соседнего accounting-аудита про unobserved-vs-known-zero.

**Ограничения этого наблюдения:** один thread, одна модель (`gpt-6-sol`), raw payload здесь не инспектируется; контракт провайдера по write-полю не утверждается; цены не считаются; на другие модели/провайдеры не обобщается.

## Проверки

- `test -s docs/audits/2026-09-28/cache-routing.md` — файл непустой.
- `git diff --check` — пробельных ошибок в отслеживаемых изменениях нет (файл новый/untracked, проверка не покрывает его содержимое; отдельно проверены trailing whitespace и финальный newline).

## Ограничения

- Первоисточники лично не загружались: `web_fetch` в песочнице недоступен (DNS → non-public IP). Числа OpenAI/Gemini — из проверенного контекста оркестратора; DeepSeek полная страница не подтверждена.
- Живых прогонов модели, замеров cache hit, latency, токенов и стоимости не было; pilot — дизайн, а не результат.
- Jev не вызывался; его схема/auth/latency/cost/retention неизвестны. Vendor claims не проверены.
- Стоимость-арифметика в §3.5 синтетическая, на in-repo ставках, без output-токенов.
- Продуктовый код, планы, пресеты и настройки моделей не менялись; чужие файлы не трогались.
