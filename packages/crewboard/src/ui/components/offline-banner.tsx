import { T } from '../text.js'

export function OfflineBanner() {
  return (
    <p className="offline" role="alert">
      {T.offline}
    </p>
  )
}
