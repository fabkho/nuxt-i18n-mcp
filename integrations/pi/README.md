# the-i18n-kit for pi

Translation coverage in a widget next to the editor, and live progress while
`translate_missing` runs.

```
🌐 83% · es 75% · fr 92% · 4 missing        ← idle
🌐 translating es-ES: batch 1/2 (3/6)       ← while a translate runs
🌐 i18n complete                            ← nothing missing
```

## Install

```bash
pi install npm:@the-i18n-kit/pi
```

Or from a checkout: `pi install /path/to/the-i18n-kit/integrations/pi`.

The extension is silent outside i18n-kit projects (nearest `.i18n-mcp.json` or
`i18n-kit.config.*` upward from the working directory decides), so it is safe to
install globally.

## What it does

| | |
|---|---|
| At session start | Reads `status --json` and shows coverage, worst locales first. Protected locales are excluded, as they are from the overall figure |
| While a kit tool runs | Renders MCP progress notifications live — batch by batch, locale by locale |
| After a writing tool | Refreshes coverage (debounced) — `translate_missing`, `translate_key`, `write_translations`, `remove_translations`, `move_translation_key`, `scaffold` |
| `/i18n-coverage` | Refresh on demand |

Live progress needs a pi-mcp-adapter that bridges MCP progress notifications to
tool updates. Without it the coverage line still works; only the progress line
stays quiet.

## Configuration

| Variable | Effect |
|---|---|
| `I18N_KIT_WIDGET_PLACEMENT=aboveEditor` | Move the widget above the editor (default: below) |

The extension prefers a project-local `the-i18n-cli`, then a global install,
then `npx @the-i18n-kit/cli@latest`.

## Other hosts

Claude Code gets guardrail hooks and a status line, Codex gets conventions —
see [harness integrations](https://fabkho.github.io/the-i18n-kit/getting-started/harness-integrations).
