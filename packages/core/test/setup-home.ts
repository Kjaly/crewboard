import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ql1: `acquireSlot` and other global-config paths default to `$HOME/.config/crewboard/…`. Without this,
// a test that omits `env` (most of them) would read and write the real machine's home directory — like the
// cli and plugin packages already isolate (their own test/setup.ts).
process.env.HOME = mkdtempSync(join(tmpdir(), 'orch-core-test-home-'))
