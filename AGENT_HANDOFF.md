# Agent Handoff — nuxt-i18n-mcp

## What This Project Is

An MCP (Model Context Protocol) server that gives AI coding agents structured tools for managing i18n translation files in Nuxt projects. Instead of the agent fumbling with nested JSON across 100+ locale files, it calls tools like `add_translations(key, { "de-DE": "...", "en-US": "..." })` and the server handles all the file I/O.

**Transport:** stdio (local MCP server, spawned by the host IDE)
**SDK:** TypeScript MCP SDK (`@modelcontextprotocol/sdk`)
**Build:** tsdown, pnpm, vitest
**Lint:** ESLint 10 (flat config) + typescript-eslint
**Commits:** Conventional Commits enforced via commitlint + Husky
**CI/CD:** GitHub Actions (CI on push/PR) + Release Please (automated versioning + npm publish)
**Repo:** `github.com:fabkho/nuxt-i18n-mcp` (private, alpha)
**Version:** `0.1.0-alpha.1`

## Current State

All 5 phases complete + code analysis tools added. In alpha testing on a real Nuxt monorepo.

- **13 tools**, **2 prompts**, **1 resource template**
- **179 tests** across 9 test files + 34 perf benchmarks
- Build produces single `dist/index.js` (~75KB)
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
├── scanner/
│   └── code-scanner.ts       # Source code scanner — extracts $t()/ t() key references
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
├── perf/
│   └── benchmark.test.ts     # Performance benchmarks (34 tests, excluded from default run)
├── scanner/
│   └── code-scanner.test.ts  # Key extraction, false positives, file walking (47 tests)
└── tools/
    ├── missing-and-search.test.ts    # get_missing + search logic (16 tests)
    ├── remove-and-rename.test.ts     # remove + rename across locales (14 tests)
    └── translate-and-prompts.test.ts # translate_missing + prompt assembly (29 tests)

.github/
└── workflows/
    ├── ci.yml                # Lint + typecheck + test + build (Node 18 & 22 matrix)
    └── release.yml           # Release Please + npm publish on tag

playground/                   # Real Nuxt 4 project for integration testing
├── nuxt.config.ts            # Root layer: 4 locales (de, en, fr, es)
├── i18n/locales/             # Root locale files (common.* namespace)
├── .i18n-mcp.json            # Example project config (references schema.json)
└── app-admin/                # App layer extending root
    ├── nuxt.config.ts        # extends: ['../']
    └── i18n/locales/         # Admin locale files (admin.* namespace)
                              # es-ES intentionally missing admin.users.* keys
                              # fr-FR has admin.users.edit set to "" (empty-as-missing test)

eslint.config.js              # ESLint flat config — typescript-eslint + no-console
commitlint.config.ts          # Conventional commits enforcement
release-please-config.json    # Release Please package config
.release-please-manifest.json # Current version tracker for Release Please
schema.json                   # JSON Schema for .i18n-mcp.json (2020-12)
LICENSE                       # MIT
CHANGELOG.md                  # Auto-maintained by Release Please
```

## Tools (13)

### Config & Discovery
| Tool | Purpose |
|------|---------|
| `detect_i18n_config` | Load Nuxt config, return locales, layers, project config |
| `list_locale_dirs` | List locale directories with file counts and top-level keys |

### Read & Search
| Tool | Purpose |
|------|---------|
| `get_translations` | Read values for dot-path keys from a layer/locale |
| `get_missing_translations` | Find keys in reference locale missing (or empty) from targets |
| `search_translations` | Search by key pattern or value substring |

### Write & Modify
| Tool | Purpose |
|------|---------|
| `add_translations` | Add new keys across locales (fails if key exists) |
| `update_translations` | Update existing keys (fails if key doesn't exist) |
| `remove_translations` | Remove keys from all locales in a layer (dry-run support) |
| `rename_translation_key` | Rename/move a key across all locales (dry-run + conflict detection) |
| `translate_missing` | Auto-translate via MCP sampling, fallback for non-sampling hosts |

### Code Analysis
| Tool | Purpose |
|------|---------|
| `find_orphan_keys` | Keys in JSON but not referenced in any Vue/TS source code |
| `scan_code_usage` | Where each key is used — file paths, line numbers, call patterns |
| `cleanup_unused_translations` | Find orphan keys + remove them in one step (dry-run by default) |

## Prompts (2)

| Prompt | Purpose |
|--------|---------|
| `add-feature-translations` | Guided workflow for adding translations for a new feature |
| `fix-missing-translations` | Find and fix all translation gaps across the project |

## Resources (1)

| Template | Purpose |
|----------|---------|
| `i18n:///{layer}/{file}` | Browse/read locale JSON files. Requires `detect_i18n_config` to be called first. |

## Key Files to Read

1. **`src/server.ts`** — Start here. All 13 tools, 2 prompts, 1 resource template. Contains `toolErrorResponse()` helper, `applyTranslations()` shared logic for add/update, and prompt assembly helpers (`buildTranslationSystemPrompt`, `buildTranslationUserMessage`, `buildFallbackContext`).
2. **`src/scanner/code-scanner.ts`** — Source code scanner. Uses `tinyglobby` for file discovery. Extracts `$t('key')`, `t('key')`, `this.$t('key')` references via regex. Detects dynamic keys with template literals. Three exports: `extractKeys()`, `scanSourceFiles()`, `toRelativePath()`.
3. **`src/config/detector.ts`** — Config auto-detection via `@nuxt/kit` `loadNuxt()`. Resolves the full Nuxt config including layers. Caches result by `projectDir`. Calls `loadProjectConfig()` for `.i18n-mcp.json`.
4. **`src/config/types.ts`** — All type definitions: `I18nConfig`, `LocaleDefinition`, `LocaleDir`, `ProjectConfig`.
5. **`src/io/key-operations.ts`** — Nested JSON manipulation: `getNestedValue`, `setNestedValue`, `removeNestedValue`, `renameNestedKey`, `hasNestedKey`, `getLeafKeys`, `sortKeysDeep`, `validateTranslationValue`.
6. **`src/io/json-reader.ts`** — JSON reading with mtime-based file cache. `detectIndentation()` for format preservation.
7. **`src/io/json-writer.ts`** — Atomic writes (temp file + rename), alphabetical key sorting, format preservation. `mutateLocaleFile()` is the primary write entry point used by all tools.
8. **`PLAN.md`** — Full implementation plan. Section 12 has phase checkboxes. Section 18 has the backlog.

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
- **`add_translations` and `update_translations` share logic** via `applyTranslations()` in `server.ts`. The `mode` parameter (`'add'` | `'update'`) controls the exists/not-exists check direction.
- **`translate_missing` accumulates across batches** and does a single `mutateLocaleFile` write per locale file rather than one per batch.
- **Empty strings are missing.** `get_missing_translations` and `translate_missing` treat keys with `""` values as missing, not just absent keys. This matches what BabelEdit reports.
- **Code scanner uses regex, not AST.** The `extractKeys()` function uses regex patterns to find `$t()` / `t()` / `this.$t()` calls. Bare `t('word')` without a dot is filtered out to avoid false positives from `emit()`, `import()`, etc. Dynamic keys (template literals with `${}`) are flagged but not resolved.
- **`cleanup_unused_translations` defaults to dry-run.** The agent must explicitly pass `dryRun: false` to delete keys.
- **Monorepo support.** Each `app-*` is an independent Nuxt app that extends root. The root doesn't know about child apps. To scan an app, point `projectDir` at the app directory — it discovers the root layer via `extends`.

## Playground Test Data

- **Root layer** (`playground/i18n/locales/`): 4 locales (de-DE, en-US, fr-FR, es-ES), all complete with identical `common.actions.*`, `common.messages.*`, `common.navigation.*` keys.
- **App-admin layer** (`playground/app-admin/i18n/locales/`): 4 locales with `admin.dashboard.*` and `admin.users.*` keys. **es-ES intentionally missing `admin.users.*`** (3 keys) for testing `get_missing_translations` and `translate_missing`. **fr-FR has `admin.users.edit` set to `""`** for testing empty-as-missing detection.
- **`.i18n-mcp.json`** at playground root: example project config with layer rules, glossary, translation prompt, locale notes, and a few-shot example. References `../schema.json`.

## Performance Profile

Benchmarked at 3000–5000 leaf keys (~8000 JSON lines):

| Operation | Time |
|-----------|------|
| `getLeafKeys` (5000 keys) | 0.36ms |
| `sortKeysDeep` (5000 keys) | 0.75ms |
| `readLocaleFile` cold (3000 keys) | 1.5ms |
| `readLocaleFile` cached (3000 keys) | 0.34ms |
| `writeLocaleFile` (3000 keys) | 1.2ms |
| `detectI18nConfig` cold | ~800ms |
| `detectI18nConfig` cached | <0.001ms |
| Full `add_translations` (20 keys into 3000-key file) | 3.2ms |

No bottlenecks. `loadNuxt` (~800ms cold) is the only slow path and it's cached after first call.

## Dependencies

**Runtime:**
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `zod` — Input schema validation
- `tinyglobby` — Fast file discovery for code scanner (unjs ecosystem)

**Peer:**
- `@nuxt/kit` — Resolved from the target project's `node_modules`

**Dev:**
- `eslint` + `typescript-eslint` — Linting with TypeScript-aware rules
- `@commitlint/cli` + `@commitlint/config-conventional` — Conventional commit enforcement
- `husky` — Git hooks (pre-commit: lint + typecheck, commit-msg: commitlint)
- `tsdown` — Build toolchain
- `typescript` — Type checking
- `vitest` — Test runner

## Backlog

### Higher priority
- [ ] `find_hardcoded_strings` — user-facing strings not wrapped in `$t()`
- [ ] `move_translations` — move keys between layers
- [ ] Multi-app discovery — auto-detect `app-*` subdirectories so the agent doesn't need to target each one
- [ ] Glossary validation — check translations against glossary terms
- [ ] Auto-generate `.i18n-mcp.json` — propose config from existing translations

### Lower priority
- [ ] Flat JSON support — `flatJson: true` in vue-i18n config
- [ ] File watching — `fs.watch` + MCP notifications (revisit when host support matures)

### Infrastructure (before public release)
- [x] GitHub Actions — CI (lint, typecheck, test on Node 18 & 22) + publish workflow
- [x] Semantic versioning — conventional commits (commitlint + Husky) + Release Please
- [x] CHANGELOG.md — auto-maintained by Release Please
- [x] LICENSE — MIT
- [x] ESLint — flat config with typescript-eslint, `no-console` enforced (protects stdio transport)
- [ ] README badges (CI, npm version, license)

## CI/CD Architecture

### CI (`ci.yml`)
- **Triggers:** Push to `main`, PRs targeting `main`
- **Matrix:** Node 18 + 22 on `ubuntu-latest`
- **Steps:** Install → Lint → Typecheck → Test → Build
- **Concurrency:** Cancels in-progress runs for the same branch/PR

### Release (`release.yml`)
- **Triggers:** Push to `main` (after CI passes)
- **Job 1 — Release Please:** Opens/updates a release PR that bumps version + updates CHANGELOG. When merged, creates a GitHub Release + git tag.
- **Job 2 — Publish:** Runs only when a release is created. Builds and publishes to npm.
- **Requires:** `NPM_TOKEN` secret in GitHub repo settings.

### Git Hooks (Husky)
- **pre-commit:** `pnpm lint && pnpm typecheck`
- **commit-msg:** `pnpm exec commitlint --edit "$1"` — enforces conventional commit format

### Release Please Config
- `release-please-config.json` — package config (node release type, bump-minor-pre-major)
- `.release-please-manifest.json` — tracks current version (`0.1.0-alpha.1`)
- Version bumps follow conventional commits: `feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE` → major (after 1.0)

## Commands

```sh
pnpm build          # Build via tsdown -> dist/index.js
pnpm test           # Run all 179 tests
pnpm test:perf      # Run performance benchmarks
pnpm lint           # ESLint (typescript-eslint flat config)
pnpm typecheck      # tsc --noEmit
pnpm start          # Start the MCP server on stdio
pnpm inspect        # Open MCP Inspector for manual testing
```
