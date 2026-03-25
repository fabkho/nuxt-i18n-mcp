# Multi-Framework Adapter Plan

> Restructure `nuxt-i18n-mcp` into a single-package, multi-framework i18n MCP server with internal adapters for **Nuxt**, **Vue (vue-i18n)**, and **Laravel**.

## Status Quo

The server is currently Nuxt-only. It uses `@nuxt/kit` to load Nuxt config, discover layers, and resolve locale directories. All 14 MCP tools operate on a framework-agnostic `I18nConfig` interface (`src/config/types.ts:64-79`) — the Nuxt coupling lives exclusively in the config detection layer.

### Current architecture

```
src/
├── config/
│   ├── detector.ts        ← Nuxt-specific: loadNuxt, extractI18nConfig, discoverLocaleDirs
│   ├── discovery.ts       ← Nuxt-specific: discoverNuxtApps, findNuxtConfig, deriveLayerName
│   ├── nuxt-loader.ts     ← Nuxt-specific: dynamic @nuxt/kit import
│   ├── project-config.ts  ← Framework-agnostic: .i18n-mcp.json loader
│   └── types.ts           ← Framework-agnostic: I18nConfig, LocaleDir, LocaleDefinition, ProjectConfig
├── io/
│   ├── json-reader.ts     ← Framework-agnostic: JSON locale file reading with mtime cache
│   ├── json-writer.ts     ← Framework-agnostic: atomic JSON writes, indent preservation
│   └── key-operations.ts  ← Framework-agnostic: nested key CRUD
├── scanner/
│   └── code-scanner.ts    ← Nuxt/Vue-coupled: $t(), t(), this.$t() patterns only
├── server.ts              ← Framework-agnostic: all 14 MCP tools operate on I18nConfig
├── utils/
│   ├── errors.ts          ← Framework-agnostic
│   └── logger.ts          ← Framework-agnostic
└── index.ts               ← Entry point
```

### What's framework-agnostic today (no changes needed)

| Module | Why it's portable |
|--------|-------------------|
| `src/server.ts` | All 14 tools take `I18nConfig` — never reference Nuxt directly |
| `src/io/json-reader.ts` | Reads any JSON locale files |
| `src/io/json-writer.ts` | Writes any JSON locale files |
| `src/io/key-operations.ts` | Pure key path CRUD on nested objects |
| `src/config/types.ts` | `I18nConfig` interface has no Nuxt-specific fields |
| `src/config/project-config.ts` | Loads `.i18n-mcp.json` — framework-independent |
| `src/utils/*` | Logger, error classes |

### What's Nuxt-specific (needs to become an adapter)

| Module | Nuxt coupling |
|--------|---------------|
| `src/config/detector.ts` | Calls `loadNuxt()`, reads `nuxt.options.i18n`, iterates `_layers` |
| `src/config/discovery.ts` | Looks for `nuxt.config.ts/js` files, uses Nuxt layer conventions |
| `src/config/nuxt-loader.ts` | Dynamically imports `@nuxt/kit` from the project's `node_modules` |
| `src/scanner/code-scanner.ts` | Only matches `$t()`, `t()`, `this.$t()` — misses `__()`, `trans()`, `@lang()` |

---

## Design Decision: Single Package with Internal Adapters

**Chosen over monorepo** because:
- One npm install, one MCP config line
- No fragmented npm discovery problem
- Shared `.i18n-mcp.json` config across frameworks
- Simpler CI/CD (single release pipeline)
- Agent sees one unified tool surface regardless of framework

---

## Target Architecture

```
src/
├── adapters/
│   ├── types.ts               ← FrameworkAdapter interface
│   ├── registry.ts            ← Adapter registration + auto-detection orchestration
│   ├── nuxt/
│   │   ├── detector.ts        ← Current detector.ts (loadNuxt, extractI18nConfig, etc.)
│   │   ├── discovery.ts       ← Current discovery.ts (discoverNuxtApps, findNuxtConfig)
│   │   ├── nuxt-loader.ts     ← Current nuxt-loader.ts (@nuxt/kit dynamic import)
│   │   └── index.ts           ← Exports NuxtAdapter implementing FrameworkAdapter
│   ├── vue/
│   │   ├── detector.ts        ← Detects vue-i18n via vite/webpack config or package.json
│   │   ├── discovery.ts       ← Finds locale dirs from vue-i18n plugin config
│   │   └── index.ts           ← Exports VueAdapter implementing FrameworkAdapter
│   └── laravel/
│       ├── detector.ts        ← Detects Laravel via artisan, composer.json, or lang/ dir
│       ├── discovery.ts       ← Discovers lang/{locale}/*.json locale files
│       └── index.ts           ← Exports LaravelAdapter implementing FrameworkAdapter
├── config/
│   ├── types.ts               ← I18nConfig, LocaleDir, etc. (unchanged)
│   ├── project-config.ts      ← .i18n-mcp.json loader (unchanged)
│   └── detector.ts            ← NEW: thin orchestrator — calls registry.detect(projectDir)
├── io/                        ← Unchanged
├── scanner/
│   ├── code-scanner.ts        ← Extended: per-framework translation function patterns
│   └── patterns.ts            ← NEW: framework-specific scan patterns registry
├── server.ts                  ← Unchanged (operates on I18nConfig)
├── utils/                     ← Unchanged
└── index.ts                   ← Unchanged
```

---

## Phase 1: Adapter Interface + Nuxt Extraction

**Goal**: Extract Nuxt code into `src/adapters/nuxt/` behind a `FrameworkAdapter` interface. Zero behavior change — pure refactor.

### 1.1 Define the adapter interface

**File**: `src/adapters/types.ts`

```typescript
import type { I18nConfig } from '../config/types'

export interface FrameworkAdapter {
  /** Unique adapter identifier (e.g., 'nuxt', 'vue', 'laravel') */
  readonly name: string

  /** Human-readable label for logging */
  readonly label: string

  /**
   * Probe whether this adapter can handle the given project directory.
   * MUST be fast (no heavy loading) — just check for config file existence.
   * Returns a confidence score: 0 = no match, 1 = possible, 2 = certain.
   */
  detect(projectDir: string): Promise<number>

  /**
   * Fully resolve the i18n configuration for the project.
   * Called only after detect() returned > 0.
   */
  resolve(projectDir: string): Promise<I18nConfig>
}
```

**Why confidence scores instead of boolean**: A directory might have both `nuxt.config.ts` AND `composer.json`. Confidence lets the registry pick the best match, or prompt the agent to disambiguate.

### 1.2 Create adapter registry

**File**: `src/adapters/registry.ts`

```typescript
import type { FrameworkAdapter } from './types'
import type { I18nConfig } from '../config/types'

const adapters: FrameworkAdapter[] = []

export function registerAdapter(adapter: FrameworkAdapter): void {
  adapters.push(adapter)
}

/**
 * Auto-detect framework and resolve config.
 * Runs all adapters' detect() in parallel, picks highest confidence.
 * Throws if no adapter matches.
 */
export async function detectFramework(projectDir: string): Promise<I18nConfig> {
  const scores = await Promise.all(
    adapters.map(async (a) => ({ adapter: a, score: await a.detect(projectDir) }))
  )

  const best = scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  if (best.length === 0) {
    throw new ConfigError(`No supported i18n framework detected in ${projectDir}`)
  }

  return best[0].adapter.resolve(projectDir)
}
```

### 1.3 Move Nuxt files into adapter directory

| From | To |
|------|----|
| `src/config/detector.ts` | `src/adapters/nuxt/detector.ts` |
| `src/config/discovery.ts` | `src/adapters/nuxt/discovery.ts` |
| `src/config/nuxt-loader.ts` | `src/adapters/nuxt/nuxt-loader.ts` |

Create `src/adapters/nuxt/index.ts` that wraps them in a `NuxtAdapter` class implementing `FrameworkAdapter`.

### 1.4 Update `src/config/detector.ts` to delegate

The existing `src/config/detector.ts` becomes a thin orchestrator:

```typescript
import { detectFramework } from '../adapters/registry'
// ... re-export cache management functions, delegate detection to registry
```

### 1.5 Verification

- [ ] All 274+ existing tests pass without modification
- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` succeeds
- [ ] Playground still works with `pnpm inspect`

---

## Phase 2: Vue (vue-i18n) Adapter

**Goal**: Support standalone Vue projects using `vue-i18n` (without Nuxt).

### 2.1 Detection signals (confidence scoring)

| Signal | Confidence |
|--------|-----------|
| `vue-i18n` in `package.json` dependencies | 1 (possible) |
| `@intlify/unplugin-vue-i18n` in vite config | 2 (certain) |
| `createI18n()` call found in source | 2 (certain) |
| `nuxt.config.ts` also present | -1 (prefer Nuxt adapter) |

### 2.2 Config resolution

Vue-i18n projects configure locale loading in multiple ways:

1. **Vite plugin** (`@intlify/unplugin-vue-i18n`): `include` option points to locale dirs
2. **Manual setup**: `createI18n({ messages: { en: require('./locales/en.json') } })`
3. **Convention**: `src/locales/`, `locales/`, `src/i18n/locales/`

The adapter should:
1. Try to parse Vite config for the unplugin include path
2. Fall back to scanning conventional directories
3. Detect locale codes from JSON filenames (same as Nuxt adapter already does)

### 2.3 Locale directory structure

```
vue-project/
├── src/
│   └── locales/          ← discovered
│       ├── en.json
│       ├── de.json
│       └── fr.json
├── vite.config.ts        ← parsed for plugin config
├── package.json          ← checked for vue-i18n dep
└── .i18n-mcp.json        ← optional project config
```

### 2.4 Layer model

Vue projects typically don't have layers. The adapter produces a single `LocaleDir` with `layer: "root"`. If a monorepo has multiple Vue apps, each becomes its own layer (like the Nuxt monorepo merge logic).

### 2.5 Code scanner patterns

Current patterns already work for Vue (`$t()`, `t()` in `<template>` and `<script>`). No changes needed for basic vue-i18n support.

Additional patterns to consider for `<i18n>` SFC blocks:

```
$t('key')              ← already matched
t('key')               ← already matched
this.$t('key')         ← already matched
v-t="'key'"            ← NEW: directive-based translations
i18n-t keypath="key"   ← NEW: component-based translations
```

### 2.6 `@nuxt/kit` dependency change

`@nuxt/kit` must become an **optional** peer dependency:
- Required only when the Nuxt adapter is active
- The Nuxt adapter's `nuxt-loader.ts` already handles the dynamic import with a try/catch
- `peerDependenciesMeta` changes from `"optional": false` to `"optional": true`

---

## Phase 3: Laravel Adapter

**Goal**: Support Laravel projects using JSON translation files.

### 3.1 Detection signals

| Signal | Confidence |
|--------|-----------|
| `artisan` file in root | 2 (certain) |
| `composer.json` with `laravel/framework` | 2 (certain) |
| `lang/` or `resources/lang/` directory with JSON files | 1 (possible) |
| `config/app.php` with `locale` setting | 1 (possible) |

### 3.2 Laravel locale file structure

Laravel supports two formats:

**JSON files** (flat key-value, recommended for most projects):
```
lang/
├── en.json          ← {"Save": "Save", "Cancel": "Cancel"}
├── de.json          ← {"Save": "Speichern", "Cancel": "Abbrechen"}
└── fr.json
```

**PHP files** (nested arrays, per-namespace):
```
lang/
├── en/
│   ├── auth.php     ← <?php return ['failed' => 'These credentials...'];
│   └── validation.php
├── de/
│   ├── auth.php
│   └── validation.php
```

### 3.3 Scope: JSON only (Phase 3), PHP later

**Phase 3 supports JSON locale files only.** PHP array files require a PHP parser — out of scope for the initial adapter. This is a practical decision: many modern Laravel apps use JSON translations, and it keeps the IO layer unchanged.

The adapter should:
1. Detect `lang/` directory location (Laravel 9+ uses root-level `lang/`, older uses `resources/lang/`)
2. Scan for `*.json` files directly in `lang/`
3. Build `LocaleDefinition` from filenames (`en.json` → `{ code: "en", file: "en.json", language: "en" }`)
4. Produce a single `LocaleDir` with `layer: "root"`

### 3.4 Key format difference

Laravel JSON translations use **flat keys** (often the English source string itself):

```json
{
  "Save": "Speichern",
  "Welcome, :name": "Willkommen, :name"
}
```

This is different from Nuxt/Vue's **nested dot-path** convention (`common.actions.save`). The existing `key-operations.ts` handles both since flat keys are just single-segment paths.

**Placeholder format**: Laravel uses `:name`, Vue uses `{name}`. The `server.ts` placeholder validation already handles `{...}` — it needs extending for `:name` style.

### 3.5 Code scanner patterns for Laravel

New patterns for Blade templates and PHP files:

```
__('key')              ← PHP translation helper
trans('key')           ← PHP translation helper
@lang('key')           ← Blade directive
Lang::get('key')       ← Facade call
trans_choice('key', n) ← Pluralization
```

**File extensions to scan**: `*.blade.php`, `*.php` (in addition to existing Vue/TS patterns).

### 3.6 Scanner pattern registry

Rather than hardcoding patterns per framework, introduce a pattern registry:

**File**: `src/scanner/patterns.ts`

```typescript
export interface ScanPatternSet {
  /** File glob patterns to scan */
  filePatterns: string[]
  /** Regex patterns with named groups: callee, key */
  keyPatterns: RegExp[]
  /** Directories to always ignore */
  ignoreDirs: string[]
}

export const VUE_PATTERNS: ScanPatternSet = {
  filePatterns: ['**/*.vue', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.mts'],
  keyPatterns: [STATIC_KEY_PATTERN, DYNAMIC_KEY_PATTERN, CONCAT_KEY_PATTERN],
  ignoreDirs: ['node_modules', '.nuxt', '.output', 'dist', '.git', 'coverage'],
}

export const LARAVEL_PATTERNS: ScanPatternSet = {
  filePatterns: ['**/*.blade.php', '**/*.php'],
  keyPatterns: [LARAVEL_STATIC_PATTERN, LARAVEL_DYNAMIC_PATTERN],
  ignoreDirs: ['vendor', 'node_modules', 'storage', '.git', 'coverage'],
}
```

The adapter tells the scanner which pattern set to use. For monorepos with mixed frameworks, patterns merge.

---

## Phase 4: npm Package Migration

### 4.1 Package naming

`i18n-mcp` is taken on npm. Options (all available):

| Name | Pros | Cons |
|------|------|------|
| `@fabkho/i18n-mcp` | Scoped, clean, matches GitHub org | Requires npm org setup |
| `i18n-mcp-server` | Descriptive, unscoped | Longer |
| `universal-i18n-mcp` | Clear intent | Verbose |

**Recommendation**: `@fabkho/i18n-mcp` — scoped packages have zero naming conflicts and signal clear ownership.

**Decision needed from maintainer before implementation.**

### 4.2 Migration strategy

1. **Publish new package** with same tool surface
2. **Deprecate `nuxt-i18n-mcp`** on npm: `npm deprecate nuxt-i18n-mcp "Moved to @fabkho/i18n-mcp — now supports Vue and Laravel too"`
3. **Keep `nuxt-i18n-mcp` bin alias** for 1 major version (backwards compat)
4. **GitHub repo rename**: `nuxt-i18n-mcp` → `i18n-mcp` (GitHub auto-redirects old URLs)

### 4.3 Binary names

```json
{
  "bin": {
    "i18n-mcp": "./dist/index.js",
    "nuxt-i18n-mcp": "./dist/index.js"
  }
}
```

Both names point to the same binary during the transition period.

### 4.4 MCP host config migration

Users change one line:

```diff
- "args": ["nuxt-i18n-mcp@latest"]
+ "args": ["@fabkho/i18n-mcp@latest"]
```

### 4.5 Peer dependencies

```json
{
  "peerDependencies": {
    "@nuxt/kit": "^3.0.0 || ^4.0.0"
  },
  "peerDependenciesMeta": {
    "@nuxt/kit": {
      "optional": true
    }
  }
}
```

`@nuxt/kit` becomes optional. The Nuxt adapter checks for it at runtime and throws a clear error if missing.

---

## Phase 5: `.i18n-mcp.json` Schema Updates

### 5.1 New optional `framework` hint

```json
{
  "framework": "nuxt"
}
```

Values: `"nuxt"` | `"vue"` | `"laravel"` | omitted (auto-detect).

Skips auto-detection overhead when explicitly set. Useful in monorepos where multiple frameworks coexist.

### 5.2 Laravel-specific config

```json
{
  "framework": "laravel",
  "placeholderStyle": "laravel"
}
```

`placeholderStyle`: `"vue"` (default, `{name}`) | `"laravel"` (`:name`). Affects placeholder validation in `server.ts`.

### 5.3 Backwards compatibility

All new fields are optional. Existing `.i18n-mcp.json` files work without changes.

---

## Implementation Order

| Phase | Scope | Risk | Estimated effort |
|-------|-------|------|-----------------|
| **1** | Adapter interface + Nuxt extraction | Low (pure refactor) | Medium |
| **2** | Vue adapter | Medium (config parsing) | Medium |
| **3** | Laravel adapter | Medium (new file patterns) | Medium |
| **4** | npm migration | Low (publishing) | Small |
| **5** | Schema updates | Low (additive) | Small |

**Phase 1 ships first** — it validates the adapter architecture with zero user-facing changes. Phases 2 and 3 can proceed in parallel after Phase 1 merges.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Vue config parsing is fragile (Vite configs are JS, not JSON) | Vue adapter fails to detect | Convention-based fallback (scan standard dirs) + manual `framework` hint |
| Laravel PHP locale files not supported | Incomplete Laravel support | Document JSON-only limitation, add PHP support in follow-up |
| `i18n-mcp` npm name taken | Naming confusion | Use scoped `@fabkho/i18n-mcp` or alternative |
| Breaking change for existing users | User churn | Keep `nuxt-i18n-mcp` bin alias, deprecate gradually |
| Code scanner false positives across frameworks | Orphan detection inaccuracy | Per-adapter pattern sets, framework hint in config |

---

## Open Questions (for maintainer)

1. **Package name**: `@fabkho/i18n-mcp` vs `i18n-mcp-server` vs `universal-i18n-mcp`?
2. **Repo rename timing**: Rename with Phase 1 (adapter refactor) or Phase 4 (npm migration)?
3. **Laravel PHP file support**: Add to Phase 3 roadmap or defer indefinitely?
4. **SFC `<i18n>` block support**: Should the Vue adapter extract translations from inline `<i18n>` blocks in `.vue` files?
5. **Priority**: Vue first, Laravel first, or both in parallel?
