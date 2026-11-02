import { AsyncLocalStorage } from 'node:async_hooks'
import type { LeadClient } from './clients.js'

/** The lead client of the MCP call in progress: set by the MCP tool wrapper, read when a call marks the lead present. */
export const leadCall = new AsyncLocalStorage<LeadClient | undefined>()
