// Entry point of the separate `lib/elk.js` bundle: it exists only to hand the layout engine to the
// client bundle through one global. Keeping it out of `lib/client.js` is what keeps the screen small.
import ElkBundle from 'elkjs/lib/elk.bundled.js'

;(globalThis as unknown as { __orchElk?: unknown }).__orchElk = ElkBundle
