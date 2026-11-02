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
    adopted: 'Цель подхватил новый ведущий',
  },
  doing: (d: Doing): string => {
    switch (d.kind) {
      case 'text': return d.text
      case 'done': return 'Готово'
      case 'cancelled': return `Отменено: ${d.code ? ru.system(d.code, d.detail) : d.reason}`.trim()
      case 'system': return ru.system(d.code, d.detail)
      case 'abandoned': return 'Брошено: владелец больше не ведёт эту работу'
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
    }
  },
  appTitle: 'Crewboard',
  tabs: { now: 'Сейчас', history: 'История', analytics: 'Аналитика', soon: 'Появится в следующем обновлении' },
  summary: 'Сводка',
  noData: 'нет данных',
  bySubscription: 'по подписке',
  analyticsHint: 'Для разбора после работы: кто был загружен, что шло параллельно, сколько это стоило.',
  analyticsEmpty: 'Запусков пока не было.',
  costsByProvider: 'Затраты по провайдерам',
  costsByAssignment: 'Затраты по поручениям',
  costCols: { who: 'Провайдер', what: 'Поручение', runs: 'Запуски', money: 'Деньги', api: 'По ценам API', tokens: 'Токены: вход / выход' },
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
  inWork: (n: number) => `${n} в работе`,
  allFinished: 'всё завершено',
  leadAway: 'ведущий не на связи',
  waitingYou: (n: number) => `${n} ждёт вас`,
  waitingLead: (n: number) => `${n} ${plural(n, 'ждёт', 'ждут', 'ждут')} ведущего`,
  running: (n: number) => `${n} ${plural(n, 'идёт', 'идут', 'идут')}`,
  queued: (n: number) => `${n} в очереди`,
  finished: (n: number) => `${n} ${plural(n, 'завершено', 'завершено', 'завершено')}`,
  askButton: 'Ждёт вас',
  theme: 'Сменить тему',
  offline: 'Нет связи с сервером. Переподключаюсь…',
  loading: 'Загружаю…',
  projects: 'Проекты',
  goals: 'Цели',
  tree: 'Поручения',
  context: 'Контекст поручения',
  finishedGroup: (n: number) => `Завершено ${n}`,
  close: 'Закрыть',
  origin: 'Откуда взялось',
  originByWorker: 'Исполнитель сам выделил эту часть работы.',
  criteria: 'Критерии готовности',
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
  question: { via: 'Ведущий не смог решить сам', own: 'Свой ответ', send: 'Ответить', placeholder: 'Напишите ответ исполнителю', failed: 'Ответ не отправлен. Проверьте связь и попробуйте ещё раз.' },
  status: { queued: 'В очереди', running: 'Идёт', waiting_answer: 'Ждёт ведущего', waiting_owner: 'Ждёт вас', reported: 'Доложено', done: 'Готово', cancelled: 'Отменено', abandoned: 'Брошено', paused: 'На паузе' } satisfies Record<Status, string>,
  action: {
    clarify: 'Уточнить', stop: 'Остановить', handoff: 'Передать', start_now: 'Начать раньше', cancel: 'Отменить', reopen: 'Переоткрыть', revive: 'Вернуть в работу', discuss: 'Обсудить с ведущим',
  } satisfies Record<RequestAction, string>,
  actionVerb: {
    clarify: 'уточнить', stop: 'остановить', handoff: 'передать другому', start_now: 'начать раньше', cancel: 'отменить', reopen: 'переоткрыть', revive: 'вернуть в работу', discuss: 'обсудить',
  } satisfies Record<RequestAction, string>,
  emergencyStop: 'Аварийная остановка',
  emergencyConfirm: 'Точно остановить сейчас',
  emergencyHint: 'Остановка сработает сразу, в обход ведущего. Ведущий узнает о ней из входящих.',
  leadAwayHint: 'Ведущий не на связи: ответа на просьбу может не быть, есть аварийная остановка.',
  actions: 'Действия',
  actionText: 'Что передать ведущему',
  actionSend: 'Отправить',
  handoffTo: 'Кому передать',
  requestPending: (verb: string) => `Запрошено: ${verb}. Ведущий решает`,
  requestDeclined: (reason: string) => `Ведущий против: ${reason}`,
  requestFailed: 'Просьба не отправлена. Проверьте связь и попробуйте ещё раз.',
  discussCopied: 'Реплика для ведущего скопирована',
  discussPrompt: (title: string, goalId: string, id: string) => `Обсудим поручение «${title}» (${goalId}/${id}): `,
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
