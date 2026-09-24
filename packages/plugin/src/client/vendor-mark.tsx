import { useEffect, useState } from 'react'
import { API_PREFIX } from '../shared/types.js'
import { type ProviderIdentity, vendorSlug } from './provider.js'

/**
 * The vendor's own mark when the owner put one in `packages/plugin/assets/vendors/<slug>.svg`,
 * the two-letter mark otherwise. We ship no logos: they are other companies' trademarks, and
 * whether to use them is the owner's decision, not ours.
 */
let available: Set<string> | undefined
let inFlight: Promise<Set<string>> | undefined

function loadVendors(): Promise<Set<string>> {
  if (available) return Promise.resolve(available)
  inFlight ??= fetch(`${API_PREFIX.replace('/api', '')}/assets/vendors.json`)
    .then((r) => (r.ok ? r.json() : { vendors: [] }))
    .then((body: { vendors?: unknown }) => new Set(Array.isArray(body.vendors) ? body.vendors.filter((v): v is string => typeof v === 'string') : []))
    .catch(() => new Set<string>())
    .then((set) => {
      available = set
      return set
    })
  return inFlight
}

export function VendorMark({ identity }: { identity: ProviderIdentity }) {
  const slug = vendorSlug(identity)
  const [known, setKnown] = useState<Set<string> | undefined>(available)
  useEffect(() => {
    if (known || !slug) return
    let alive = true
    void loadVendors().then((set) => alive && setKnown(set))
    return () => {
      alive = false
    }
  }, [known, slug])
  const className = `orc-prov orc-prov--${identity.mark}`
  if (slug && known?.has(slug)) {
    return <img className={`${className} orc-prov--img`} src={`${API_PREFIX.replace('/api', '')}/assets/vendor/${slug}.svg`} alt="" aria-hidden="true" />
  }
  return (
    <span className={className} aria-hidden="true">
      {identity.mark}
    </span>
  )
}
