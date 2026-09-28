# Documentation audit — 2026-09-28

**Scope.** Semantic audit of the bilingual user and maintainer documentation against the current
source, tests and CLI at baseline `06d5358` (branch `orch/docs-audit-28`). Owned files only:
root READMEs, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `docs/**` Markdown, and
`tools/model-pilot/README.md`. No code, test, asset, routing, or plan changes were made, apart from
one maintainer-authorized whitespace-only cleanup in `packages/cli/src/dict-ru.ts` (trailing spaces
on two blank lines). Historical audit and policy notes keep their original findings; this file is the
dated current status.

**Method.** Read recent local `git log`, then compared each claim with the
implementation and its tests; ran `node scripts/check-docs.mjs --strict`. Source of truth included
`packages/core/src/routing/anthropic-policy.ts`, `packages/core/src/orchestration/{auto-close,check,attestation,needs-you,review}.ts`,
`packages/core/src/cost/*`, `packages/plugin/src/{host/tools.ts,client/sidebar.tsx,client/views/work.tsx,client/dict/*}`,
`packages/cli/src/{commands/*,i18n.ts,help.ts}`, and `tools/model-pilot/*`.

## Files reviewed

- Root: `README.md`, `README.ru.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`.
- Guides (EN + RU): `getting-started`, `plugin-setup`, `cli`, `workers`, `review`, `costs`,
  `troubleshooting`.
- Contributor/architecture: `docs/architecture.md`, `docs/releasing.md`, `docs/README.md`,
  `docs/context-envelope.md`, `docs/evals/model-pilot.md`, `tools/model-pilot/README.md`.
- Notes and audits: `docs/notes/README.md`, `docs/notes/2026-09-22-*`, `docs/notes/2026-09-23-*`,
  `docs/notes/2026-09-24-release-research.md`, `docs/notes/2026-09-28-anthropic-*.md`,
  `docs/audits/2026-09-28/{summary,user-journeys,lifecycle,prompts-routing,cache-*}.md`.
- CLI: `crewboard help all` body and command parsers; `docs/en/cli.md` and `docs/ru/cli.md`.

## Resolved inconsistencies

1. **Review queue names and tags.** The sidebar heading is **Review queue** (RU **Очередь
   разбора**) and the board chip is **Review queue · N** (`packages/plugin/src/client/dict/en.ts`
   `side.inbox`, `panel.app.queueCount`; RU `dict/ru.ts`), while the guides said **Needs you** /
   **Waiting for you**. The tag set is `review`, `check off`, `blocked`, `decision`, `failed`,
   `may be stuck`, `worker gone`, `not merged` (`needs-you.ts` `NEEDS_YOU_REASONS`; `dict/en.ts`
   `waiting.tag.*`); the guides listed six and dropped `may be stuck` and `worker gone`.
   `docs/en/review.md` and `docs/ru/review.md` now name the current labels, list all eight tags, and
   note the alias.
2. **Queue vs Work board.** The canonical queue (`needs-you.ts`) counts a running/stalled task only
   at `alert` severity, while the Work board's **To review** column moves a card on any attention
   (`packages/plugin/src/client/views/work.tsx`). This is the open F2 discrepancy from the
   [audit synthesis](summary.md); the guides now link here instead of claiming every surface agrees.
3. **Automatic acceptance/merge.** `docs/architecture.md` claimed a person makes every accept/return
   decision and that there is no acceptance or merge tool; `CONTRIBUTING.md` said agents do not make
   those decisions. Routine checked work is auto-accepted/merged by the orchestrator through
   `accept --auto` + `merge --auto` or `orchestra_close` (`tools.ts`, `auto-close.ts`), with human
   gates retained. Both files now describe the real split; `getting-started` no longer says an agent
   cannot accept its own work.
4. **CHANGELOG publication overclaim.** `CHANGELOG.md`'s `0.4.0 — Unreleased` section said the
   packages "are published" and described merges as "never an agent", contradicting the same
   unreleased state. It now says the packages are *packaged* and the release workflow is implemented,
   with publication left to a maintainer; the stale human-only bullets inside 0.4.0 were corrected.
   The internal 0.1.0/0.2.0 milestones are preserved.
5. **Install path.** The npm release is not published (`npm view crewboard@0.4.0` and
   `npm view dsh-crewboard@0.4.0` both return E404 as observed by the orchestrator on 2026-09-28),
   so `README.md`/`README.ru.md` now lead with the source checkout, give a concrete
   `node packages/cli/dist/main.js` invocation and absolute-path shell functions, and mark the npm commands
   as available only after publication. `getting-started` and `plugin-setup` (EN + RU) follow the
   same order.
6. **Claude sign-in guidance.** `plugin-setup.md` (EN + RU) told readers to sign in Claude Code
   under **Subscriptions**. Automated Claude runs are API-key only
   (`packages/core/src/routing/anthropic-policy.ts`); the guide now explains the legacy section
   heading, the `ANTHROPIC_API_KEY` requirement, and that other Anthropic transports are
   unsupported, not forbidden. `workers.md` (EN + RU) also notes that an Anthropic model routed
   through dsh is refused, that Claude billing reads **API**, and that the effective Claude Code
   floor is **2.1.281** (`CLAUDE_CODE_BARE_MIN`) although Opus 5.5 declares 2.1.280.
7. **Cost labels and scope.** `docs/en/costs.md` / `docs/ru/costs.md` said the API-price estimate was
   marked "Estimate, not charged"; the UI string is **"Estimate, not an invoice"** / **«Оценка, не
   счёт»** (`dict/en.ts`/`dict/ru.ts` `review.notCharged`). The Claude reader now states that an
   API-key run's CLI `total_cost_usd` is a client-side estimate recorded in `apiEquivalentUsd`
   (`claude_cli_estimate`), never `cashUsd` (`packages/core/src/cost/cost.ts`). The RU file's two
   duplicated top paragraphs were removed (structure now matches EN).
8. **Quota precision.** "quota by window, not summed" was unqualified. Per-window `quotaWindows`
   is the `--by`/`--csv` behaviour; the default `crewboard cost` still prints one summed
   `quotaDeltaPct` (`runs.ts`, `cost.ts`). The costs guides now say which output does what.
9. **Codex rollout diagnostic.** `docs/en/costs.md` and `docs/ru/costs.md` now record that
   `--codex-rollout` cannot be combined with `--json`, `--csv`, `--plan`, `--all-plans`,
   `--all-repos`, `--since`, `--until` or `--by` (`packages/cli/src/commands/runs.ts`), and that
   the flag is present in source but absent from `crewboard help all`.
10. **Attestation and takeover in the CLI reference.** `docs/en/cli.md` and `docs/ru/cli.md` listed
    only `verify`, `--reopen`, `--done`, `--return`, `--run-checks`, `--setting`. Both missing forms
    are now documented: `--attest …` (`check.ts` `attestResult`, `attestation.ts`) and
    `--takeover --note` (`check.ts`, an incomplete run with preserved `left_uncommitted`/`no_claim`
    work, no new run). The "only finished work waiting for review can be checked" sentence was
    corrected for `--takeover`, root and decision work.
11. **Screenshots as dated illustrations.** `docs/README.md` now records that the seven assets are
    dated captures (the 0.4.0 set on 2026-09-25, `settings.png` on 2026-09-24) and are not
    regenerated automatically, so later UI changes may be missing. No claim of regeneration is made.
12. **Model-pilot inputs.** `tools/model-pilot/README.md` and `docs/evals/model-pilot.md` now state
    that `base.json` and `manifest.json` are per-pilot inputs the orchestrator creates, not shipped
    files. The framework is complete (39 tests, 27 fixtures, verified locally); `candidates/` and
    `receipts/` hold only `.gitkeep`, so there is no real paired candidate trial, promotion or
    savings. Framework authoring *did* invoke workers — the paired-pilot-28 Codex arm failed with a
    403 and the dsh DeepSeek Flash arm completed, and this documentation task itself ran on Flash —
    but no candidate output, grade receipt or cost export is in the repository, and the tooling's
    grader/report/tests make no provider or network calls of their own.
13. **Sidebar "missing".** `plugin-setup.md` (EN + RU) now says the Crewboard list entry is retained
    when `existsSync(root)` is false (`packages/plugin/src/host/service.ts`), and that the user
    removes it or re-adds the relocated path; nothing is deleted from the label.
14. **Architecture links.** `docs/architecture.md` now names result attestation/history and the
    `<commit_owner>orchestrator</commit_owner>` contract in addition to the auto-accept gates.
15. **Notes index.** `docs/notes/README.md` now lists the 2026-09-24 release research and both
    2026-09-28 Anthropic policy notes, which were unindexed, plus this audit.
16. **`verify --done` and auto-close.** The CLI reference and review guide said a checked task simply
    waits for a person. Both now state that routine checked work can then be auto-accepted and
    merged, while decisions, root tasks, disputed/negative results, conflicts and `<human_review>`
    still wait for a person (`auto-close.ts`).
17. **`<commit_owner>` in the changelog.** The unfinished-runs bullet described an unconditional
    worker commit plus an extra nudge turn. It now names the
    `<commit_owner>orchestrator</commit_owner>` exception, where the worker leaves the copy intact
    and the orchestrator commits and reports (`workers.md`, `check.ts`).
18. **Historical phase plan.** `docs/audits/2026-09-28/cache-plan.md` keeps its original design and
    now carries a dated addendum: all three phase-1 tasks (`receipt-freshness-28`,
    `context-envelope-28`, `orchestrator-usage-28`) merged, the paired-pilot framework complete,
    and no real paired trial, per-wake/prefix attribution or Jev work yet.

## Known limitations

- **`--attest --verdict disputed` cannot be recorded from a plain claim.** `check.ts`
  (`attestResult`) derives the primary claim through `claimLineOf`/`claimOf`, which recognize only
  `received`/`получен`, `negative`, `blocked`, or a positive free-text sentence
  (`packages/core/src/orchestration/verdict.ts`). A bare `Result: disputed` yields no claim line, so
  the verdict is refused as a claim mismatch; no test exercises a disputed attestation. The guides
  document this limitation and link here, and do not advise wording a proof to bypass the parser.
- **Queue vs Work board (F2).** `work.tsx` still moves a card into **To review** on any attention
  severity while the canonical queue uses `alert` only. The guides describe the current behaviour
  and this discrepancy is not fixed in code.
- **Queue naming drift (F8).** `crewboard help all` still says «Needs you», and several
  `CHANGELOG.md` bullets and `README`/guide captions use the old label. A full rename spans source
  strings and is outside a docs-only change.
- **Panel decision answer (F3).** The screen's decision panel does not persist a free-text answer
  the way `decision answer` does; this audit did not change that and the guides do not claim it.
- **Source log-in hint inconsistency.** `packages/core/src/runs/failure.ts` still returns
  `claude auth login` for an `auth_expired` Claude failure, although the API-only guard requires an
  `ANTHROPIC_API_KEY` route. The troubleshooting guides (EN + RU) now say the CLI may print that
  legacy hint and that a subscription re-login is not the fix; the source message itself is
  unchanged (code is out of scope for this audit).
- **Publication status.** Packaging is implemented and `docs/releasing.md` is a maintainer runbook;
  no release was performed in this change. The E404 above is a date-stamped observation, not a
  claim about the namespace universally. The README inventory is an inventory of prepared features,
  not a statement of full release readiness: the screen is checked only on macOS, and Linux and
  Windows remain untested.
- **Environment facts.** Statements such as the checked macOS/Node.js/pnpm versions and the
  currently disabled Claude profiles are facts of the machine snapshot recorded in dated notes, not
  defaults of every installation. `profile-store.ts` still defaults a profile to `enabled: true`;
  the disablement is owner configuration.
- **Prefix fingerprint.** `docs/context-envelope.md` correctly states that the instruction-byte
  fingerprint is not provider KV-cache reuse and implies no billed-token or quota savings; the
  paired pilot makes no savings claim, and `report.mjs` forbids one.
- **Historical audits.** The dated audit pages keep their original findings. The F1 stale-receipt
  gap was fixed by the `receipt-freshness-28` work (`auto-close.ts` `currentGateReceipts` now
  matches the receipt commit to the current HEAD and the current contract revision for both
  automatic acceptance and merge), and F4 (the orchestrator prompt/wake contradiction) was fixed by
  `context-envelope-28`; `summary.md` carries a dated status note for both. F2, F3 and F8 remain
  open as above.

## Verification

- `node scripts/check-docs.mjs --strict` — passes (see the task report for the exact run).
- `git diff --check` — clean.
- Model-pilot counts: 15 + 24 = **39 tests** (`tools/model-pilot/*.test.mjs`) and **27 fixtures**
  (`fixtures.json`).
