# nuxt-i18n-mcp

An MCP server that gives AI coding agents structured tools for managing i18n translation files in Nuxt projects. Instead of the agent fumbling with nested JSON across dozens of locale files, it calls tools like `add_translations` and the server handles all the file I/O — atomic writes, format preservation, alphabetical key sorting, the works.

Works with any MCP-compatible host: VS Code, Zed, Claude Desktop, Cursor, etc.

## How it works

The server uses `@nuxt/kit` to load your actual Nuxt config (including layers), so it understands your project structure without any hardcoded paths. It discovers locale directories, reads and writes JSON translation files, and exposes everything through 13 MCP tools the agent can call.

The agent calls `detect_i18n_config` first to learn about the project, then uses the other tools to read, write, search, and manage translations. If you have a `.i18n-mcp.json` config file, the server passes your glossary, layer rules, and translation style to the agent so it follows your conventions.

## Setup

### Install

```sh
pnpm add -D nuxt-i18n-mcp
```

The server requires `@nuxt/kit` as a peer dependency (it resolves it from your project's `node_modules`).

### VS Code / Cursor

Add to `.vscode/mcp.json` in your project:

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

### Zed

Add to your project-level Zed settings (`.zed/settings.json`):

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

### Claude Desktop

Add to `claude_desktop_config.json`:

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

Claude Desktop needs absolute paths since it doesn't run from your project directory.

## Tools

The server exposes 13 tools. The agent discovers them automatically — you just ask it to do things like "add a save button translation in all locales" and it figures out which tools to call.

### Config & Discovery

| Tool | What it does |
|------|-------------|
| `detect_i18n_config` | Loads your Nuxt config via `@nuxt/kit` and returns locales, layers, directories, and project config. The agent should call this first. |
| `list_locale_dirs` | Lists all locale directories grouped by layer, with file counts and top-level key namespaces. Good for orientation. |

### Read & Search

| Tool | What it does |
|------|-------------|
| `get_translations` | Reads values for dot-path keys from a specific locale and layer. Pass `*` as locale to read from all locales at once. |
| `get_missing_translations` | Finds keys present in a reference locale but missing (or empty) in target locales. Scans one layer or all layers. |
| `search_translations` | Searches by key pattern or value substring. Useful for finding existing translations before adding duplicates. |

### Write & Modify

| Tool | What it does |
|------|-------------|
| `add_translations` | Adds new keys across locales. Fails if a key already exists (use `update_translations` instead). Keys are inserted alphabetically. |
| `update_translations` | Updates existing keys. Fails if a key doesn't exist (use `add_translations` instead). |
| `remove_translations` | Removes keys from all locale files in a layer. Supports dry-run mode. |
| `rename_translation_key` | Renames or moves a key across all locale files in a layer. Detects conflicts. Supports dry-run mode. |
| `translate_missing` | Finds missing keys and translates them. Uses MCP sampling (host LLM) if available, otherwise returns context for the agent to translate inline. Respects your glossary, translation prompt, and locale notes. |

### Code Analysis

| Tool | What it does |
|------|-------------|
| `find_orphan_keys` | Finds translation keys that exist in locale JSON files but aren't referenced in any Vue/TS source code. Reports dynamic key references that can't be statically resolved. |
| `scan_code_usage` | Scans source files to show where translation keys are used — file paths, line numbers, call patterns (`$t`, `t`, `this.$t`). Useful before renaming or removing a key. |
| `cleanup_unused_translations` | Combines orphan detection and removal in one step. Defaults to dry-run so the agent previews before deleting. |

The code analysis tools scan for `$t('key')`, `t('key')`, and `this.$t('key')` patterns in `.vue`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.mts` files. Dynamic keys using template literals (e.g., `` t(`prefix.${var}`) ``) are detected and flagged as unresolvable so you can review them manually.

### Prompts

Two guided workflows the agent can use:

| Prompt | What it does |
|--------|-------------|
| `add-feature-translations` | Walks through adding translations for a new feature — picks the right layer, creates keys, translates to all locales. |
| `fix-missing-translations` | Finds all translation gaps across the project and fixes them. |

Both prompts include your project config (glossary, layer rules, examples) when available.

### Resources

The server exposes locale files as browsable resources via the `i18n:///{layer}/{file}` URI template. This lets agents read translation files through the MCP resource protocol. Requires `detect_i18n_config` to be called first.

## Project config

Drop a `.i18n-mcp.json` file at your project root (next to `nuxt.config.ts`) to give the agent project-specific context. Everything in this file is optional — the server passes it straight to the agent, which interprets the natural-language rules.

For IDE autocompletion, point to the schema:

```json
{
  "$schema": "node_modules/nuxt-i18n-mcp/schema.json"
}
```

### Fields

#### `context`

Free-form project background. Tell the agent what your app is, who uses it, what tone to use.

```json
{
  "context": "B2B SaaS booking platform. Professional but approachable tone. Primary market is Germany."
}
```

#### `layerRules`

Rules for deciding which Nuxt layer a translation key belongs to. The agent reads the `when` field (plain English) and makes the call.

```json
{
  "layerRules": [
    {
      "layer": "root",
      "description": "Shared translations: common.actions.*, common.messages.*, common.navigation.*",
      "when": "The key is generic enough to be used in multiple apps (e.g., 'Save', 'Cancel', 'Loading...')"
    },
    {
      "layer": "app-admin",
      "description": "Admin dashboard translations.",
      "when": "The key is only relevant to admin functionality"
    }
  ]
}
```

#### `glossary`

Term dictionary for consistent translations. Keys are source terms, values describe the required translation or usage.

```json
{
  "glossary": {
    "Buchung": "Booking (never 'Reservation')",
    "Ressource": "Resource (a bookable entity like a room, desk, or person)",
    "Termin": "Appointment"
  }
}
```

#### `translationPrompt`

System prompt prepended to all translation requests. Sets tone, style, and constraints.

```json
{
  "translationPrompt": "You are translating for a SaaS booking platform. Use professional but approachable tone. Preserve all {placeholders}. Keep translations concise."
}
```

#### `localeNotes`

Per-locale context. Included in translation prompts when translating to that specific locale.

```json
{
  "localeNotes": {
    "de-DE-formal": "Formal German using 'Sie'. Used by enterprise customers.",
    "en-US": "American English.",
    "en-GB": "British English. Use 'colour' not 'color'."
  }
}
```

#### `examples`

Few-shot translation examples that demonstrate your project's style. Each example needs a `key` and one or more locale values. Add a `note` to explain the style choice.

```json
{
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

### Full example

See [playground/.i18n-mcp.json](playground/.i18n-mcp.json) for a complete working example.

## Notes

A few things worth knowing:

- **stdout is sacred.** The server never writes to stdout — that's the JSON-RPC transport. All logging goes to stderr.
- **Writes are atomic.** The server writes to a temp file first, then renames it. No half-written JSON files.
- **Format preservation.** The server detects your indentation style (tabs, 2-space, 4-space) and preserves it on write.
- **Keys are sorted.** All writes sort keys alphabetically. This keeps diffs clean and works well with tools like BabelEdit.
- **Empty strings are missing.** `get_missing_translations` and `translate_missing` treat keys with empty string values (`""`) as missing, not just absent keys. This matches what BabelEdit and other i18n tools report.
- **Caching.** Config detection and file reads are cached (mtime-based for files). Writes automatically invalidate the cache.
- **Sampling support varies.** VS Code supports MCP sampling, so `translate_missing` can call the host LLM directly. Zed doesn't (as of July 2025), so the tool falls back to giving the agent context to translate inline. Both paths work fine.
- **Layers can overlap.** Different layers can define the same locale codes with different key namespaces. The agent (guided by your `layerRules`) decides which layer to write to.
- **Monorepo with multiple apps.** If your project has multiple Nuxt apps that extend a shared root (e.g., `app-admin/`, `app-shop/`), point the agent at each app's directory — it'll discover the root layer automatically via the `extends` config.

## Development

```sh
pnpm build          # Build via tsdown -> dist/index.js
pnpm test           # Run all tests
pnpm test:perf      # Run performance benchmarks
pnpm typecheck      # tsc --noEmit
pnpm start          # Start the server on stdio
pnpm inspect        # Open MCP Inspector for manual testing
```

## License

MIT