# Agent Handoff — nuxt-i18n-mcp

## What This Project Is

An MCP (Model Context Protocol) server that gives AI coding agents structured tools for managing i18n translation files in Nuxt projects. Instead of the agent fumbling with nested JSON across 100+ locale files, it calls tools like `add_translations(key, { "de-DE": "...", "en-US": "..." })` and the server handles all the file I/O.

**Transport:** stdio (local MCP server, spawned by the host IDE)
**SDK:** TypeScript MCP SDK (`@modelcontextprotocol/sdk`)
**Build:** tsdown, pnpm, vitest

## Key Files to Read First

1. **`PLAN.md`** — The full implementation plan. Sections 4-6 are the most important (config detection, JSON I/O, tool specs). Section 12 has the phase breakdown with checkboxes.
2. **`src/server.ts`** — The MCP server with all 5 Phase 1 tools registered (detect_i18n_config, list_locale_dirs, get_translations, add_translations, update_translations).
3. **`src/config/detector.ts`** — Config auto-detection via `@nuxt/kit` `loadNuxt()`. This is the core innovation — it resolves the full Nuxt config including layers.
4. **`src/config/types.ts`** — `I18nConfig`, `LocaleDefinition`, `LocaleDir` type definitions.
5. **`src/io/key-operations.ts`** — Nested JSON manipulation via dot-paths (get/set/remove/rename/sort).
6. **`playground/`** — A real Nuxt 4 project with `@nuxtjs/i18n`, a root layer (4 locales, `common.*` keys) and an `app-admin` layer (admin-specific keys). Spanish locale in app-admin intentionally has missing keys for testing.

## What's Done (Phase 1 ✅)

- MCP server with stdio transport, 5 tools
- Config auto-detection via `@nuxt/kit` (project-agnostic — works with any `@nuxtjs/i18n` setup)
- Layer discovery from `nuxt.options._layers` (handles root + app layers, aliased dirs)
- JSON reader/writer with format preservation (detects indent style, atomic writes, alphabetical key sorting)
- Key operations (get/set/remove/rename on nested JSON via dot-paths)
- Playground with root + app-admin layer
- **57 tests passing** (unit + integration against playground)
- Build produces single `dist/index.js` (21KB)

## What's Next (Phase 2)

Phase 2 is "Analysis, Search & Project Config." See `PLAN.md` Section 12 for the full checklist. The key items:

### 1. Project Config (`.i18n-mcp.json`) — Section 4.8 in PLAN.md
An optional JSON file at the project root that provides agent context: `layerRules` (which layer does a key belong to?), `glossary` (consistent terminology), `translationPrompt` (tone/style), `localeNotes` (per-locale context like formal/informal), and `examples` (few-shot translation style).

**To implement:**
- Create `src/config/project-config.ts` — read and validate `.i18n-mcp.json`
- Add `ProjectConfig` interface to `src/config/types.ts`
- Update `detector.ts` to look for `.i18n-mcp.json` and include it in the `I18nConfig` response
- Update `detect_i18n_config` tool in `server.ts` to return `projectConfig`
- Add `.i18n-mcp.json` example to playground
- Tests for loading with and without the config file

### 2. Tool: `get_missing_translations`
Compare locale files across layers to find keys present in the reference locale but missing in others. See Section 6.4 in PLAN.md.

### 3. Tool: `search_translations`
Search by key pattern or value substring across all locale files. See Section 6.10 in PLAN.md.

### 4. MCP Resources
Expose locale files as MCP resources (`i18n:///root/en-US.json`). See Section 7 in PLAN.md.

## Important Architectural Notes

- **Never write to stdout** — it corrupts the JSON-RPC protocol. All logging goes to stderr via `src/utils/logger.ts`.
- **Locales are duplicated across layers intentionally.** Both root and app layers define the same locale codes. Each layer has its own JSON files with different key namespaces. The agent decides which layer to write to.
- **The server is project-agnostic.** It uses `@nuxt/kit` `loadNuxt()` to resolve config, not regex parsing. No hardcoded paths.
- **Config detection is cached.** `detectI18nConfig()` caches by `projectDir`. Call `clearConfigCache()` to reset.
- **Layer naming:** When pointing at `app-admin/`, it becomes `'root'` (the project entry point) and the extended parent becomes `'playground'` (basename of its dir). This is the `deriveLayerName()` function in `detector.ts`.

## Commands

```sh
pnpm build          # Build via tsdown → dist/index.js
pnpm test           # Run all 57 tests
pnpm typecheck      # tsc --noEmit
pnpm start          # Start the MCP server on stdio
pnpm inspect        # Open MCP Inspector for manual testing
```
