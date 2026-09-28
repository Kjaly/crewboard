import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'orch-cli-test-home-'))
// The CLI tests point HOME at their own temp dir and write their own dsh-bill records; an inherited
// DSH_HOME would send the cost reads to the developer's real ~/.dsh and make the fixture invisible.
delete process.env.DSH_HOME

// The API-only Claude route needs a configured key for the CLI runs that use the fake worker; the conflicting
// sources are cleared so a developer's own shell cannot turn these tests into policy refusals. Tests that
// exercise the refusal pass their own environment.
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test'
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
delete process.env.ANTHROPIC_BASE_URL
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_USE_VERTEX
delete process.env.CLAUDE_CODE_USE_FOUNDRY
delete process.env.ANTHROPIC_PROFILE
