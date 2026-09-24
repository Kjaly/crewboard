export type MessageLang = 'en' | 'ru'
export type MessageVars = Record<string, string | number>

/**
 * Launch and preflight text shared by the CLI and the dsh host. Errors keep their vars, so a caller in
 * another language can render the same refusal again (`orchText(lang, error.code, error.vars)`).
 * `{prog}` is the command name; without one it is the product's.
 */
const en: Record<string, string> = {
  unknown_task: 'No task {id}.',
  no_runs: 'Task {id} has not been run yet.',
  decision: 'This is a human decision: close it with {prog} accept.',
  running: 'The task is already running: {run}.',
  blocked: 'The task is waiting for: {deps}.',
  accepted: 'The task is already accepted.',
  superseded: 'The task was superseded by another variant.',
  no_contract: 'No contract: pass --contract or run {prog} task set <id> --contract <file>.',
  contract_missing: 'Contract not found: {path}',
  prepare: 'Worktree preparation failed: {error}\n{output}',
  baseline: 'The baseline run is red — the task is not sent to a worker.\n{step}\n{output}',
  preflight: 'Preflight for {agent} failed — the launch is cancelled.',
  no_profile: 'no profile',
  no_worktree: 'Task {id} has no worktree.',
  unknown_file: 'The file was not changed in the task: {file}',
  'preflight.notFound': 'not found',
  'preflight.installClaude': 'install Claude Code',
  'preflight.versionUnknown': 'could not determine the Claude Code version (model {model})',
  'preflight.versionOk': 'Claude Code {version} meets {minimum} required by {model}',
  'preflight.versionOld': 'Claude Code {version} is older than {minimum} required by {model}',
  'preflight.updateClaude': 'update the CLI (claude update)',
  'preflight.loggedIn': 'logged in',
  'preflight.loggedOut': 'not logged in',
  'preflight.quotaUnknown': 'quota unknown',
  'preflight.quotaUsed': '{used}% used',
  'preflight.quotaFix': 'wait for the quota reset or pick another worker',
  'preflight.opencodeFix': 'brew install opencode (version ≥ {minimum} needed)',
  'preflight.providerConnected': 'provider {name} connected',
  'preflight.providerMissing': 'provider {name} not connected',
  'preflight.probeOk': 'the model answered',
  'preflight.probeFailed': 'the model did not answer',
  'preflight.probeFix': 'check the provider key and balance',
  'preflight.acpOk': 'the acp profile builds',
  'preflight.acpFailed': 'profile error',
  'preflight.unsupported': 'backend {backend} is not supported',
  'refresh.step': 'update the copy to {base}',
  'refresh.local': 'The copy has uncommitted changes — left as is: {paths}',
  'refresh.untracked': 'The incoming commits would overwrite untracked files in the copy — left as is: {paths}',
  'refresh.conflict': 'Merging {base} into the copy conflicts — the merge is undone, the copy is left as is.\n{output}',
  'refresh.more': '{paths} and {count} more',
}

const ru: Record<string, string> = {
  unknown_task: 'Нет задачи {id}.',
  no_runs: 'У задачи {id} ещё не было запусков.',
  decision: 'Это решение человека: закрывается через {prog} accept.',
  running: 'Задача уже выполняется: {run}.',
  blocked: 'Задача ждёт: {deps}.',
  accepted: 'Задача уже принята.',
  superseded: 'Задача вытеснена другим вариантом.',
  no_contract: 'Нет контракта: укажи --contract или {prog} task set <id> --contract <файл>.',
  contract_missing: 'Контракт не найден: {path}',
  prepare: 'Подготовка worktree упала: {error}\n{output}',
  baseline: 'Базовый прогон красный — задача не уходит воркеру.\n{step}\n{output}',
  preflight: 'Preflight для {agent} не пройден — запуск отменён.',
  no_profile: 'нет профиля',
  no_worktree: 'У задачи {id} нет worktree.',
  unknown_file: 'Файл не изменён в задаче: {file}',
  'preflight.notFound': 'не найден',
  'preflight.installClaude': 'установить Claude Code',
  'preflight.versionUnknown': 'не удалось определить версию Claude Code (модель {model})',
  'preflight.versionOk': 'Claude Code {version} — не ниже {minimum}, нужной модели {model}',
  'preflight.versionOld': 'Claude Code {version} старее {minimum}, требуемой моделью {model}',
  'preflight.updateClaude': 'обновить CLI (claude update)',
  'preflight.loggedIn': 'вход выполнен',
  'preflight.loggedOut': 'не залогинен',
  'preflight.quotaUnknown': 'квота неизвестна',
  'preflight.quotaUsed': 'использовано {used}%',
  'preflight.quotaFix': 'дождаться сброса квоты или выбрать другого воркера',
  'preflight.opencodeFix': 'brew install opencode (нужна версия ≥ {minimum})',
  'preflight.providerConnected': 'провайдер {name} подключён',
  'preflight.providerMissing': 'провайдер {name} не подключён',
  'preflight.probeOk': 'модель ответила',
  'preflight.probeFailed': 'модель не ответила',
  'preflight.probeFix': 'проверить ключ и баланс провайдера',
  'preflight.acpOk': 'профиль acp собирается',
  'preflight.acpFailed': 'ошибка профиля',
  'preflight.unsupported': 'бэкенд {backend} не поддерживается',
  'refresh.step': 'обновление копии до {base}',
  'refresh.local': 'В копии есть незакоммиченные изменения — оставлена как есть: {paths}',
  'refresh.untracked': 'Входящие коммиты перезаписали бы неотслеживаемые файлы копии — оставлена как есть: {paths}',
  'refresh.conflict': 'Слияние {base} в копию даёт конфликт — слияние отменено, копия оставлена как есть.\n{output}',
  'refresh.more': '{paths} и ещё {count}',
}

export const hasOrchText = (key: string): boolean => key in en

export function orchText(lang: MessageLang | undefined, key: string, vars: MessageVars = {}): string {
  const all: MessageVars = { prog: 'crewboard', ...vars }
  return ((lang === 'ru' ? ru[key] : undefined) ?? en[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (all[name] === undefined ? m : String(all[name])))
}
