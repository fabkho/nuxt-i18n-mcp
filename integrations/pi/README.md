# the-i18n-kit for pi

Translation coverage in a widget next to the editor, and live progress while
`translate_missing` runs.

```
🌐 4 keys missing · es-ES 3 · fr-FR 1           ← when you sit down, then withdraws
🌐 es-ES: batch 1/2 (3/6)                       ← while a translate runs
🌐 22 resolved · 4 still missing                ← what moved, then withdraws
🌐 26 keys resolved · all locales up to date    ← when a run clears the last of it
```

The widget shows change, never state: it appears when something is happening or
just happened, and withdraws. A line that stays put stops being read, and a
missing count that has not moved since Tuesday is wallpaper. Standing facts live
behind `/i18n-coverage`, which answers in full — percentages included.

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
| At session start | Reads `status --json` and mentions outstanding work — in counts, largest gaps first — then withdraws. Nothing missing means no widget at all |
| While a kit tool runs | Renders MCP progress notifications live — batch by batch, locale by locale |
| After a writing tool | Refreshes (debounced) — `translate_missing`, `translate_key`, `write_translations`, `remove_translations`, `move_translation_key`, `scaffold` — and reports what moved: `22 resolved · 4 still missing`, or `26 keys resolved · all locales up to date` |
| `/i18n-coverage` | The full picture on demand, percentages and per-locale detail, including when there is nothing to report |

Live progress needs a pi-mcp-adapter that bridges MCP progress notifications to
tool updates. Without it the coverage line still works; only the progress line
stays quiet.

## Configuration

| Variable | Effect |
|---|---|
| `I18N_KIT_WIDGET_PLACEMENT=aboveEditor` | Move the widget above the editor (default: below) |
| `I18N_KIT_WIDGET_LINGER_MS` | How long a settled confirmation stays before withdrawing (default: 15000) |
| `I18N_KIT_WIDGET_DEBOUNCE_MS` | Delay before refreshing after a tool writes (default: 1500) |
| `I18N_KIT_WIDGET_DEBUG=<file>` | Append every decision the widget makes to a file |

The extension prefers a project-local `the-i18n-cli`, then a global install,
then `npx @the-i18n-kit/cli@latest`.

## Other hosts

Claude Code gets guardrail hooks and a status line, Codex gets conventions —
see [harness integrations](https://fabkho.github.io/the-i18n-kit/getting-started/harness-integrations).
