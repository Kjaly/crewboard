/** A goal whose lead has made no call this long is paused, not abandoned: a new lead can adopt it. */
export const LEAD_SILENT_PAUSE_MS = 24 * 60 * 60 * 1000
/** An assignment whose last run ended without a result and has seen nothing since this long is abandoned. */
export const STALE_ABANDON_MS = 24 * 60 * 60 * 1000
/** A new progress line is recorded at most this often per assignment, and only when its text changed. */
export const PROGRESS_EVERY_MS = 15_000
/** The lead counts as away after this long without a call: the owner may then stop a run without its decision. */
export const LEAD_OFFLINE_MS = 10 * 60 * 1000
/** At most this many child assignments come from one worker's split. */
export const MAX_SPLIT = 8
/** An MCP session idle this long is closed; its client re-initialises on the next call. */
export const MCP_IDLE_MS = 30 * 60 * 1000
