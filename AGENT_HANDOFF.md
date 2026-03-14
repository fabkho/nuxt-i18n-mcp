# Agent Handoff — nuxt-i18n-mcp

## What This Project Is

An MCP (Model Context Protocol) server that gives AI coding agents structured tools for managing i18n translation files in Nuxt projects. Instead of the agent fumbling with nested JSON across 100+ locale files, it calls tools like `add_translations(key, { "de-DE": "...", "en-US": "..." })` and the server handles all the file I/O.

**Transport:** stdio (local MCP server, spawned by the host IDE)
**SDK:** TypeScript MCP SDK (`@modelcontextprotocol/sdk`)
**Build:** tsdown, pnpm, vitest

## Current State

Phases 1–4 are complete. Phase 5 (polish) is in progress with items 1–5 done.

- **10 tools**, **2 prompts**, **1 resource template**
- **141 tests** across 8 test files
- Build produces single `dist/index.js` (~60KB)
- Tested with MCP Inspector, Zed (tools + prompts), and VS Code (tools + prompts + sampling)

## Project Structure

```
src/
├── index.ts                  # Entry point — stdio transport
├── server.ts                 # MCP server — all tools, prompts, resources registered here
├── config/
│   ├── detector.ts           # Config auto-detection via @nuxt/kit loadNuxt()
│   ├── nuxt-loader.ts        # Dynamic @nuxt/kit import from project's node_modules
│   ├── project-config.ts     # .i18n-mcp.json loader and validator
│   └── types.ts              # I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig
├── io/
│   ├── json-reader.ts        # JSON file reader with mtime-based caching
│   ├── json-writer.ts        # Atomic JSON writer with format preservation
│   └── key-operations.ts     # Nested JSON manipulation via dot-paths
└── utils/
    ├── errors.ts             # ConfigError, FileIOError, ToolError
    └── logger.ts             # All output to stderr (never stdout)

tests/
├── config/
│   ├── detector.test.ts      # Integration tests against playground (14 tests)
│   └── project-config.test.ts # .i18n-mcp.json loading/validation (8 tests)
├── io/
│   ├── json-reader.test.ts   # Indentation detection (8 tests)
│   ├── json-writer.test.ts   # Write, mutate, format preservation (13 tests)
│   └── key-operations.test.ts # get/set/remove/rename/sort on nested objects (30 tests)
└── tools/
    ├── missing-and-search.test.ts    # get_missing + search logic (15 tests)
    ├── remove-and-rename.test.ts     # remove + rename across locales (24 tests)
    └── translate-and-prompts.test.ts # translate_missing + prompt assembly (29 tests)

playground/                   # Real Nuxt 4 project for integration testing
├── nuxt.config.ts            # Root layer: 4 locales (de, en, fr, es)
├── i18n/locales/             # Root locale files (common.* namespace)
├── .i18n-mcp.json            # Example project config
└── app-admin/                # App layer extending root
    ├── nuxt.config.ts        # extends: ['../']
    └── i18n/locales/         # Admin locale files (admin.* namespace)
                              # es-ES intentionally missing admin.users.* keys
```

## Tools (10)

| Tool | Purpose | Phase |
|------|---------|-------|
| `detect_i18n_config` | Load Nuxt config, return locales, layers, project config | 1 |
| `list_locale_dirs` | List locale directories with file counts and top-level keys | 1 |
| `get_translations` | Read values for dot-path keys from a layer/locale | 1 |
| `add_translations` | Add new keys across locales (fails if key exists) | 1 |
| `update_translations` | Update existing keys (fails if key doesn't exist) | 1 |
| `get_missing_translations` | Find keys in reference locale missing from targets | 2 |
| `search_translations` | Search by key pattern or value substring | 2 |
| `remove_translations` | Remove keys from all locales in a layer (dry-run support) | 3 |
| `rename_translation_key` | Rename/move a key across all locales (dry-run + conflict detection) | 3 |
| `translate_missing` | Auto-translate via MCP sampling, fallback for non-sampling hosts | 4 |

## Prompts (2)

| Prompt | Purpose |
|--------|---------|
| `add-feature-translations` | Guided workflow for adding translations for a new feature |
| `fix-missing-translations` | Find and fix all translation gaps across the project |

Both prompts include project config context (glossary, layer rules, examples) when available.

## Resources (1)

| Template | Purpose |
|----------|---------|
| `i18n:///{layer}/{file}` | Browse/read locale JSON files. Requires `detect_i18n_config` to be called first. |

## Key Files to Read

1. **`src/server.ts`** — Start here. All 10 tools, 2 prompts, 1 resource template. Also contains prompt assembly helpers (`buildTranslationSystemPrompt`, `buildTranslationUserMessage`, `buildFallbackContext`).
2. **`src/config/detector.ts`** — Config auto-detection via `@nuxt/kit` `loadNuxt()`. Resolves the full Nuxt config including layers. Caches result by `projectDir`. Calls `loadProjectConfig()` for `.i18n-mcp.json`.
3. **`src/config/types.ts`** — All type definitions: `I18nConfig`, `LocaleDefinition`, `LocaleDir`, `ProjectConfig`.
4. **`src/io/key-operations.ts`** — Nested JSON manipulation: `getNestedValue`, `setNestedValue`, `removeNestedValue`, `renameNestedKey`, `hasNestedKey`, `getLeafKeys`, `sortKeysDeep`, `validateTranslationValue`, `getTranslationStats`.
5. **`src/io/json-reader.ts`** — JSON reading with mtime-based file cache. `detectIndentation()` for format preservation.
6. **`src/io/json-writer.ts`** — Atomic writes (temp file + rename), alphabetical key sorting, format preservation. Invalidates reader cache on write.
7. **`PLAN.md`** — Full implementation plan. Section 12 has phase checkboxes. Sections 4–6 cover config detection, JSON I/O, and tool specs.

## Important Architectural Notes

- **Never write to stdout** — it corrupts the JSON-RPC protocol. All logging goes to stderr via `src/utils/logger.ts`.
- **Locales are duplicated across layers intentionally.** Both root and app layers define the same locale codes. Each layer has its own JSON files with different key namespaces. The agent decides which layer to write to.
- **The server is project-agnostic.** It uses `@nuxt/kit` `loadNuxt()` to resolve config, not regex parsing. No hardcoded paths.
- **Config detection is cached.** `detectI18nConfig()` caches by `projectDir`. Call `clearConfigCache()` to reset.
- **File reads are cached.** `readLocaleFile()` caches by file path + mtime. Cache is invalidated automatically on writes. Call `clearFileCache()` to reset.
- **Resources require prior config detection.** The resource template uses `getCachedConfig()` — returns empty list if `detect_i18n_config` hasn't been called yet.
- **Layer naming:** When pointing at `app-admin/`, it becomes `'root'` (the project entry point) and the extended parent becomes `'playground'` (basename of its dir). This is the `deriveLayerName()` function in `detector.ts`.
- **Sampling support varies by host.** VS Code supports MCP sampling (`createMessage()`). Zed does not (as of July 2025). The `translate_missing` tool detects this at runtime via `clientCapabilities.sampling` and falls back to returning context for the agent to translate inline.
- **Error codes.** Tool errors use `ToolError` with structured codes: `LOCALE_NOT_FOUND`, `LAYER_NOT_FOUND`, `LAYER_IS_ALIAS`, `SAME_KEY`, `REFERENCE_LOCALE_NOT_FOUND`, `NO_LOCALE_FILE`. These appear as `[CODE] message` in error responses.
- **Soft validation on writes.** `add_translations` and `update_translations` call `validateTranslationValue()` and include warnings (unbalanced placeholders, malformed linked refs) in the response without blocking the write.

## Playground Test Data

- **Root layer** (`playground/i18n/locales/`): 4 locales (de-DE, en-US, fr-FR, es-ES), all complete with identical `common.actions.*`, `common.messages.*`, `common.navigation.*` keys.
- **App-admin layer** (`playground/app-admin/i18n/locales/`): 4 locales with `admin.dashboard.*` and `admin.users.*` keys. **es-ES intentionally missing `admin.users.*`** (3 keys) for testing `get_missing_translations` and `translate_missing`.
- **`.i18n-mcp.json`** at playground root: example project config with layer rules, glossary, translation prompt, locale notes, and a few-shot example.

## What's Left (Phase 5 remaining + backlog)

### Phase 5 — remaining items
- [ ] `.i18n-mcp.json` JSON schema for IDE autocompletion
- [ ] README with setup instructions
- [ ] Team documentation and onboarding guide

### Backlog (see PLAN.md Section 18)
- `move_translations` — move keys between layers
- File watching — notify agent when locale files change on disk
- Translation memory — cache previous translations for consistency
- Key usage analysis — scan Vue/TS source for unused keys
- Glossary validation — check translations against glossary
- Auto-generate `.i18n-mcp.json` — propose glossary/rules from existing translations
- Flat JSON support — `flatJson: true` in vue-i18n config

## Commands

```sh
pnpm build          # Build via tsdown → dist/index.js
pnpm test           # Run all 141 tests
pnpm typecheck      # tsc --noEmit
pnpm start          # Start the MCP server on stdio
pnpm inspect        # Open MCP Inspector for manual testing
```
