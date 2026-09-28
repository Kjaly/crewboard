/** Explicit contract directive. The default remains a worker commit for existing plans. */
export const orchestratorCommits = (contract: string): boolean =>
  /^<commit_owner>orchestrator<\/commit_owner>\s*$/m.test(contract)
