# nuxt-i18n-mcp

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]
[![CI][ci-src]][ci-href]

Give your AI coding agent superpowers for managing i18n translations in Nuxt projects. Instead of the agent fumbling with nested JSON across dozens of locale files, it calls structured tools — and the server handles atomic writes, format preservation, alphabetical key sorting, the works.

Works with any [MCP](https://modelcontextprotocol.io/)-compatible host: **VS Code**, **Cursor**, **Zed**, **Claude Desktop**, and more.

## Why?

Managing translation files by hand is tedious. Letting an AI agent edit raw JSON is fragile. This MCP server sits in between — it auto-detects your Nuxt config (layers, locales, directories) via `@nuxt/kit` and exposes **13 tools** the agent can call to read, write, search, analyse, and translate your i18n files with full confidence.

- **Zero config** — points at your project, reads `nuxt.config.ts` (including layers), done.
- **Safe writes** — atomic file I/O, format preservation, sorted keys, placeholder validation.
- **Project-aware** — optional `.i18n-mcp.json` gives the agent your glossary, tone, layer rules, and few-shot examples.

## Quick Start

### 1. Install

```bash
pnpm add -D nuxt-i18n-mcp
```

> Requires `@nuxt/kit` as a peer dependency (resolved from your project's `node_modules`).

### 2. Configure your MCP host

<details>
<summary><strong>VS Code / Cursor</strong></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "nuxt-i18n-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["node_modules/nuxt-i18n-mcp/dist/index.js"]
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
      "command": {
        "path": "node",
        "args": ["node_modules/nuxt-i18n-mcp/dist/index.js"]
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json` (needs absolute paths):

```json
{
  "mcpServers": {
    "nuxt-i18n-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/your-project/node_modules/nuxt-i18n-mcp/dist/index.js"]
    }
  }
}
```

</details>

### 3. Ask your agent

That's it. Just ask your agent to work with translations — it discovers the tools automatically:

> *"Add a 'save changes' button translation in all locales"*
>
> *"Find and fix all missing translations in the admin layer"*
>
> *"Rename `common.actions.delete` to `common.actions.remove` across all locales"*

## Features

### 🔍 Auto-Detection

The server uses `@nuxt/kit` to load your actual Nuxt config — including layers, locale definitions, and directory structure. No manual paths, no config duplication. Point it at any app in a monorepo and it discovers the full layer tree automatically.

### ✏️ Safe Reads & Writes

All file operations go through a purpose-built I/O layer:
- **Atomic writes** — temp file + rename, never half-written JSON
- **Format preservation** — detects your indentation style (tabs, 2-space, 4-space) and keeps it
- **Sorted keys** — alphabetical at every nesting level, clean diffs, BabelEdit-compatible
- **Validation** — warns on unbalanced `{placeholders}`, malformed `@:linked` refs, and HTML in values

### 🌍 Translation Management

A full toolkit for the translation lifecycle:
- **Add, update, remove, rename** keys across all locale files in one call
- **Find missing translations** — including empty strings (`""`) treated as missing
- **Search** by key pattern or value substring
- **Auto-translate** via MCP sampling (host LLM) with glossary, tone, and locale-specific instructions

### 🔎 Code Analysis

Find what's actually used and what's dead weight:
- **Orphan detection** — keys in JSON but never referenced in Vue/TS source
- **Usage scanning** — where each key is called, with file paths and line numbers
- **One-step cleanup** — find orphans and remove them (dry-run by default)

Scans `$t('key')`, `t('key')`, and `this.$t('key')` patterns. Dynamic keys using template literals are detected and flagged so you can review them manually.

### 📋 Guided Workflows

Two built-in prompts the agent can use:
- **`add-feature-translations`** — walks through adding translations for a new feature: picks the right layer, creates keys, translates to all locales
- **`fix-missing-translations`** — finds all translation gaps across the project and fixes them

Both prompts include your project config (glossary, layer rules, examples) when available.

## Workflow Examples

### Adding translations for a new feature

> **You:** *"Add translations for a new 'booking confirmed' success message in the admin panel"*

The agent will:
1. Call `detect_i18n_config` to learn about your project
2. Read your `.i18n-mcp.json` layer rules to pick the right layer (`app-admin`)
3. Call `search_translations` to check for existing similar keys
4. Call `add_translations` with all locales, following your glossary and tone

### Fixing missing translations before release

> **You:** *"Check for any missing translations and fix them"*

The agent will:
1. Call `get_missing_translations` across all layers
2. Call `translate_missing` which uses your glossary, locale notes, and few-shot examples to produce consistent translations
3. Report what was added, with placeholder and linked-ref validation warnings

### Cleaning up unused keys

> **You:** *"Find and remove any translation keys that aren't used in code"*

The agent will:
1. Call `cleanup_unused_translations` with dry-run to preview orphan keys
2. Show you the list, noting any dynamic key references that can't be statically resolved
3. After your confirmation, run again with `dryRun: false` to remove them

### Renaming a key

> **You:** *"Rename `common.actions.delete` to `common.actions.remove` everywhere"*

The agent will:
1. Call `scan_code_usage` to show where the key is currently referenced
2. Call `rename_translation_key` which renames across all locale files, with conflict detection
3. Remind you to update the `$t()` calls in your source code

## Tools Reference

### Config & Discovery

| Tool | What it does |
|------|-------------|
| `detect_i18n_config` | Loads your Nuxt config and returns locales, layers, directories, and project config |
| `list_locale_dirs` | Lists locale directories grouped by layer, with file counts and key namespaces |

### Read & Search

| Tool | What it does |
|------|-------------|
| `get_translations` | Reads values for dot-path keys from a locale/layer. Pass `*` as locale to read all |
| `get_missing_translations` | Finds keys in a reference locale that are missing or empty in targets |
| `search_translations` | Searches by key pattern or value substring |

### Write & Modify

| Tool | What it does |
|------|-------------|
| `add_translations` | Adds new keys across locales (fails if key exists) |
| `update_translations` | Updates existing keys (fails if key doesn't exist) |
| `remove_translations` | Removes keys from all locale files in a layer (dry-run support) |
| `rename_translation_key` | Renames/moves a key across all locales (conflict detection + dry-run) |
| `translate_missing` | Auto-translates using MCP sampling or returns context for inline translation |

### Code Analysis

| Tool | What it does |
|------|-------------|
| `find_orphan_keys` | Finds keys in JSON not referenced in any Vue/TS source code |
| `scan_code_usage` | Shows where keys are used — file paths, line numbers, call patterns |
| `cleanup_unused_translations` | Finds orphan keys + removes them in one step (dry-run by default) |

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
      "layer": "root",
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

## Good to Know

- **stdout is sacred** — the server never writes to stdout (that's the JSON-RPC transport). All logging goes to stderr.
- **Empty strings are missing** — `get_missing_translations` and `translate_missing` treat `""` as missing, matching BabelEdit behaviour.
- **Caching** — config detection and file reads are cached (mtime-based). Writes invalidate automatically.
- **Sampling support varies** — VS Code supports MCP sampling for `translate_missing`. Zed doesn't yet — the tool falls back to returning context for the agent to translate inline. Both paths work.
- **Monorepo support** — each `app-*` directory is an independent Nuxt app. Point the agent at an app directory and it discovers the root layer via `extends`.

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