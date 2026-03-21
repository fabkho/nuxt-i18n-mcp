# nuxt-i18n-mcp

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]
[![CI][ci-src]][ci-href]

An MCP server that lets AI agents manage i18n translations in Nuxt projects — without stuffing entire locale files into context.

On large projects, translation files can be thousands of lines. Opening them eats context, and edits across dozens of locale files are error-prone. This server gives the agent structured tools that read and write only the keys it needs, keeping context small and operations safe. Feed it a glossary, tone guidelines, and per-locale instructions so translations stay consistent — even across teams.

Works with any [MCP](https://modelcontextprotocol.io/)-compatible host: **VS Code**, **Cursor**, **Zed**, **Claude Desktop**, and more.

## Quick Start

### 1. Configure your MCP host

No install needed — your MCP host runs the server via `npx`.

<details>
<summary><strong>VS Code / Cursor</strong></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "nuxt-i18n-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["nuxt-i18n-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Zed</strong></summary>

Add to `.zed/settings.json`:

```json
{
  "context_servers": {
    "nuxt-i18n-mcp": {
      "command": "npx",
      "args": ["nuxt-i18n-mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nuxt-i18n-mcp": {
      "command": "npx",
      "args": ["nuxt-i18n-mcp"]
    }
  }
}
```

</details>

### 2. Ask your agent

That's it — no configuration needed. The server auto-detects your Nuxt config, layers, locales, and directory structure via `@nuxt/kit`. Just ask:

> *"Add a 'save changes' button translation in all locales"*
>
> *"Find and fix all missing translations in the admin layer"*
>
> *"Rename `common.actions.delete` to `common.actions.remove` across all locales"*

## Features

- **🔍 Zero config** — reads `nuxt.config.ts` (including layers) automatically. No manual paths, no config duplication. Works in monorepos — point at any app and it discovers the full layer tree.
- **✏️ Safe writes** — atomic file I/O (temp file + rename), indentation preservation, alphabetical key sorting, and validation for `{placeholders}`, `@:linked` refs, and HTML in values.
- **🌍 Full translation lifecycle** — add, update, remove, rename, search, find missing, and auto-translate keys across all locale files in a single tool call.
- **🔎 Code analysis** — find orphan keys not referenced in source, scan where keys are used (file + line number), and clean up dead translations in one step.
- **📋 Project-aware** — optional `.i18n-mcp.json` gives the agent your glossary, tone, layer rules, locale-specific instructions, and few-shot examples.

## Tools

| Tool | Description |
|------|-------------|
| `detect_i18n_config` | Loads your Nuxt config and returns locales, layers, directories, and project config |
| `list_locale_dirs` | Lists locale directories grouped by layer, with file counts and key namespaces |
| `get_translations` | Reads values for specific dot-path keys from a locale/layer (`*` for all locales) |
| `get_missing_translations` | Finds keys in a reference locale that are missing or empty in targets |
| `find_empty_translations` | Finds keys with empty string values in locale files (checks each locale independently) |
| `search_translations` | Searches by key pattern or value substring |
| `add_translations` | Adds new keys across locales (fails if key exists) |
| `update_translations` | Updates existing keys (fails if key doesn't exist) |
| `remove_translations` | Removes keys from all locale files in a layer (dry-run support) |
| `rename_translation_key` | Renames/moves a key across all locales (conflict detection + dry-run) |
| `translate_missing` | Auto-translates via MCP sampling or returns context for inline translation |
| `find_orphan_keys` | Finds keys in JSON not referenced in any Vue/TS source code |
| `scan_code_usage` | Shows where keys are used — file paths, line numbers, call patterns |
| `cleanup_unused_translations` | Finds orphan keys + removes them in one step (dry-run by default) |

The server also exposes two guided **prompts** (`add-feature-translations`, `fix-missing-translations`) and a **resource template** (`i18n:///{layer}/{file}`) for browsing locale files.

## Project Config

Optionally drop a `.i18n-mcp.json` at your project root to give the agent project-specific context. Everything is optional — the server passes it to the agent, which interprets the natural-language rules.

For IDE autocompletion, point to the schema:

```json
{
  "$schema": "node_modules/nuxt-i18n-mcp/schema.json"
}
```

| Field | Purpose |
|-------|---------|
| `context` | Free-form project background (what the app is, who uses it, what tone) |
| `layerRules` | Rules for which layer a key belongs to, with plain-English `when` conditions |
| `glossary` | Term dictionary for consistent translations |
| `translationPrompt` | System prompt prepended to all translation requests |
| `localeNotes` | Per-locale instructions (e.g., "Formal German using 'Sie'") |
| `examples` | Few-shot translation examples demonstrating your project's style |

<details>
<summary><strong>Full example</strong></summary>

```json
{
  "$schema": "node_modules/nuxt-i18n-mcp/schema.json",
  "context": "B2B SaaS booking platform. Professional but approachable tone.",
  "layerRules": [
    {
      "layer": "shared",
      "description": "Shared translations: common.actions.*, common.messages.*",
      "when": "The key is generic enough to be used in multiple apps"
    },
    {
      "layer": "app-admin",
      "description": "Admin dashboard translations",
      "when": "The key is only relevant to admin functionality"
    }
  ],
  "glossary": {
    "Buchung": "Booking (never 'Reservation')",
    "Ressource": "Resource (a bookable entity like a room, desk, or person)",
    "Termin": "Appointment"
  },
  "translationPrompt": "Use professional but approachable tone. Preserve all {placeholders}. Keep translations concise.",
  "localeNotes": {
    "de-DE-formal": "Formal German using 'Sie'. Used by enterprise customers.",
    "en-US": "American English.",
    "en-GB": "British English. Use 'colour' not 'color'."
  },
  "examples": [
    {
      "key": "common.actions.save",
      "de-DE": "Speichern",
      "en-US": "Save",
      "note": "Concise, imperative"
    }
  ]
}
```

See [`playground/.i18n-mcp.json`](playground/.i18n-mcp.json) for a working example.

</details>

## Roadmap

- [ ] `find_hardcoded_strings` — detect user-facing strings not wrapped in `$t()`
- [ ] `move_translations` — move keys between layers (e.g., promote to shared)
- [ ] Glossary validation — check translations against glossary terms
- [ ] Flat JSON support — `flatJson: true` in vue-i18n config
- [ ] Pluralization support — vue-i18n plural forms
- [ ] Plain vue-i18n support — extract core into a monorepo, add a Vue/Vite adapter alongside the Nuxt one

## Good to Know

- **Empty strings are missing** — `get_missing_translations` and `translate_missing` treat `""` as missing, matching BabelEdit behaviour.
- **Caching** — config detection and file reads are cached (mtime-based). Writes invalidate automatically.
- **Sampling support varies** — VS Code supports MCP sampling for `translate_missing`. Zed doesn't yet — the tool falls back to returning context for the agent to translate inline. Both paths work.

## Development

```bash
pnpm build          # Build via tsdown → dist/index.js
pnpm test           # Run all tests
pnpm test:perf      # Run performance benchmarks
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm start          # Start the server on stdio
pnpm inspect        # Open MCP Inspector for manual testing
```

## License

[MIT](./LICENSE)

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/nuxt-i18n-mcp?style=flat&colorA=18181b&colorB=4fc08d
[npm-version-href]: https://npmjs.com/package/nuxt-i18n-mcp

[npm-downloads-src]: https://img.shields.io/npm/dm/nuxt-i18n-mcp?style=flat&colorA=18181b&colorB=4fc08d
[npm-downloads-href]: https://npmjs.com/package/nuxt-i18n-mcp

[license-src]: https://img.shields.io/npm/l/nuxt-i18n-mcp?style=flat&colorA=18181b&colorB=4fc08d
[license-href]: https://github.com/fabkho/nuxt-i18n-mcp/blob/main/LICENSE

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt.js&logoColor=4fc08d
[nuxt-href]: https://nuxt.com

[ci-src]: https://github.com/fabkho/nuxt-i18n-mcp/actions/workflows/ci.yml/badge.svg
[ci-href]: https://github.com/fabkho/nuxt-i18n-mcp/actions/workflows/ci.yml
