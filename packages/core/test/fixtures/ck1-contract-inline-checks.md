# ck1 · Crewboard runs the contract checks and records the result

## Context

Wave 2 of the sy1 synthesis (`.orchestration/research/2026.09.24_sy1-synthesis.md` in the main checkout, item B30). Contracts from the template (ct1, `packages/core/src/plan/contract.ts`) carry a `<checks>` block, one command per line. Today only the worker claims it ran them; the verdict reads the claim.

## Result

1. `crewboard verify <id> --run-checks` (orchestrator and person) and a **Run checks here** button in the task panel run each `<checks>` command in the task's worktree, one after another, with the recipe's environment and a timeout per command; the full output goes to a file (tk1 `saveOutput`), the result (command, exit code, duration, 20-line tail, file path) is stored in the run's evidence as a separate fact next to the worker's claim.
2. The panel and `task show` show «Checks run by Crewboard: 3/3 passed» (or which failed, with the tail) beside the worker's claim; a mismatch (worker says passed, Crewboard saw a failure) is a red fact. The verdict itself is not rewritten.
3. Commands are only those in the contract's `<checks>` block; nothing from the report is executed. A contract without checks says so.
4. Docs (en/ru) and CHANGELOG entry.

## Checks

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:i18n`, `pnpm test`, `pnpm release:check`. The machine is often loaded by parallel workers: run package suites one at a time with `pnpm -s exec vitest run --maxWorkers=2 --testTimeout=60000` inside each package if the full run times out; do not change timeouts in the repository. Start your final answer with a result line. Tests on a temporary repository: passing and failing checks recorded with exit codes and files; timeout; mismatch fact; no checks block. Journal at `docs/tmp/2026.09.25_ck1-run-checks_deviations.md`.

<checks>
- pnpm -s lint:i18n
- test -f does-not-exist.txt
</checks>
