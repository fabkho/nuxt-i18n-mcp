# the-i18n-kit for pi

Translation coverage in a widget next to the editor, and live progress while
`translate_missing` runs.

```
🌐 4 keys missing · es-ES 3 · fr-FR 1           ← when you sit down, then withdraws
🌐 ⠹ ▕██████░░░░░░▏ es-ES: batch 1/1 3/6        ← while a translate runs
🌐 es-ES +3 · fr-FR +1 · ⚠ fr-FR dropped {count} ← what moved, and what broke
🌐 2 undefined keys · checkout.payNow, cart.empty ← after a turn that edited source
🌐 26 keys resolved · all locales up to date    ← when a run clears the last of it
```

Colours come from the active theme — `warning` for work outstanding, `success`
for work done, `accent` for the marker — so the widget follows whatever theme is
loaded rather than picking colours of its own. The spinner turns only while a
tool is running. During a translate the working row narrates the same progress,
since its spinner is already animating for the same wait.

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
| At session start | Reads `status --json` and mentions outstanding work — in counts, largest gaps first — then withdraws. Nothing missing means no widget at all. Silent entirely when a border or other permanent surface is already showing coverage |
| While a kit tool runs | Renders MCP progress notifications live — batch by batch, locale by locale |
| After a writing tool | Refreshes (debounced) and reports what moved, per locale, from the tool's own result — including translations that dropped a placeholder, and locales left alone because they are protected |
| After a turn that edited source | Runs `check`: keys the code calls and no layer defines render raw in production, so they are named while the edit is still fresh |
| `/i18n-coverage` | The full picture on demand, percentages and per-locale detail, including when there is nothing to report |

Live progress needs a pi-mcp-adapter that bridges MCP progress notifications to
tool updates. Without it the coverage line still works; only the progress line
stays quiet.

## In the footer

Alongside the widget, coverage is published as a host status under the key
`i18n`:

```
🌐 4 missing        🌐 ✓        🌐 ?
```

This is the standing fact the widget refuses to keep on screen — a transient
line is right for change and wrong for state, and a footer is the reverse: it
costs nothing to keep and is read when someone wonders. Hosts that render
statuses (pi's own footer, or a themed one) pick it up; hosts that do not ignore
it. `I18N_KIT_STATUS=off` disables it.

## Configuration

| Variable | Effect |
|---|---|
| `I18N_KIT_WIDGET_PLACEMENT=aboveEditor` | Move the widget above the editor (default: below) |
| `I18N_KIT_WIDGET_LINGER_MS` | How long a settled confirmation stays before withdrawing (default: 15000) |
| `I18N_KIT_WIDGET_DEBOUNCE_MS` | Delay before refreshing after a tool writes (default: 1500) |
| `I18N_KIT_WIDGET_DEBUG=<file>` | Append every decision the widget makes to a file |
| `I18N_KIT_WIDGET_STYLE=plain` | No colour, no spinner, plain text — for terminals that want none of it |
| `I18N_KIT_STATUS=off` | Stop publishing the footer status |

The extension prefers a project-local `the-i18n-cli`, then a global install,
then `npx @the-i18n-kit/cli@latest`.

## Other hosts

Claude Code gets guardrail hooks and a status line, Codex gets conventions —
see [harness integrations](https://fabkho.github.io/the-i18n-kit/getting-started/harness-integrations).
