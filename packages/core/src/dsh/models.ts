/**
 * Models that dsh itself serves (pv1). dsh holds the providers and their keys; Crewboard only names a
 * provider and a model, and never reads or stores a key.
 *
 * Worker ids: `dsh/<provider>/<model>` for any provider/model of dsh's model catalog. The older
 * `dsh/<model>` stays an alias for a model of {@link DSH_DEFAULT_PROVIDER}: `dsh/deepseek-flash` is
 * `dsh/deepseek-official/deepseek-flash`. A model id may itself hold `/`; a provider id does not.
 */
export const DSH_DEFAULT_PROVIDER = 'deepseek-official'

export type DshSelection = { provider: string; model: string }

/** The model string a dsh run gets (`dshModel(id)` or a registry entry's `model`) → the provider and model to select. */
export function dshSelectionOf(model: string): DshSelection {
  const slash = model.indexOf('/')
  return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : { provider: DSH_DEFAULT_PROVIDER, model }
}

/** The worker id of a catalog model. */
export const dshWorkerId = (provider: string, model: string): string => `dsh/${provider}/${model}`

/** The provider and model a `dsh/…` worker id names; `dsh` alone (dsh's default) names none. */
export const dshSelectionOfId = (id: string): DshSelection | undefined =>
  id.startsWith('dsh/') && id.length > 4 ? dshSelectionOf(id.slice(4)) : undefined

export const sameDshSelection = (a: DshSelection | undefined, b: DshSelection | undefined): boolean =>
  Boolean(a && b && a.provider === b.provider && a.model === b.model)

/** The part of `ctx.sessionController.modelCatalog()` Crewboard reads: providers with their models, and providers that failed to list. */
export type DshCatalog = {
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures: Array<{ id: string; name: string; message: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/** Keeps the catalog's well-formed providers and models only: the host service is dsh's, its shape is not ours to trust. */
export function readDshCatalog(raw: unknown): DshCatalog | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.groups)) return undefined
  const groups: DshCatalog['groups'] = []
  for (const group of raw.groups) {
    const id = isRecord(group) ? str(group.id) : undefined
    if (!id || id.includes('/') || !isRecord(group) || !Array.isArray(group.models)) continue
    const models = group.models.flatMap((model) => {
      const modelId = isRecord(model) ? str(model.id) : undefined
      return modelId && isRecord(model) ? [{ id: modelId, name: str(model.name) ?? modelId }] : []
    })
    groups.push({ id, name: str(group.name) ?? id, models })
  }
  const failures = (Array.isArray(raw.failures) ? raw.failures : []).flatMap((failure) => {
    const failureId = isRecord(failure) ? str(failure.id) : undefined
    return failureId && isRecord(failure) ? [{ id: failureId, name: str(failure.name) ?? failureId, message: str(failure.message) ?? '' }] : []
  })
  return { groups, failures }
}
