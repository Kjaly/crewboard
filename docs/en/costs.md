# Costs

**English** | [Русский](../ru/costs.md)

Crewboard records what each run cost when it ends and shows it in **Analytics**, by provider and by assignment.

## Three kinds of number, never mixed

| Column | What it is |
| --- | --- |
| Money | what the provider says the run cost |
| At API prices | an estimate: the run's tokens at the provider's public API prices |
| Tokens: in / out | what the run read and wrote |

A value the provider does not report shows **no data**. It is never a zero: a subscription run with no price stays "no data" under Money, not $0.

## Where the numbers come from

- **Codex** reports tokens. On a subscription it reports no money; Crewboard estimates the API price for models in its price table. The default `gpt-6.1-sol` is included, with rates checked on 2026-11-03; older entries keep their 2026-09-25 rate date. A model missing from the table shows "no data" for the estimate.
- **Claude** reports tokens and a dollar figure. On your Claude plan that figure is Claude Code's estimate at API prices, not a charge: Crewboard shows it under At API prices and **by subscription** under Money. With an API key it is the run's cost. When a run's own figures are missing, Crewboard reads them from Claude Code's transcript of that run.
- **Any other agent** shows what its adapter reports; a price it does not report stays "no data".
- **DeepSeek through dsh** reports what dsh records.

A run that fails before it starts has no cost and is left out of the lanes and the tables.
