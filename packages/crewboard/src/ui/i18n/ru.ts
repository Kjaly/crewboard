import type { Doing, ProviderId, RequestAction, Status, SystemText } from '../../model/types.js'

/** Every visible string of the screen in Russian. The English dictionary (en.ts) has the same shape. */
export const ru = {
  locale: 'ru-RU',
  switchLang: 'Switch to English',
  langCode: 'EN',
  meInitial: 'Я',
  event: {
    goal_started: 'Цель поставлена',
    assigned: 'Поручено',
    run_started: 'Исполнитель начал работу',
    question: (t: string) => `Вопрос: ${t}`,
    escalated: (why: string) => `Ведущий передал вопрос вам: ${why}`,
    answeredByYou: (t: string) => `Вы ответили: ${t}`,
    answeredByLead: (t: string) => `Ведущий ответил: ${t}`,
    steered: (t: string) => `Уточнение: ${t}`,
    reported: (t: string) => `Итог: ${t}`,
    returned: (t: string) => `Возвращено: ${t}`,
    failed: (t: string) => `Запуск упал: ${t}`,
    closed: (t: string) => `Закрыто: ${t}`,
    cancelled: (t: string) => `Отменено: ${t}`,
    ownerRequested: (t: string) => `Вы попросили: ${t}`,
    requestAccepted: 'Ведущий принял',
    requestDeclined: (reason: string) => `Ведущий отклонил: ${reason}`,
    requestSucceeded: 'Выполнено',
    requestFailed: (reason: string) => `Не удалось: ${reason}`,
    requestWithdrawn: 'Вы отозвали просьбу',
    reassigned: (from: string, to: string, model: string) => `Передача: ${from} → ${to} · ${model}`,
    adopted: 'Цель подхватил новый ведущий',
  },
  doing: (d: Doing): string => {
    switch (d.kind) {
      case 'text': return d.text
      case 'done': return 'Готово'
      case 'cancelled': return `Отменено: ${d.code ? ru.system(d.code, d.detail) : d.reason}`.trim()
      case 'system': return ru.system(d.code, d.detail)
      case 'abandoned': return 'Без ведущего: владелец больше не ведёт эту работу'
      case 'paused': return 'На паузе: ведущий не на связи'
      case 'waiting_owner': return 'Ждёт вашего ответа'
      case 'returned': return `Возвращено: ${d.note}`
      case 'asking': return `Спрашивает: ${d.text}`
      case 'after': return `Начнёт после: ${d.titles.join(', ')}`
      case 'queued': return 'В очереди'
      case 'leading': return 'Ведущий ведёт цель'
      case 'failed': return `Запуск упал: ${d.reason ?? 'причина неизвестна'}`
      case 'reported': return 'Доложил итог, ждёт решения'
      case 'reported_to_parent': return 'Доложено, проверит родитель'
      case 'working': return 'Работает'
      case 'children': return `Ждёт свои поручения: ${d.done} из ${d.total} готовы`
    }
  },
  system: (code: SystemText, detail = ''): string => {
    switch (code) {
      case 'emergency_stop': return 'аварийная остановка владельцем'
      case 'owner_stop': return 'остановлено по просьбе владельца'
      case 'run_failed': return `запуск упал: ${detail || 'причина неизвестна'}`
      case 'parent_cancelled': return `отменена ветка выше: ${detail}`
      case 'no_report': return 'Исполнитель завершил работу без итога'
      case 'split': return 'Работа разделена на части'
      case 'split_truncated': return `Разбиение урезано, отброшено частей сверх предела: ${detail}`
      case 'split_registry': return `Метки агентов в разбиении не учтены, реестр агентов не читается: ${detail}`
      case 'launch_registry': return `Работа в очереди ждёт исправления реестра агентов: ${detail}`
      case 'goal_idle': return 'Вся работа сделана, ждём итога ведущего'
      case 'blocked_dependency': return `Зависимость ${detail} отменена; отмените поручение или запустите его сейчас`
      case 'worktree_setup': return `Готовлю рабочую копию: ${detail}`
    }
  },
  appTitle: 'Crewboard',
  tabs: { settings: 'Настройки', now: 'Сейчас', history: 'История', analytics: 'Аналитика', soon: 'Появится в следующем обновлении' },
  summary: 'Сводка',
  noData: 'нет данных',
  bySubscription: 'по подписке',
  analyticsHint: 'Для разбора после работы: кто был загружен, что шло параллельно, сколько это стоило.',
  analyticsEmpty: 'Запусков пока не было.',
  costsByProvider: 'Расходы по провайдерам',
  costsByModel: 'Расходы по моделям',
  costsByAssignment: 'Затраты по поручениям',
  costCols: { who: 'Провайдер', model: 'Модель', what: 'Поручение', runs: 'Запуски', money: 'Деньги', api: 'По ценам API', tokens: 'Токены: вход / выход' },
  you: 'Вы',
  openInHistory: 'Открыть в истории',
  historyUnavailable: 'Полный разговор недоступен: транскрипт ведущего не найден.',
  historyFromJournal: 'Разговор ведущего недоступен: показан ход работы из журнала Crewboard.',
  historyTruncated: 'Показана последняя часть длинного разговора.',
  historySession: (when: string) => `Разговор с ведущим · ${when}`,
  actionsCount: (n: number) => `${n} ${plural(n, 'действие', 'действия', 'действий')}`,
  historyTool: { start_goal: 'Цель поставлена', adopt_goal: 'Цель подхвачена', close: 'Работа закрыта', cancel: 'Работа отменена', escalate: 'Вопрос передан вам', answer: 'Ответ исполнителю', steer: 'Уточнение исполнителю', return: 'Работа возвращена', decide_request: 'Решение по вашей просьбе', status: 'Ведущий посмотрел дерево', inbox: 'Ведущий прочитал входящие' },
  sidebar: 'Проекты и цели',
  goalsButton: 'Цели',
  waitingN: (n: number) => `${n} ${plural(n, 'ждёт', 'ждут', 'ждут')} вас`,
  goalNoWork: 'нет поручений',
  goalWaitsLead: 'ждёт ведущего',
  goalPaused: 'на паузе: ведущий не на связи',
  today: 'сегодня',
  yesterday: 'вчера',
  waitingYou: (n: number) => `${n} ${plural(n, 'ждёт', 'ждут', 'ждут')} вас`,
  waitingLead: (n: number) => `${n} ${plural(n, 'ждёт', 'ждут', 'ждут')} ведущего`,
  running: (n: number) => `${n} ${plural(n, 'идёт', 'идут', 'идут')}`,
  queued: (n: number) => `${n} в очереди`,
  finished: (n: number) => `${n} ${plural(n, 'завершено', 'завершено', 'завершено')}`,
  askButtonLabel: (n: number) => `Ждут вас: ${n}`,
  askButton: 'Ждёт вас',
  theme: 'Сменить тему',
  offline: 'Нет связи с сервером. Переподключаюсь…',
  loading: 'Загружаю…',
  loadFailed: 'Не удалось загрузить данные.',
  retry: 'Повторить',
  announceQuestion: (title: string) => `${title}: новый вопрос к вам`,
  announceRequestDeclined: 'Ведущий отклонил просьбу',
  announceRequestFailed: 'Не удалось выполнить просьбу',
  announceFinished: (title: string) => `${title}: завершено`,
  projects: 'Проекты',
  goals: 'Цели',
  tree: 'Поручения',
  context: 'Контекст поручения',
  external: {
    kind: { workflow: 'Workflow', agent: 'Субагент', delegate: 'Делегирование', other: 'Внешний запуск' },
    source: 'Источник',
    id: 'Внешний ID',
    phase: 'Фаза / роль',
    stale: 'Данные устарели',
    outcome: { success: 'Успешно', failure: 'Не удалось' },
    controls: 'Crewboard не управляет этим запуском: уточнение, передача и аварийная остановка недоступны. Обсудите изменения с ведущим.',
    tracked: 'Внешний запуск добавлен',
  },
  finishedGroup: (n: number) => `Завершено ${n}`,
  usage: {
    title: 'Провайдеры',
    window: (minutes: number) => (minutes === 300 ? '5 часов' : minutes === 10080 ? 'Неделя' : minutes % 1440 === 0 ? `${minutes / 1440} дн.` : `${Math.round(minutes / 60)} ч`),
    used: (pct: number) => `использовано ${pct}%`,
    resets: (when: string) => `до ${when}`,
    credits: (n: string) => `${n} кредитов`,
    asOf: (when: string) => `данные на ${when}`,
    exhausted: 'Лимит исчерпан',
    hint: {
      claude_statusline: 'Нет данных: войдите в Claude Code или подключите crewboard statusline',
      codex_no_sessions: 'Нет данных: Codex ещё не запускался',
      DEEPSEEK_API_KEY: 'Баланс: задайте DEEPSEEK_API_KEY',
      MOONSHOT_API_KEY: 'Баланс: задайте MOONSHOT_API_KEY',
      key_refused: 'Ключ отклонён',
      timeout: 'Провайдер не ответил',
      network: 'Нет связи с провайдером',
      unreadable: 'Не удалось прочитать ответ',
    } as Record<string, string>,
    httpError: (code: string) => `Ошибка провайдера (${code.replace('http_', 'HTTP ')})`,
  },
  close: 'Закрыть',
  origin: 'Откуда взялось',
  originExternal: 'Ведущий запустил эту работу вне Crewboard и отмечает её здесь.',
  originByWorker: 'Исполнитель сам выделил эту часть работы.',
  criteria: 'Критерии готовности',
  result: 'Итог',
  schemaError: 'Ошибка схемы',
  inside: 'Поручения внутри',
  history: 'История',
  workdir: 'Рабочая папка',
  assignedBy: 'Поручил',
  lead: 'Ведущий',
  emptyTitle: 'Подключите ведущего',
  emptyText: 'Целей пока нет. Подключите Crewboard к своему основному агентному чату — Claude Code, Codex, dsh или любому MCP-клиенту — и попросите его поставить цель.',
  connectWith: 'Клиент ведущего',
  workersTitle: 'Исполнители',
  workerReady: 'готов',
  workerNotReady: 'не готов:',
  connectClient: { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', other: 'Другой клиент' } as Record<'claude' | 'codex' | 'dsh' | 'other', string>,
  connectHint: {
    claude: 'Выполните в терминале:',
    codex: 'Выполните в терминале:',
    dsh: 'Добавьте в профиль dsh (модуль @deepseek-ai/dsh-mcp-client):',
    other: 'Адрес MCP-сервера, Streamable HTTP:',
  } as Record<'claude' | 'codex' | 'dsh' | 'other', string>,
  copy: 'Скопировать',
  copied: 'Скопировано',
  question: { via: 'Ведущий не смог решить сам', own: 'Свой ответ', send: 'Ответить', placeholder: 'Напишите ответ исполнителю', failed: 'Ответ не отправлен. Попробуйте ещё раз.', conflict: 'На вопрос уже ответили. Ваш текст сохранён.', optionHint: 'Нажатие сразу отправит ответ' },
  status: { queued: 'В очереди', running: 'Идёт', waiting_answer: 'Ждёт ведущего', waiting_owner: 'Ждёт вас', reported: 'Доложено', done: 'Готово', cancelled: 'Отменено', abandoned: 'Без ведущего', paused: 'На паузе' } satisfies Record<Status, string>,
  actionTitle: {
    clarify: 'Уточнить задачу', stop: 'Остановить', handoff: 'Передать другому агенту', start_now: 'Начать раньше', cancel: 'Отменить', reopen: 'Переоткрыть', revive: 'Вернуть в работу', discuss: 'Обсудить в чате ведущего',
  } satisfies Record<RequestAction, string>,
  actionEffect: {
    clarify: 'Указание исполнителю по ходу работы', stop: 'Это поручение и всё, что под ним', handoff: 'Текущий запуск остановится, выбранный исполнитель продолжит в той же рабочей папке', start_now: 'Поручение уйдёт в работу вне очереди', cancel: 'Поручение не будет выполнено', reopen: 'Готовое поручение вернётся в работу', revive: 'Отменённое поручение вернётся в работу', discuss: 'Скопирует сообщение для ведущего',
  } satisfies Record<RequestAction, string>,
  handoffQueuedEffect: 'Выбранный исполнитель начнёт поручение, когда подойдёт очередь',
  discussNotified: 'Ведущий уведомлён',
  discussManual: 'Буфер обмена недоступен. Скопируйте сообщение вручную',
  discussMessage: 'Сообщение для ведущего',
  askLead: 'Попросить ведущего',
  askLeadInfoLabel: 'Как работают просьбы',
  askLeadInfo: 'Это не команды, а просьбы. Ведущий решает каждую и объясняет решение, ответ появится здесь.',
  actionPlaceholder: 'Например: не трогай release.yml, проверь только CI',
  actionSendHint: 'отправить',
  actionSendLead: 'Отправить ведущему',
  handoffSend: 'Попросить передать',
  modelAndEffort: 'Модель и уровень размышления',
  modelLabel: 'Модель',
  catalogDiscovered: 'найдена',
  catalogSuggested: 'подсказка',
  catalogNotListed: 'нет в каталоге',
  catalogSearch: 'Поиск моделей',
  catalogRefresh: 'Обновить',
  catalogLoading: 'Загрузка…',
  catalogFailed: 'Не удалось загрузить каталог. Попробуйте обновить.',
  catalogEmpty: 'Модели не найдены',
  catalogPriceUnit: '/ 1 млн токенов',
  catalogPriceHint: 'Доллары за миллион токенов: вход / выход',
  otherModel: 'Другая модель',
  defaultTag: 'по умолчанию',
  defaultModel: 'Модель по умолчанию',
  resetDefaults: 'Сбросить',
  resetDefaultsLabel: 'Вернуть модель и уровень размышления по умолчанию',
  effortLabel: 'Уровень размышления',
  effortDefault: 'По умолчанию',
  settings: {
    hint: 'Умолчания применяются к будущим запускам. Начатые запуски сохраняют свою модель и уровень размышления.',
    agents: 'Агенты', presets: 'Пресеты', agent: 'Агент', enabled: 'Включён', disabled: 'выключен',
    agentDefault: 'Умолчание агента', note: 'Заметка ведущему',
    access: 'Доступ', accessSandbox: 'Песочница', accessNetwork: 'Песочница + сеть', accessFull: 'Без песочницы',
    accessHint: 'Насколько Codex-воркер выходит за свою папку. Сеть позволяет ставить пакеты и обращаться к локальным серверам; без песочницы снимаются все ограничения. Ответы и решения остаются только для чтения.', presetName: 'Имя нового пресета', addPreset: 'Добавить пресет',
    presetsHint: 'Именованный выбор агента, модели и уровня размышления для ведущего. Выключенный пресет недоступен для назначения.',
    save: 'Сохранить', saving: 'Сохраняю…', saved: 'Настройки сохранены.', reload: 'Перечитать',
    conflict: 'Файл изменился на диске. Настройки перечитаны; внесите изменения заново.',
    failed: 'Не удалось сохранить или загрузить настройки.', retryCatalog: 'Повторить загрузку моделей',
  },
  effortUnset: 'по умолчанию',
  effortNone: 'Уровень размышления не задаётся: агент работает с настройками модели',
  effort: { none: 'Без размышлений', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный' } as Record<string, string>,
  holdStopLabel: 'Аварийная остановка: удерживайте',
  holdStopHint: 'Удерживайте 1 с (или Space/Enter)',
  holdStopBranch: 'Остановится вся ветка, без решения ведущего',
  holdStopping: 'Останавливаю…',
  holdStopped: 'Остановлено',
  holdStoppedHint: 'Ветка остановлена, ведущий получит событие',
  actionVerb: {
    clarify: 'уточнить', stop: 'остановить', handoff: 'передать другому', start_now: 'начать раньше', cancel: 'отменить', reopen: 'переоткрыть', revive: 'вернуть в работу', discuss: 'обсудить',
  } satisfies Record<RequestAction, string>,
  emergencyStop: 'Аварийная остановка',
  leadAwayHint: 'Ведущий не на связи. Вернитесь в чат ведущего, чтобы продолжить разговор.',
  actions: 'Действия',
  actionText: 'Что передать ведущему',
  actionSend: 'Отправить',
  handoffTo: 'Кому передать',
  handoffCurrent: 'сейчас',
  handoffSame: 'Выберите другую модель или уровень размышления',
  requestOffline: 'Просьба сохранена, ведущий не на связи',
  withdrawRequest: 'Отозвать просьбу',
  withdrawConflict: 'Просьба уже решена или отозвана. Состояние обновлено.',
  requestPending: (verb: string) => `Запрошено: ${verb}. Ведущий решает`,
  requestDeclined: (reason: string) => `Ведущий против: ${reason}`,
  requestFailed: 'Просьба не отправлена. Попробуйте ещё раз.',
  requestConflict: 'У поручения уже есть просьба в работе. Ваш текст сохранён.',
  stopConflict: 'Состояние ветки изменилось. Остановка не подтверждена.',
  refreshFailed: 'Отправлено, но экран не обновился. Обновите страницу; повторно отправлять не нужно.',
  discussCopied: 'Скопировано',
  discussPrompt: (title: string, goalId: string, id: string) => `Обсудим поручение «${title}» (${goalId}/${id}): `,
  feed: {
    loadFailed: 'Не удалось загрузить шаги ленты.',
    label: 'Лента работы',
    expand: 'Развернуть ленту',
    collapse: 'Свернуть ленту',
    steps: (n: number) => `${n} ${plural(n, 'шаг', 'шага', 'шагов')}`,
    silent: (min: number) => `Нет новых событий ${min} мин`,
    context: (pct: number) => `Контекст занят на ${pct}%`,
    fold: {
      commands: (n: number) => `${n} ${plural(n, 'команда', 'команды', 'команд')}`,
      files: (n: number) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`,
      tools: (n: number) => `${n} ${plural(n, 'вызов инструмента', 'вызова инструмента', 'вызовов инструментов')}`,
    },
    allSteps: 'Все шаги',
    newSteps: 'Новые шаги',
    waiting: 'Ждём первый шаг…',
    units: { ms: 'мс', s: 'с', min: 'мин' },
    stepStatus: { running: 'идёт', done: 'готово', failed: 'не удалось' },
  },
  provider: { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', lead: 'Ведущий' } satisfies Record<ProviderId | 'lead', string>,
}

export type Strings = typeof ru

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
