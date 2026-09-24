import { useCallback, useRef, useState } from 'react'
import type { ApiResult } from './api.js'
import { t } from './i18n.js'

/** Server error code → dictionary name. The code is the stable key; the words may change. */
const MESSAGE_KEYS: Record<string, string> = {
  declined: 'actions.declined',
  unknown_repo: 'actions.unknownRepo',
  unknown_task: 'actions.unknownTask',
  no_worktree: 'actions.noWorktree',
  running: 'actions.running',
  blocked: 'actions.blocked',
  not_reviewable: 'actions.notReviewable',
  forbidden: 'actions.forbidden',
  draft_invalid: 'panel.draft.error.invalid',
  not_found: 'panel.draft.error.notFound',
  backend_unavailable: 'actions.backendUnavailable',
  legacy_run_read_only: 'actions.legacyReadOnly',
  plan_incompatible: 'panel.planError.incompatible',
  repo_not_absolute: 'side.addRepo.error.notAbsolute',
  repo_not_found: 'side.addRepo.error.notFound',
  repo_not_directory: 'side.addRepo.error.notDirectory',
  repo_not_git: 'side.addRepo.error.notGit',
  repo_already_listed: 'side.addRepo.error.alreadyListed',
  repo_not_removable: 'side.removeRepo.error',
}

export function describeApiError(error: string, message?: string): string {
  const key = MESSAGE_KEYS[error]
  return key ? t(key) : message ?? t('actions.failed', { error })
}

export type Action = {
  pending: boolean
  error: string | null
  clear(): void
  call(fn: () => Promise<ApiResult<unknown>>): Promise<boolean>
}

/** One in-flight action per button: it stays disabled while the request runs and reports failures in place. */
export function useAction(): Action {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const call = useCallback(async (fn: () => Promise<ApiResult<unknown>>) => {
    if (inFlight.current) return false
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      const result = await fn()
      if (!result.ok) {
        setError(describeApiError(result.error, result.message))
        return false
      }
      return true
    } catch {
      setError(t('actions.noConnection'))
      return false
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [])

  const clear = useCallback(() => setError(null), [])
  return { pending, error, clear, call }
}
