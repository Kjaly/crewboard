# Costs

[Documentation](../README.md) · **English** | [Русский](../ru/costs.md)

Workers are paid for in different ways: some per token through an API, some through a subscription, some through a promotion. Crewboard records what each run's source actually reports and keeps these kinds of numbers apart. It does not turn an estimate into a charge, and it does not show a missing number as zero.

![Run ledger: two runs with worker, model, recorded API cash, an API-price estimate, and an unavailable cost](../assets/run-ledger.png)

*Two runs: one with API cash recorded, one with an estimate at API prices, and a number that is unavailable.*

## What each number means

| On the screen | In `crewboard cost --json` | Meaning |
| --- | --- | --- |
| **API cash recorded** | `cashUsd` | Money reported as charged for the run by its source: dsh's billing records for dsh workers, or a cost figure the worker itself reported for an API-billed worker. |
| **API-price equivalent**, marked **Estimate, not an invoice** | `apiEquivalentUsd` | What the run's tokens would cost at API rates: for subscription workers (Codex, and historical Claude Code runs) and for a current Claude API-key run, whose own CLI reports a client-side `total_cost_usd` estimate. **Not an invoice and not money charged**; a way to compare workers. |
| **Subscription quota change**, **Quota spent** | `quotaMeasurements`, `quotaDeltaPct` | How much of a subscription window the run used, measured before and after it. |
| **Tokens** — input, output, cache read, cache write | `tokens` | Token counts, when the source reports them. |
| **Awaiting usage** | `pending: true`, `availability.*: "pending"` | The source has not recorded the run yet. It is not in the totals. |
| **Partial data** | `availability.*: "partial"` | Only part of the run was measured. |
| **Unavailable** | `availability.*: "unavailable"` | The source does not provide this number. It is unknown, not zero. |
| **Not applicable** | `availability.cash: "notApplicable"` | Cash does not apply: a subscription run is not charged per run. |
| **Shared window; run attribution unavailable** | `attribution: "shared"` | Other work used the same quota window at the same time, so the change cannot be attributed to this run. It is left out of the totals. |

Cache-write counts remain absent when a CLI does not report them. Aggregated totals include only reported cache writes and expose `cacheWriteCoverage` (`knownRuns`, `partialRuns`, `totalRuns`) when at least one run has a reported value. Mixed per-call observations and legacy state files with positive sums are marked partial. A reported zero is retained as a known zero. A finished dsh run with no bill record remains pending for cash until dsh backfills it.

## `crewboard cost`

`crewboard cost` prints one line per worker: runs, minutes, money, tokens, quota, and runs still awaiting accounting. For example (illustrative figures):

```text
dsh/deepseek-flash: 2 run(s) · 14 min · cash $0.21 · tokens 310.4k in / 12.9k out / 280.0k cache
claude/opus: 3 run(s) · 25 min · estimate ≈$4.8 · tokens 1.2k in / 40.1k out / 2100.0k cache
codex/gpt-6-sol: 1 run(s) · 9 min · cost: no data · quota +3%
```

Money comes in two units that are never added up, as on the screen: `cash` is what API runs were charged, `estimate ≈` is what subscription runs would have cost at API rates. A worker with both shows both. In `crewboard cost --json` the per-worker `totals` carry `cashUsd` and `apiEquivalentUsd` (each absent when no run reported it), and each run has `billingMode` (`api`, `subscription`, `promotional`, `unknown`), `cashUsd` or `apiEquivalentUsd` with its source, and an `availability` entry for every metric.

Draft and repair attempts (`crewboard plan draft …`) run outside any task, so they never appear in a worker's or a task's totals above; they are always printed as their own **Planning** line instead, summed the same way.

## Slicing: a day, a sprint or a worker

```text
crewboard cost [--all-plans] [--all-repos] [--since <date>] [--until <date>]
               [--by worker|task|plan|class|effort|day] [--csv|--json]
```

- `--by worker|task|plan|class|effort|day` groups runs by that instead of only by worker; the **Planning** line stays separate from every grouping.
- `--all-plans` covers every plan of the current repository instead of only the one open; `--plan <id>` and `--all-plans` cannot be combined.
- `--all-repos` covers every repository the screen knows (the same list `crewboard attention --all` uses), each with its own current plan, or every plan of each with `--all-plans` too.
- `--since <date>` / `--until <date>` keep runs (and Planning attempts) whose start falls in that range; a bare `YYYY-MM-DD` means the whole day — `--since` starts at its first instant, `--until` ends after its last.
- `--csv` contains worker slices and the Planning row only; it is not a full-cost total. Its header is `key,runs,minutes,cashUsd,apiEquivalentUsd,quotaWindows,tokensInput,tokensOutput,tokensCacheRead,tokensReasoning,pendingRuns`. `--json` also includes separate `orchestrator` session metadata.

Cost output also has a separate **Orchestrator** section/`orchestrator` JSON field. It reads only dsh session IDs explicitly bound in `.orchestration/chats.json`; missing bindings are unavailable and missing bill rows are pending. This is full session lifetime usage and is excluded from worker, task, plan, and planning totals. Duplicate session bindings are counted once. Field availability is reported independently; missing token fields are unknown, while a source-reported zero is known. Session JSON preserves matched call count, `dsh_bill_records` provenance and observed cash with known/partial/unavailable coverage; cash is known only when every matched record has a finite nonnegative numeric USD value and is marked priced. Cache writes mean the billing record reported a value, not verified provider cache activity. Date filters select bindings by `boundAt`; they do not filter the session's bill records, and this binding-only scope is noted even when the selection is empty.

For an explicitly supplied Codex rollout only: `crewboard cost --codex-rollout <exact-path>` emits a JSON diagnostic from `event_msg` token-count records and `turn_context` model metadata. It never discovers chats or copies transcript contents. The first cumulative baseline is shown as unallocated; later deltas go to the current model, resets start a new cumulative segment, and cash/quota remain unavailable. Last-turn input/context and cumulative totals remain separate. The flag stands alone — combining it with `--json`, `--csv`, `--plan`, `--all-plans`, `--all-repos`, `--since`, `--until` or `--by` is refused — and, like this diagnostic itself, it is not listed in `crewboard help all`.

A subscription's quota is shown per quota window in the sliced output (`--by …` and `--csv`): a 5-hour window and a weekly window are different scopes, and adding their deltas would misrepresent both. In text and CSV each slice lists every window it touched, `<window> +<percent>%`; in JSON it is `quotaWindows: [{ provider, accountKey, windowId, deltaPct }, …]`. The default `crewboard cost` (no slice flags) still prints one per-worker `quotaDeltaPct`, which can add several windows in a run (and several runs) into a single `quota +N%`; read that figure as a rough total, not a window-scoped one.

## Where the numbers come from

- **dsh workers.** dsh's billing plugin writes records to `$DSH_HOME/dsh-bill/records.jsonl` (default `~/.dsh`). Crewboard reads the tokens and dollars of the run's session from there. dsh fills in sessions from their logs when `dsh web` starts, so a fresh run can wait for accounting until the next start; the CLI says "awaiting dsh-bill accounting (restart dsh web)". If any record of the session has no price, the dollar amount stays unknown. **Verify in your dsh** that its billing plugin is enabled.
- **Claude Code.** Automated Claude runs are API-key only (see [workers](workers.md#claude-automation-subscriptions-and-account-safety)); the CLI's own `total_cost_usd` is a client-side estimate, recorded as `apiEquivalentUsd` with source `claude_cli_estimate`, never as `cashUsd` — cash stays unavailable or pending. Tokens come from Claude Code's transcripts for the run's worktree in `~/.claude/projects/`, priced at published API rates. The weekly subscription quota reader (`~/.claude/usage/rate-limits.jsonl`, if something on your machine writes it, for example a status-line script) is unchanged and now serves historical subscription runs; new Claude runs are not sampled for quota.
- **Codex.** The quota is read through `codex app-server` before and after the run. If it cannot be read, preflight reports "quota unknown" and the run still starts. Codex's own reported cost is used first; without one, its token counts are priced at published per-model rates, the same way Claude Code's are — an unlisted model stays unknown rather than showing $0.
- **Devin.** Runs are recorded with unknown billing unless Devin reports a cost.

A quota measurement is also left out of the totals when the window was reset during the run.

## On the screen

The **Review** view summarises a plan: plan duration, worker time, time spent waiting for you, money spent, quota spent, and tokens. Opening a run shows its step ledger with usage over time and a breakdown by step, and each value carries one of the states above.

Treat API-price estimates as a way to compare workers and plans, not as a bill.
