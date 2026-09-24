# Costs

[Documentation](../README.md) · **English** | [Русский](../ru/costs.md)

Workers are paid for in different ways: some per token through an API, some through a subscription, some through a promotion. Crewboard records what each run's source actually reports and keeps these kinds of numbers apart. It does not turn an estimate into a charge, and it does not show a missing number as zero.

![Run ledger: two runs with worker, model, recorded API cash, an API-price estimate, and an unavailable cost](../assets/run-ledger.png)

*Two runs: one with API cash recorded, one with an estimate at API prices, and a number that is unavailable.*

## What each number means

| On the screen | In `crewboard cost --json` | Meaning |
| --- | --- | --- |
| **API cash recorded** | `cashUsd` | Money reported as charged for the run by its source: dsh's billing records for dsh workers, or a cost figure the worker itself reported for an API-billed worker. |
| **API-price equivalent**, marked **Estimate, not charged** | `apiEquivalentUsd` | For subscription workers (Claude Code, Codex): what the run's tokens would cost at API rates. **Not money you were charged**; a way to compare workers. |
| **Subscription quota change**, **Quota spent** | `quotaMeasurements`, `quotaDeltaPct` | How much of a subscription window the run used, measured before and after it. |
| **Tokens** — input, output, cache read, cache write | `tokens` | Token counts, when the source reports them. |
| **Awaiting usage** | `pending: true`, `availability.*: "pending"` | The source has not recorded the run yet. It is not in the totals. |
| **Partial data** | `availability.*: "partial"` | Only part of the run was measured. |
| **Unavailable** | `availability.*: "unavailable"` | The source does not provide this number. It is unknown, not zero. |
| **Not applicable** | `availability.cash: "notApplicable"` | Cash does not apply: a subscription run is not charged per run. |
| **Shared window; run attribution unavailable** | `attribution: "shared"` | Other work used the same quota window at the same time, so the change cannot be attributed to this run. It is left out of the totals. |

## `crewboard cost`

`crewboard cost` prints one line per worker: runs, minutes, dollars, tokens, quota, and runs still awaiting accounting. For example (illustrative figures):

```text
dsh/deepseek-flash: 2 run(s) · 14 min · $0.21 · tokens 310.4k in / 12.9k out / 280.0k cache
codex/gpt-6-sol: 1 run(s) · 9 min · cost: no data · quota +3%
```

The dollar figure in this summary adds up whatever the runs reported, cash or estimate. Use `crewboard cost --json` or the screen to tell them apart: each run there has `billingMode` (`api`, `subscription`, `promotional`, `unknown`), `cashUsd` or `apiEquivalentUsd` with its source, and an `availability` entry for every metric.

## Where the numbers come from

- **dsh workers.** dsh's billing plugin writes records to `$DSH_HOME/dsh-bill/records.jsonl` (default `~/.dsh`). Crewboard reads the tokens and dollars of the run's session from there. dsh fills in sessions from their logs when `dsh web` starts, so a fresh run can wait for accounting until the next start; the CLI says "awaiting dsh-bill accounting (restart dsh web)". If any record of the session has no price, the dollar amount stays unknown. **Verify in your dsh** that its billing plugin is enabled.
- **Claude Code.** Tokens come from Claude Code's transcripts for the run's worktree in `~/.claude/projects/`, priced at published API rates to give the estimate. The weekly subscription quota is read from `~/.claude/usage/rate-limits.jsonl` if something on your machine writes it (for example a status-line script); otherwise the quota is unavailable.
- **Codex.** The quota is read through `codex app-server` before and after the run. If it cannot be read, preflight reports "quota unknown" and the run still starts.
- **Devin.** Runs are recorded with unknown billing unless Devin reports a cost.

A quota measurement is also left out of the totals when the window was reset during the run.

## On the screen

The **Review** view summarises a plan: plan duration, worker time, time spent waiting for you, money spent, quota spent, and tokens. Opening a run shows its step ledger with usage over time and a breakdown by step, and each value carries one of the states above.

Treat API-price estimates as a way to compare workers and plans, not as a bill.
