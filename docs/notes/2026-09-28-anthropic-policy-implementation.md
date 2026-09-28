# Anthropic automation policy — deviations, deferred routes and limitations

Task: `orch/anthropic-automation-policy-28` (core automated launch/auth/runner/preflight/registry).
Date: 2026-09-28. Owner of this note: the core policy worker (docs/README/workers.md belong to the docs worker).
Policy revision constant: `anthropic-api-only-2026-09-28` (`packages/core/src/routing/anthropic-policy.ts`).

## Result

Received. Crewboard's automatic Claude workers now run only on a bounded, verified commercial route:
`claude --bare` with an explicit Claude Console `ANTHROPIC_API_KEY` against the official endpoint. Every
launch consumer (CLI run/continue/relaunch/steer, plugin routes and `orchestra_*` tools, drafts, direct
`RunBackend.launch`, and a stale/direct `runCliRun`) shares one deterministic decision. A refused launch
writes no args file, starts no worktree and spawns no worker process.

This is a Crewboard product policy, not a claim that subscription CLI automation is universally prohibited:
Anthropic's June-15 CLI/SDK billing change is paused (support article `15036540`), and a keyless Console
OAuth login is commercially valid but is not a route this initial adapter supports. Refusals say "not
supported by this Crewboard build", never a legal violation.

## Sources inspected (2026-09-28)

- https://code.claude.com/docs/en/headless — bare mode never reads OAuth credentials or the OS keychain;
  for the Anthropic API set `ANTHROPIC_API_KEY` (or `apiKeyHelper` via `--settings`); Bedrock/Vertex/Foundry
  read their own credentials. Also: `total_cost_usd` and continued-conversation totals are **client-side
  estimates**, not the bill.
- https://code.claude.com/docs/en/cli-reference — `--bare` is the recommended scripted mode; no introduction
  version is stated.
- https://code.claude.com/docs/en/env-vars — credential precedence (cloud → `ANTHROPIC_AUTH_TOKEN` →
  `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profile/federation → subscription OAuth);
  `ANTHROPIC_CUSTOM_HEADERS` (v2.1.227+) can set Authorization/Host/tenant headers.
- https://code.claude.com/docs/en/authentication / iam — keyless Console sign-in is a Console OAuth profile;
  `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer`.
- https://www.anthropic.com/legal/consumer-terms §3 and https://code.claude.com/docs/en/legal-and-compliance
  (served EEA/Switzerland consumer-terms variant; not universalized).
- https://support.claude.com/en/articles/15036540 — the June-15 billing change for `claude -p`/SDK is paused.
- Observed on this machine: `claude --version` = 2.1.281 accepts `--bare` (via `claude --help`).

## What is allowed / refused

Allowed: resolved backend `claude-code`, `--bare`, non-empty `ANTHROPIC_API_KEY`, and no other credential,
routing or header source. Presence of the key only proves the API-key route is configured — never that the
key is valid, paid for, or that a request authenticates.

Refused (codes in `anthropic-policy.ts`; only variable names, never values, are reported):
- missing key (`anthropic_api_key_missing`);
- `CLAUDE_CODE_OAUTH_TOKEN` (`anthropic_subscription_token`) — even beside a key, so no silent switch to paid billing;
- `ANTHROPIC_AUTH_TOKEN` (`anthropic_bearer_token`);
- `ANTHROPIC_CUSTOM_HEADERS` (`anthropic_custom_headers`) — name-only, value never echoed;
- `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY` or `ANTHROPIC_AWS_*` (`anthropic_cloud_provider`);
- a non-official `ANTHROPIC_BASE_URL` (proper URL parse: exact `https://api.anthropic.com` is accepted;
  ports, userinfo, query, path and look-alike hosts are not) (`anthropic_custom_endpoint`);
- `ANTHROPIC_PROFILE`/federation (`anthropic_profile_auth`);
- an OAuth token pasted into the key variable (`anthropic_api_key_masquerade`);
- a resolved Anthropic model on another harness (`anthropic_unsupported_route`) — opencode/dsh/custom;
- unsafe custom `commandArgs`: `--cloud`, `--environment`, `--settings`, `--provider`, `--gateway`,
  `--api-key*`, `--auth-token`, `--base-url`, `--profile`, `--use-*`, `--resume`/`-r`, `--continue`/`-c`
  (`anthropic_routing_override`); matched as `--flag` and `--flag=value`.

`--skip-preflight`, `--force` and a TTY cannot remove the policy. Automatic picks skip a refused Claude
worker (with a recorded reason and another allowed worker, if any); an explicit `-a` refuses. The grouped
"no worker" refusal shows a policy line, never `claude auth login`.

## Deviations / deferred routes (explicit)

1. **Cloud providers, apiKeyHelper and keyless Console OAuth are unsupported, not prohibited.** Their native
   support exists upstream but is not implemented here. Adding them needs primary-source verification of each
   provider's credential precedence, not just a model string.
2. **Custom executables** (`CREWBOARD_CLAUDE_COMMAND`, a wrapper) are a trusted-input limitation: the guard
   sees the resolved backend/model and the custom args' flag names, and cannot identify an undisclosed
   upstream model behind an arbitrary proxy or custom binary.
3. **Identity precision**: a resolved non-Anthropic model wins over a cosmetic id (`claude-migrated-reviewer`
   on Codex GPT is not Anthropic); the id is a hint only when the model is genuinely unresolved (`default`/absent).
4. **CLI floor**: `CLAUDE_CODE_BARE_MIN = 2.1.281` is the oldest CLI observed here to accept `--bare`.
   Upstream states no introduction version, so this is an observed floor, paired with a live `claude --help`
   capability check in preflight.
5. **Cost semantics.** A Claude API-key run's CLI `total_cost_usd` is a client-side estimate: it is recorded
   in `apiEquivalentUsd` with source `claude_cli_estimate`, never in `cashUsd`, and `availability.cash` stays
   `unavailable`/`pending` even if a usage record claims cash. Historical subscription runs keep their old
   reading. The Review label changed from "Estimate, not charged" to "Estimate, not an invoice"
   ("Оценка, не счёт") so no uncharged promise is made for API usage.
6. **Billing label.** `billingOfTransport('claude-cli')` now returns `api-claude` and the Workers screen shows
   `API` for Claude, matching the API-only route. Placement (`section: subscription`) still follows transport.
7. **Subscription quota** is no longer sampled before a Claude run; older plans keep their recorded quota.
   Local Claude usage JSONL/transcript readers were not changed and do not read OAuth tokens or consumer
   endpoints; no credential-token reader or unofficial endpoint was added.

## Legacy running Claude runs (upgrade limitation)

A run started before this policy has no recorded channel and its already-running child keeps its old
credential. `steerTask` fails closed for any running run whose **resolved backend** reaches Anthropic
(`backend.id` authority, so an arbitrary imported id on the Claude backend still counts, and a historical
Anthropic model on opencode/dsh is caught by its model) unless the run records `authChannel:
'anthropic-api-key'` **and** the current `policyRevision`. A recorded channel with an unknown or stale
revision stays unverified. The refusal is typed (`reason: 'legacy_unverified_policy'`) with an API-only next
step, never `auth_expired`/login advice. `RunBackend.steer` enforces the same gate from the run's `args.json`,
even when the current environment has a key; `cancel`/Stop is never gated and files are preserved. This is
"unverified", not proof of violation. New guarded runs record the non-secret channel/revision in `args.json`
and `state.json`, so they still steer. Closed history is untouched.

The grouped "no worker" block never shows `claude auth login` under the API-only policy: a policy refusal
appears as its own line, and a Claude version/`--bare` failure appears as "installed but not ready" with the
`ANTHROPIC_API_KEY`/`claude update` next step. Native custom executables and any undisclosed upstream
configuration remain trusted-operator support limitations, not a global security guarantee.

## Tests (fake process/network adapters only; no provider call)

`packages/core/test/anthropic-policy.test.ts`: env decisions (missing/valid/oauth/bearer/cloud/profile/
masquerade/custom endpoint/official endpoint/custom headers), value-free errors, routing-flag detection,
resolved-route classification (opencode/dsh Anthropic refused; DeepSeek/Codex/Gemini/Cursor unaffected;
legacy-id precision), alias and imported-profile resolution, launch refusal with `--skip-preflight`/`--force`
and no backend spawn, direct-runner and direct-backend refusal with no child (poisoned parent vs provided
env), legacy-run steer refusal + guarded steer + Stop, and the cash-estimate numeric regression. Existing
core/CLI/plugin tests were adapted (preflight claude, default preset, draft isolation, effort, routing,
worker sections, plugin billing/draft-route/client wording).

## Build weight (measured 2026-09-28)

The runner entry carries its own guard so a direct/stale `runCliRun` refuses before spawning:
`packages/plugin/lib/cli-runner-main.js` 48.9 KiB (ceiling 44 → 50), `packages/plugin/lib/index.js`
686.6 KiB (ceiling 691 unchanged); CLI `main.js` 616.3 KiB (ceiling 610 → 618), `dict-ru.js` 67.7 KiB
(ceiling 68 → 69), `packages/cli/dist/cli-runner-main.js` 48.7 KiB (44 → 50). Only the affected budgets
moved; no unrelated budget or the process guards were relaxed.

## Checks

`pnpm --filter {core,crewboard,dsh-crewboard} typecheck` — pass. `git diff --check` — clean. Builds — pass.
`dsh-crewboard test` — 900/900 pass. Core and CLI gates: no assertion failure; this sandbox denies `ps`
(`spawnSync ps EPERM`), so the canonical `test/process-reaper.ts` afterEach fails every core/CLI test with
EPERM regardless of assertions, and `DSH_HOME` (set here) is why the CLI cost fixture needed the test setup
to clear it. The parent should run the exact gates in an unrestricted environment.

## Independent integration review

The orchestrator ran canonical types/tests/builds without disabling process guards: all ten checks passed.
Final review then found direct dsh backend/runner paths could bypass the identified-Anthropic refusal used
by normal launches. Added the same deterministic guard before direct dsh launch, ACP process creation and
identified legacy steering, while Stop remains allowed. Added no-process regression tests. The existing
other-provider selection fixture now uses an OpenAI model through OpenRouter: it still proves nested model
selection, while unverified Anthropic gateways are intentionally unsupported in this first adapter.
