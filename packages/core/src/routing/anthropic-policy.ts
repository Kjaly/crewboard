import type { MessageVars } from '../orchestration/messages.js'
import type { Backend } from '../preflight/preflight.js'

/**
 * Crewboard's product policy for automatic Claude workers (2026-09-28): every launch Crewboard starts goes
 * through its API-key route against the official Anthropic endpoint only. This is a Crewboard product
 * choice, not a claim that subscription CLI automation is universally prohibited: Anthropic's own billing
 * change for `claude -p` / the Agent SDK is paused, and a keyless Console login is commercially valid but
 * is not a route this bounded adapter supports. See
 * docs/notes/2026-09-28-anthropic-policy-implementation.md.
 *
 * Presence of the key proves only that the API-key route is configured for this launch — never that the key
 * is valid, paid for, or that a request will authenticate: those the run itself discovers. What the policy
 * guarantees is negative: no other credential source can be selected, and a refused launch starts nothing.
 *
 * The route is `claude --bare` with an explicit `ANTHROPIC_API_KEY` created in the Claude Console:
 * `--bare` never reads OAuth credentials or the system keychain (docs/en/headless, checked 2026-09-28), and
 * `-p` always uses `ANTHROPIC_API_KEY` when it is present (docs/en/env-vars). Crewboard refuses every other
 * resolved channel — subscription OAuth, a bearer/gateway token, an unknown custom endpoint, a named
 * Anthropic profile/federation credential, cloud-provider credentials this build does not support — and an
 * absent key, so it can never silently fall back to a subscription or choose for the person.
 */
export const ANTHROPIC_POLICY_REVISION = 'anthropic-api-only-2026-09-28'
/** The environment variable the verified route reads; only its name is ever shown. */
export const ANTHROPIC_API_KEY_REF = 'ANTHROPIC_API_KEY'
/**
 * Crewboard's floor for the `--bare` API-only route: the oldest CLI observed here to accept `--bare`
 * (`claude --version` 2.1.281, checked 2026-09-28). Anthropic's CLI reference documents `--bare` but does
 * not state its introduction version, so this is an observed floor, paired with a live `--help` capability
 * check in preflight; both may move with a CLI release.
 */
export const CLAUDE_CODE_BARE_MIN = '2.1.281'

/** The one official endpoint; an explicitly set `ANTHROPIC_BASE_URL` equal to it is not unknown routing. */
const OFFICIAL_ANTHROPIC_HOST = 'api.anthropic.com'

/**
 * Whether a custom-endpoint variable names exactly the official HTTPS endpoint. Parsed properly so a
 * look-alike host, a port, userinfo, a query or a path can never pass as official.
 */
export function isOfficialAnthropicEndpoint(value: string | undefined): boolean {
  if (!value?.trim()) return false
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === OFFICIAL_ANTHROPIC_HOST &&
    (url.port === '' || url.port === '443') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    (url.pathname === '' || url.pathname === '/')
  )
}

export const ANTHROPIC_POLICY_CODES = [
  'anthropic_api_key_missing',
  'anthropic_subscription_token',
  'anthropic_bearer_token',
  'anthropic_api_key_masquerade',
  'anthropic_custom_endpoint',
  'anthropic_cloud_provider',
  'anthropic_profile_auth',
  'anthropic_unsupported_route',
  'anthropic_routing_override',
  'anthropic_unverified_run',
  'anthropic_custom_headers',
] as const
export type AnthropicPolicyCode = (typeof ANTHROPIC_POLICY_CODES)[number]

/** The verified channel a run records; `anthropic-api-key` is the only one this build allows. */
export type AnthropicAuthChannel = 'anthropic-api-key'

export type AnthropicPolicyDecision =
  | { allowed: true; channel: AnthropicAuthChannel; policyRevision: string; cliMinVersion: string }
  | { allowed: false; code: AnthropicPolicyCode; vars: MessageVars }

const set = (env: NodeJS.ProcessEnv, name: string): boolean => Boolean(env[name]?.trim())

/** Only ever reports which variables are set, never their values: a refusal is safe to show and to log. */
function sources(env: NodeJS.ProcessEnv, ...names: string[]): string[] {
  return names.filter((name) => set(env, name))
}

/**
 * The single deterministic decision every launch consumer shares. It reads the effective launch environment
 * only — never a persisted login, a billing label or a `loggedIn` flag — and treats any second credential
 * source as a contradiction rather than guessing which one the CLI would use.
 */
export function evaluateAnthropicLaunchPolicy(env: NodeJS.ProcessEnv): AnthropicPolicyDecision {
  const cloud = sources(
    env,
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_AWS_API_KEY',
    'ANTHROPIC_AWS_WORKSPACE_ID',
  )
  const endpoint = sources(
    env,
    'ANTHROPIC_AWS_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  )
  // An explicit base URL is checked properly: exactly the official endpoint is the default route, anything
  // else (a proxy, a gateway, a look-alike host, a port, userinfo, a query or a path) is unsupported
  // configuration, not a legal judgment.
  if (env.ANTHROPIC_BASE_URL?.trim() && !isOfficialAnthropicEndpoint(env.ANTHROPIC_BASE_URL))
    endpoint.unshift('ANTHROPIC_BASE_URL')
  const profile = sources(
    env,
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
  )
  const bearer = sources(env, 'ANTHROPIC_AUTH_TOKEN')
  const subscription = sources(env, 'CLAUDE_CODE_OAUTH_TOKEN')
  // `ANTHROPIC_CUSTOM_HEADERS` (docs/en/env-vars, v2.1.227+) can carry Authorization, Host or tenant/routing
  // headers, so it can move the channel outside the key. Any custom header is unsupported; only the variable
  // name is ever reported, never the header value.
  const headers = sources(env, 'ANTHROPIC_CUSTOM_HEADERS')
  const key = env[ANTHROPIC_API_KEY_REF]?.trim() ?? ''
  const withKey = (names: string[]) => (key ? [...names, ANTHROPIC_API_KEY_REF] : names)
  const refuse = (code: AnthropicPolicyCode, names: string[]): AnthropicPolicyDecision => ({
    allowed: false,
    code,
    vars: { ref: ANTHROPIC_API_KEY_REF, ...(names.length ? { vars: names.join(', ') } : {}) },
  })
  // A bearer token outranks the API key in Claude Code's own precedence; a subscription token signals a
  // subscription the person meant to use; custom headers can override both. Either way Crewboard must not
  // choose, so each refuses outright even when a key is present.
  if (headers.length)
    return refuse(
      'anthropic_custom_headers',
      withKey([...headers, ...bearer, ...subscription, ...cloud, ...endpoint, ...profile]),
    )
  if (bearer.length)
    return refuse(
      'anthropic_bearer_token',
      withKey([...bearer, ...subscription, ...cloud, ...endpoint, ...profile]),
    )
  if (subscription.length)
    return refuse(
      'anthropic_subscription_token',
      withKey([...subscription, ...cloud, ...endpoint, ...profile]),
    )
  if (cloud.length)
    return refuse('anthropic_cloud_provider', withKey([...cloud, ...endpoint, ...profile]))
  if (endpoint.length)
    return refuse('anthropic_custom_endpoint', withKey([...endpoint, ...profile]))
  if (profile.length) return refuse('anthropic_profile_auth', withKey(profile))
  if (!key)
    return {
      allowed: false,
      code: 'anthropic_api_key_missing',
      vars: { ref: ANTHROPIC_API_KEY_REF },
    }
  // An OAuth token pasted into the API-key variable would not authenticate as a Console key; refuse rather
  // than pass a credential of the wrong kind to the CLI.
  if (/^sk-ant-oat/i.test(key) || /^bearer\s/i.test(key))
    return refuse('anthropic_api_key_masquerade', [ANTHROPIC_API_KEY_REF])
  return {
    allowed: true,
    channel: 'anthropic-api-key',
    policyRevision: ANTHROPIC_POLICY_REVISION,
    cliMinVersion: CLAUDE_CODE_BARE_MIN,
  }
}

/**
 * A compact, value-free English message attached to the error itself. The CLI/panel render the full,
 * localized refusal from `anthropic-policy-text.ts` (kept separate so the runner entry does not pull in the
 * whole message catalogue); this is only the fallback any direct caller sees.
 */
function refusalMessage(code: AnthropicPolicyCode, vars: MessageVars): string {
  const names = typeof vars.vars === 'string' && vars.vars ? ` (${vars.vars})` : ''
  const flag = typeof vars.flag === 'string' && vars.flag ? ` (${vars.flag})` : ''
  const route =
    typeof vars.backend === 'string'
      ? ` via ${vars.backend}${typeof vars.model === 'string' && vars.model ? `/${vars.model}` : ''}`
      : ''
  return `Claude API-only policy refused this launch: ${code}${names}${flag}${route}. Set ${ANTHROPIC_API_KEY_REF} to a Claude Console key or select another allowed worker.`
}

/**
 * A refusal from the direct backend path (a draft attempt or any caller of `RunBackend.launch`): carries the
 * policy code and the offending variable names, never a value, so callers can render it in their language.
 */
export class AnthropicPolicyError extends Error {
  constructor(
    readonly code: AnthropicPolicyCode,
    readonly vars: MessageVars = {},
  ) {
    super(refusalMessage(code, vars))
    this.name = 'AnthropicPolicyError'
  }
}

/** Throws unless the environment resolves to the one verified commercial channel; returns the decision. */
export function assertAnthropicLaunchAllowed(
  env: NodeJS.ProcessEnv,
): Extract<AnthropicPolicyDecision, { allowed: true }> {
  const decision = evaluateAnthropicLaunchPolicy(env)
  if (!decision.allowed) throw new AnthropicPolicyError(decision.code, decision.vars)
  return decision
}

/**
 * The args that can move a Claude launch off the API-key channel: cloud/environment selection, a settings file
 * (whose `apiKeyHelper` would supply another credential), a provider or gateway switch, or a resumed/continued
 * session. Matched by name so `--flag` and `--flag=value` both count; only the flag name is ever reported.
 */
const CLAUDE_ROUTING_FLAGS: ReadonlySet<string> = new Set([
  'cloud',
  'remote',
  'environment',
  'settings',
  'api-key-helper',
  'api-key',
  'auth-token',
  'base-url',
  'profile',
  'anthropic-profile',
  'use-bedrock',
  'use-vertex',
  'use-foundry',
  'provider',
  'gateway',
  'resume',
  'continue',
  'c',
  'r',
])

/** The first custom argument that would change auth or routing, as its flag name (no value), or undefined. */
export function firstClaudeRoutingOverride(args: readonly string[]): string | undefined {
  for (const raw of args) {
    if (!raw.startsWith('-')) continue
    const flag = raw.replace(/^-+/, '').split('=')[0]?.toLowerCase()
    if (flag && CLAUDE_ROUTING_FLAGS.has(flag)) return raw.split('=')[0] ?? raw
  }
  return undefined
}

/**
 * What a resolved worker actually routes to. `backend`/`model`/`id` come from profile resolution, not from
 * an id prefix. A resolved non-Anthropic model wins outright: a legacy id that merely contains "claude"
 * (e.g. `claude-migrated-reviewer` running Codex GPT) is not an Anthropic route. The id is only a hint when
 * the model is genuinely unresolved (`default`/absent), or a dsh provider identifier. This cannot identify an
 * undisclosed upstream model behind an arbitrary proxy or a custom executable — that stays an explicit limit.
 */
export type AnthropicRouteIdentity = { backend: Backend; model?: string; id?: string }

const ANTHROPIC_MODEL = /anthropic|claude/i

export function isIdentifiedAnthropicRoute(profile: AnthropicRouteIdentity): boolean {
  if (profile.backend === 'claude-code') return true
  const model = profile.model?.trim()
  if (model && model.toLowerCase() !== 'default') return ANTHROPIC_MODEL.test(model)
  return ANTHROPIC_MODEL.test(profile.id ?? '')
}

export type AnthropicRouteDecision =
  | { applies: false }
  | {
      applies: true
      allowed: true
      channel: AnthropicAuthChannel
      policyRevision: string
      cliMinVersion: string
    }
  | { applies: true; allowed: false; code: AnthropicPolicyCode; vars: MessageVars }

/**
 * The one decision every launch consumer uses for any worker that would reach an Anthropic model. A route
 * outside `claude-code` is refused as unsupported verification (explicitly, not as a provider ban); only the
 * `claude-code` backend can be allowed, and only through the API-key environment plus clean custom args.
 */
export function classifyAnthropicRoute(
  profile: AnthropicRouteIdentity,
  env: NodeJS.ProcessEnv,
  commandArgs: readonly string[] = [],
): AnthropicRouteDecision {
  if (!isIdentifiedAnthropicRoute(profile)) return { applies: false }
  const override = firstClaudeRoutingOverride(commandArgs)
  if (override)
    return {
      applies: true,
      allowed: false,
      code: 'anthropic_routing_override',
      vars: { flag: override, ref: ANTHROPIC_API_KEY_REF },
    }
  if (profile.backend !== 'claude-code')
    return {
      applies: true,
      allowed: false,
      code: 'anthropic_unsupported_route',
      vars: {
        backend: profile.backend,
        ...(profile.model ? { model: profile.model } : {}),
        ref: ANTHROPIC_API_KEY_REF,
      },
    }
  const decision = evaluateAnthropicLaunchPolicy(env)
  return decision.allowed
    ? {
        applies: true,
        allowed: true,
        channel: decision.channel,
        policyRevision: decision.policyRevision,
        cliMinVersion: decision.cliMinVersion,
      }
    : { applies: true, allowed: false, code: decision.code, vars: decision.vars }
}
