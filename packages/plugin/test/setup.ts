import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { setLang } from '../src/client/i18n.js'
import { en } from '../src/client/dict/en.js'
import { ru } from '../src/client/dict/ru.js'
import { installDictionary } from '../src/client/i18n.js'

installDictionary('en', en)
installDictionary('ru', ru)

beforeEach(() => setLang('en'))
afterEach(() => setLang('en'))

process.env.HOME = mkdtempSync(join(tmpdir(), 'orch-plugin-test-home-'))

// The unit tests render source components in jsdom, which does not fetch script tags.
// Register the same exports that the built screen assets publish in a browser.
import { ReviewView } from '../src/client/views/review.js'
import { ReviewDrilldown } from '../src/client/views/review-detail.js'
import { Welcome } from '../src/client/welcome.js'
import { Tour } from '../src/client/tour.js'
import { OrchestraSettings } from '../src/client/settings.js'
import { DraftReview } from '../src/client/draft-review.js'
import { DraftJobView } from '../src/client/draft-job.js'
import { LedgerView } from '../src/client/panel/trace-ledger.js'
import { TraceScreen } from '../src/client/panel/trace.js'
import { TaskPanel } from '../src/client/panel/task-panel.js'
import { TaskMenu } from '../src/client/task-menu.js'
import { GraphView } from '../src/client/views/graph/index.js'

globalThis.__orchScreenBundles = {
  review: { ReviewView, ReviewDrilldown }, welcome: { Welcome, Tour },
  settings: { OrchestraSettings }, draft: { DraftReview, DraftJobView }, ledger: { LedgerView },
  trace: { TraceScreen }, task: { TaskPanel, TaskMenu }, graph: { GraphView },
}
