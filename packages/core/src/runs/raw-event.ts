/** Backend-neutral event envelope used by runners, history, trajectory and cost. */
export type RawEvent = { ts: string; type: string; backend?: string; agent_id?: string; data?: unknown }
