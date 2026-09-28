import { type MessageLang, type MessageVars, orchText } from '../orchestration/messages.js'
import { ANTHROPIC_API_KEY_REF, type AnthropicPolicyCode } from './anthropic-policy.js'

/**
 * The localized rendering of an Anthropic policy refusal, kept apart from the pure decision module so the
 * cli-runner entry (which only needs the decision and a compact error) does not bundle the whole message
 * catalogue. Every refusal names the allowed next step: set the Claude Console API key, or pick another
 * allowed worker — never a subscription login.
 */
export const anthropicPolicyText = (
  lang: MessageLang | undefined,
  code: AnthropicPolicyCode,
  vars: MessageVars = {},
): string => orchText(lang, code, { ref: ANTHROPIC_API_KEY_REF, ...vars })

/** The few-word form a skipped-worker note and a CLI line show. */
export const anthropicPolicyShort = (
  lang: MessageLang | undefined,
  code: AnthropicPolicyCode,
  vars: MessageVars = {},
): string => orchText(lang, `${code}.short`, { ref: ANTHROPIC_API_KEY_REF, ...vars })
