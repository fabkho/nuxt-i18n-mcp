# the-i18n-kit for Codex (and other MCP hosts)

Codex has no hook system, so the integration is the MCP server plus written
conventions the model follows from context.

## MCP server

`~/.codex/config.toml`:

```toml
[mcp_servers.the-i18n-kit]
command = "npx"
args = ["-y", "@the-i18n-kit/mcp@latest"]
# Provider mode (optional — otherwise the server runs in agent mode):
# env = { I18N_PROVIDER = "google", I18N_MODEL = "gemini-2.5-flash" }
```

The API key for provider mode comes from the environment Codex runs in
(`GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).

## Conventions (AGENTS.md)

Without hooks, the guardrails live in `AGENTS.md`. Add:

```markdown
## Translations

This project manages translations with the-i18n-kit (MCP server `the-i18n-kit`).

- Never edit locale files directly — one edited locale drifts from its
  siblings. Use `write_translations`, `translate_missing`, `translate_key`,
  `remove_translations`, `move_translation_key`.
- Start with `discover` to see locales, layers and the translation mode.
- Before finishing work that touched UI code, run `find_undefined_keys`;
  undefined keys render raw in production.
- Respect protected locales and preserve `{placeholders}` exactly.
```

## CI backstop

What hooks enforce in Claude Code, CI enforces everywhere:
`the-i18n-cli check` exits non-zero on undefined keys — see the GitHub Action
and GitLab CI template in this repository.

Any other MCP-capable host follows the same pattern: the server config above
plus the conventions block in whatever context file that host reads.
