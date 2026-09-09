# the-i18n-kit for Claude Code

A Claude Code plugin: the MCP server plus the guardrails a model does not bring
on its own.

| Component | What it does |
|---|---|
| MCP server | `the-i18n-kit` server via `npx @the-i18n-kit/mcp@latest` |
| PreToolUse hook | Blocks hand-edits to managed locale files, points the model at `write_translations` / `translate_missing` instead |
| Stop hook | Refuses to finish while `check` finds keys referenced in code but defined in no locale layer |
| Skill | Workflow guidance: orient with `discover`, write through tools, verify before finishing |
| Status line (manual) | Coverage per locale, e.g. `🌐 de 100% · es 75% · fr 92% · 4 missing` |

## Install

```
/plugin marketplace add fabkho/the-i18n-kit
/plugin install the-i18n-kit@the-i18n-kit
```

Both hooks no-op outside i18n-kit projects (nearest `.i18n-mcp.json` or
`i18n-kit.config.*` decides), so the plugin is safe to keep enabled globally.

## Status line

Claude Code plugins cannot ship a status line, so wire it in
`~/.claude/settings.json` yourself — either standalone:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /path/to/the-i18n-kit/integrations/claude-code/statusline/i18n-statusline.sh"
  }
}
```

or appended to an existing script (it prints nothing outside i18n-kit projects).

## Configuration

| Env var | Effect |
|---|---|
| `I18N_KIT_ALLOW_DIRECT_EDITS=1` | Disable the locale-file guard |
| `I18N_KIT_SKIP_CHECK=1` | Disable the Stop-hook check gate |
| `I18N_PROVIDER` / `I18N_MODEL` / provider API key | Provider mode for the MCP server (translates directly); unset → agent mode |

Hooks prefer a project-local `the-i18n-cli`, then a global install (v10+), then
`npx @the-i18n-kit/cli@latest`.

## Other agents

- **pi**: deeper integration (live translate progress, widgets) — see the pi
  extension notes in the repository.
- **Codex and others**: MCP config plus conventions, see
  [`../codex/README.md`](../codex/README.md).
