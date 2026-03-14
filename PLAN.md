# anny-i18n MCP Server — Implementation Plan

## 1. Problem Statement

AI coding agents (Cursor, Copilot) can translate text just fine, but they **cannot efficiently insert/update keys in deeply nested JSON files across 17 locales × 6 locations (102 files total)**. They resort to writing throwaway Python scripts or making repetitive, error-prone edits.

We need an MCP server that gives the agent structured tools for i18n file manipulation — so it calls `add_translation(...)` instead of fumbling with JSON.

---

## 2. Decision: MCP Server Only

| Approach | Verdict | Rationale |
|----------|---------|-----------|
| **MCP Server** | ✅ Build this | Solves the core pain: agent gets efficient structured tools for nested JSON manipulation across all locales |
| **CI Job** | ❌ Skip | Nested JSON is hard to diff incrementally; adds pipeline latency; conflicts with BabelEdit manual edits; would require `t('key' /* default */)` convention migration across ~6,900 keys |
| **CLI** | ❌ Skip | The agent IS the CLI. No human needs to run translation commands manually when the agent can call MCP tools directly. BabelEdit remains available for manual tweaks |
| **MCP Client** | ❌ Not needed | The MCP client is the host application (Cursor / VS Code). It's already built. We only build the **server** — the program that exposes tools. The host spawns our server process and communicates with it over stdio. |

---

## 3. Architecture

```
┌──────────────────────────────────┐
│  MCP Host (Cursor / VS Code)     │
│  ┌────────────────────────────┐  │
│  │  Built-in MCP Client       │  │  ← already exists, we don't build this
│  └───────────┬────────────────┘  │
└──────────────┼───────────────────┘
               │ stdio (JSON-RPC 2.0)
┌──────────────┼───────────────────┐
│  anny-i18n MCP Server (Node/TS)  │  ← we build this
│  ┌───────────┴────────────────┐  │
│  │      Tool Router           │  │
│  ├────────────────────────────┤  │
│  │  Config Detection Layer    │  │  ← @nuxt/kit loadNuxt() → resolved i18n config + layers
│  ├────────────────────────────┤  │
│  │  JSON File I/O Layer       │  │  ← read/write/merge nested JSON
│  ├────────────────────────────┤  │
│  │  Translation Engine        │  │  ← agent-powered via MCP sampling
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

### Transport

**stdio** — standard for local MCP servers. The host spawns our process and communicates via stdin/stdout. We must **never** write to stdout except for JSON-RPC messages. All logging goes to stderr.

### SDK

**TypeScript SDK** (`@modelcontextprotocol/sdk`) — Tier 1, matches the project's TS stack.

### Package Location

Standalone package in the monorepo: `anny-ui/packages/i18n-mcp-server/`

Independently buildable. **Not** a Nuxt module — it's a plain Node.js process that uses `@nuxt/kit` only for config resolution.

---

## 4. Config Auto-Detection (Project-Agnostic)

The server must work with **any** `@nuxtjs/i18n` project, not just anny-ui. No hardcoded paths to `i18nHelper.ts` or assumptions about project structure.

### 4.1 Strategy: Use `@nuxt/kit` to Load Resolved Nuxt Config

We use the same approach as `nuxi` and other Nuxt CLI tools — load the full Nuxt instance via `@nuxt/kit` and read the resolved config. This handles:

- Layer merging (root + app-specific layers)
- Module resolution (`@nuxtjs/i18n` config merging)
- `langDir` resolution (default `i18n/locales/`, custom paths, relative paths)
- Locale definitions from any source (inline, imported from helper files, etc.)

```ts
import { loadKit } from './nuxt-loader'

async function detectI18nConfig(projectDir: string): Promise<I18nConfig> {
  const kit = await loadKit(projectDir)
  const nuxt = await kit.loadNuxt({
    cwd: projectDir,
    dotenv: { cwd: projectDir },
    overrides: {
      logLevel: 'silent',
      vite: { clearScreen: false },
    },
  })

  const i18nOptions = nuxt.options.i18n
  const layers = nuxt.options._layers

  // Extract resolved locales, langDirs, defaultLocale from i18nOptions + layers
  // ...

  await nuxt.close()
  return config
}
```

### 4.2 Kit Loading (Resilient)

Resolve `@nuxt/kit` from the project's own `node_modules` first, falling back to a bundled version:

```ts
async function loadKit(rootDir: string): Promise<typeof import('@nuxt/kit')> {
  try {
    const localKit = await tryResolveModule('@nuxt/kit', rootDir)
    const rootURL = localKit ? rootDir : await tryResolveNuxt() || rootDir
    return await importModule('@nuxt/kit', rootURL)
  } catch (e) {
    if (String(e).includes("Cannot find module '@nuxt/kit'")) {
      throw new Error(
        'anny-i18n requires @nuxt/kit. Install nuxt v3+ in your project.',
      )
    }
    throw e
  }
}
```

### 4.3 Layer & Locale Directory Resolution

After `loadNuxt()`, we have access to `nuxt.options._layers` — the ordered array of Nuxt layers. For each layer:

1. Read `layer.config.rootDir` — the absolute path to the layer root.
2. Read `layer.config.i18n` — the layer's i18n config (may be undefined for layers that just inherit).
3. Resolve `langDir` per layer: `resolve(layer.config.rootDir, 'i18n', i18n.langDir ?? 'locales')`.
4. Check if the resolved directory exists and contains JSON files.

This handles all patterns:
- **Default convention:** `<layerRoot>/i18n/locales/` (most apps)
- **Custom langDir:** `app-outlook` using `langDir: '../../app-shop/i18n/locales'`
- **No own locale dir:** layers that only inherit from parent

### 4.4 What We Also Read from `@nuxtjs/i18n` Internals

The `@nuxtjs/i18n` module runs `applyLayerOptions()` during setup, which merges locale configs from all layers using `mergeConfigLocales()`. The merge works per locale code:

- Each locale accumulates a `files[]` array from all layers
- Project-layer files come first (higher priority at runtime)
- Root/extended layer files come last (fallback)

After `loadNuxt()`, the resolved `i18nOptions.locales` contains the **merged** locale definitions with all file paths. We use this directly.

### 4.5 Resolved Config Shape

```ts
interface I18nConfig {
  /** Absolute path to the project root (cwd) */
  rootDir: string
  /** Default locale code */
  defaultLocale: string
  /** Fallback chain from i18n.config.ts */
  fallbackLocale: Record<string, string[]>
  /** All locale definitions (merged from all layers) */
  locales: Array<{
    code: string       // 'de', 'en', 'en-us', etc.
    language: string   // 'de-DE', 'en-GB', etc.
    file: string       // 'de-DE.json'
    name?: string      // 'Deutsch'
  }>
  /** All discovered locale directories, per layer */
  localeDirs: Array<{
    /** Absolute path to the locale directory */
    path: string
    /** Layer name (derived from directory name or 'root') */
    layer: string
    /** Absolute path to the layer root */
    layerRootDir: string
    /** If this dir is an alias to another layer's dir */
    aliasOf?: string
  }>
  /** Optional project config from .i18n-mcp.json (see Section 4.8) */
  projectConfig?: ProjectConfig
}

interface ProjectConfig {
  context?: string
  layerRules?: Array<{ layer: string; description: string; when: string }>
  glossary?: Record<string, string>
  translationPrompt?: string
  localeNotes?: Record<string, string>
  examples?: Array<Record<string, string>>
}
```

### 4.6 Fallback Config Resolution

The `fallbackLocale` map comes from `i18n.config.ts` (or `vueI18n` config). Since this is a runtime config file, we read it separately:

1. Check for `i18n/i18n.config.ts` (or whatever `vueI18n` points to).
2. Evaluate it to extract the `fallbackLocale` object.
3. If unavailable, default to `{ default: [defaultLocale] }`.

### 4.7 Caching

Config detection is expensive (loads full Nuxt). Cache the result in memory after first detection. Provide a `reload_config` tool to refresh.

### 4.8 Project Config File (`.i18n-mcp.json`)

An **optional** config file at the project root that provides the agent with project-specific context. The MCP server doesn't interpret the rules — it passes them to the agent as part of the `detect_i18n_config` response. The agent (an LLM) is perfectly suited to interpret fuzzy rules like "if the key is generic enough, put it in root."

**File:** `.i18n-mcp.json` (at project root, next to `nuxt.config.ts`)

```json
{
  "context": "This is the anny-ui monorepo. We build a SaaS booking platform. The root layer holds shared translations (common actions, navigation, errors). Each app-* layer holds translations specific to that app's domain.",

  "layerRules": [
    {
      "layer": "root",
      "description": "Shared translations used across all apps. Keys like common.actions.*, common.messages.*, common.navigation.*",
      "when": "The key is generic enough to be used in multiple apps (e.g., 'Save', 'Cancel', 'Loading...', 'Date', 'Time')"
    },
    {
      "layer": "app-admin",
      "description": "Admin dashboard translations. Keys like admin.*, pages.*, components.* specific to the admin panel.",
      "when": "The file path is inside app-admin/, or the key is only relevant to admin functionality"
    },
    {
      "layer": "app-shop",
      "description": "Shop/booking frontend translations.",
      "when": "The file path is inside app-shop/, or the key relates to customer-facing booking flow"
    }
  ],

  "glossary": {
    "Buchung": "Booking (never 'Reservation')",
    "Ressource": "Resource (a bookable entity like a room, desk, or person)",
    "Dienstleistung": "Service (a type of offering)",
    "Termin": "Appointment",
    "Zeitfenster": "Time slot"
  },

  "translationPrompt": "You are translating for a B2B SaaS booking platform called 'anny'. Use professional but approachable tone. For de-DE-formal, use 'Sie' (polite form). Preserve all {placeholders} and @:linked.references. Keep translations concise — UI space is limited.",

  "localeNotes": {
    "de-DE-formal": "Formal German using 'Sie'. Used by enterprise customers.",
    "en-US": "American English. Primary market is Germany, so some terms may have German-specific context.",
    "en-GB": "British English. Use 'colour' not 'color', etc."
  },

  "examples": [
    {
      "key": "common.actions.bookResource",
      "de-DE": "{name} buchen",
      "en-US": "Book {name}",
      "note": "Concise, imperative, preserves placeholder"
    },
    {
      "key": "common.messages.success",
      "de-DE": "Erfolgreich gespeichert",
      "en-US": "Successfully saved",
      "note": "Past tense, no exclamation mark"
    }
  ]
}
```

#### Config Schema

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `context` | `string` | No | Free-form project background for the agent — business domain, user base, brand voice |
| `layerRules` | `Array<{ layer, description, when }>` | No | Helps the agent decide which layer a new key belongs to. The `when` field is a natural-language rule. |
| `glossary` | `Record<string, string>` | No | Term dictionary. Agent uses this during translation to ensure consistent terminology. |
| `translationPrompt` | `string` | No | System prompt prepended to all translation requests (sampling or agent-inline). Sets tone, style, constraints. |
| `localeNotes` | `Record<string, string>` | No | Per-locale context (formal register, regional differences, etc.). Included in translation prompts for specific locales. |
| `examples` | `Array<{ key, [locale]: value, note? }>` | No | Few-shot translation examples that demonstrate the project's style. Agent uses these as reference. |

#### How It Flows

1. **`detect_i18n_config`** — reads `.i18n-mcp.json` if present and includes it in the response under `projectConfig`.
2. **Agent reads `layerRules`** — decides "I'm editing `app-admin/components/Foo.vue`, so the key goes in the `app-admin` layer."
3. **Agent reads `glossary`** — translates "Buchung" as "Booking", not "Reservation."
4. **`translate_missing`** — prepends `translationPrompt`, `glossary`, `localeNotes`, and `examples` to the sampling request. Even programmatic translations respect the project's terminology.
5. **Prompts** — `add-feature-translations` includes the project config as context so the agent follows conventions from the start.

#### Design Choices

- **Config is optional** — server works fine without it, just loses project-specific context.
- **Agent interprets rules, not the server** — fuzzy rules like "generic enough to be used in multiple apps" are perfect for LLMs, terrible for code.
- **Glossary is simple key-value** — no complex term management, just enough for the agent to reference.
- **Examples provide few-shot learning** — more effective than describing style in words.

---

## 5. JSON File I/O Layer

### 5.1 Reading

- Parse JSON files with standard `JSON.parse`.
- Represent keys internally as dot-paths (e.g. `common.actions.save`) for easy comparison, but store the full nested structure for writing.

### 5.2 Writing

- **Preserve formatting**: detect indentation style from existing file (tabs in anny-ui, could be spaces elsewhere). Preserve trailing newline.
- **Alphabetical key order**: when adding a new key, insert in alphabetical order within its sibling group. This matches anny-ui's convention and produces clean git diffs.
- **Atomic writes**: write to a temp file, then rename — avoids corruption on crash.
- **No data loss**: never remove keys that the tool didn't explicitly target.

### 5.3 Key Path Operations

```ts
// Get a value at a dot-path from nested JSON
getNestedValue(obj: object, path: string): unknown

// Set a value at a dot-path, creating intermediate objects as needed
setNestedValue(obj: object, path: string, value: unknown): void

// Remove a value at a dot-path, cleaning up empty parent objects
removeNestedValue(obj: object, path: string): boolean

// List all leaf keys as dot-paths
getLeafKeys(obj: object, prefix?: string): string[]

// Sort keys alphabetically at every nesting level (deep)
sortKeysDeep(obj: object): object
```

---

## 6. MCP Tools

All tools use `zod` for input validation via the TypeScript SDK's `server.registerTool()`.

### 6.1 `detect_i18n_config`

Auto-reads the Nuxt i18n setup via `@nuxt/kit`. Also reads `.i18n-mcp.json` if present.

| Field | Value |
|-------|-------|
| **Description** | Detect the Nuxt i18n configuration from the project. Returns locales, locale directories, default locale, fallback chain, and project config (glossary, layer rules, translation prompt) if `.i18n-mcp.json` exists. Call this first before using other tools. |
| **Input** | `{ projectDir?: string }` — optional, defaults to server cwd |
| **Output** | The full `I18nConfig` as JSON text, including `projectConfig` if `.i18n-mcp.json` is found |

**Important:** The `projectConfig` fields (`context`, `layerRules`, `glossary`, `translationPrompt`, `localeNotes`, `examples`) are meant for the agent to read and use as context for its decisions. The server does not interpret them — it only passes them through. The agent should use `layerRules` to decide which layer a new key belongs to, `glossary` for consistent terminology, and `translationPrompt`/`examples` when translating.

---

### 6.2 `list_locale_dirs`

List all locale directories and their layers.

| Field | Value |
|-------|-------|
| **Description** | List all i18n locale directories in the project, grouped by layer (root, app-admin, app-shop, etc.). Shows file count and top-level key namespaces per layer. |
| **Input** | `{}` (none) |
| **Output** | Array of `{ layer, path, fileCount, topLevelKeys[] }` |

---

### 6.3 `get_translations`

Read translation keys from locale files.

| Field | Value |
|-------|-------|
| **Description** | Get translation values for given key paths from a specific locale and layer. Supports dot-notation paths. Use `*` as locale to read from all locales at once. |
| **Input** | `{ layer: string, locale: string, keys: string[] }` |
| **Output** | Object mapping each key to its value (or null if missing) |

**Examples:**
```json
{ "layer": "root", "locale": "en-US", "keys": ["common.actions.save", "common.actions.delete"] }
{ "layer": "app-admin", "locale": "*", "keys": ["pages.bookings.title"] }
```

---

### 6.4 `get_missing_translations`

Compare locale files to find gaps.

| Field | Value |
|-------|-------|
| **Description** | Find translation keys that exist in the reference locale but are missing in other locales. Scans a specific layer or all layers. |
| **Input** | `{ layer?: string, referenceLocale?: string, targetLocales?: string[] }` |
| **Output** | `{ [locale]: { [layer]: string[] } }` — missing key paths per locale per layer |

**Defaults:** `referenceLocale` = `defaultLocale`. `targetLocales` = all other locales.

---

### 6.5 `add_translations`

Add new keys across multiple locales at once.

| Field | Value |
|-------|-------|
| **Description** | Add one or more new translation keys to the specified layer. Provide translations per locale. Keys are inserted in alphabetical order. Fails if key already exists (use `update_translations` instead). |
| **Input** | |

```json
{
  "layer": "root",
  "translations": {
    "common.actions.refresh": {
      "de-DE": "Aktualisieren",
      "en-US": "Refresh",
      "en-GB": "Refresh"
    }
  }
}
```

| **Output** | Summary: keys added, locales written, any skipped (already exists) |

**Key behavior:**
- Only writes to locale files provided in the translations object.
- If a locale file is not specified, the key is **not** added to it (agent can call `translate_missing` later).
- Validates that the layer and locale files exist.

---

### 6.6 `update_translations`

Update existing keys.

| Field | Value |
|-------|-------|
| **Description** | Update the value of existing translation keys in the specified layer. Provide new values per locale. Fails if key doesn't exist (use `add_translations` instead). |
| **Input** | Same shape as `add_translations` |
| **Output** | Summary: keys updated, locales written |

---

### 6.7 `remove_translations`

Remove keys from all locales in a layer.

| Field | Value |
|-------|-------|
| **Description** | Remove one or more translation keys from ALL locale files in the specified layer. |
| **Input** | `{ layer: string, keys: string[] }` |
| **Output** | Summary: keys removed, files modified |

---

### 6.8 `rename_translation_key`

Rename/move a key across all locales.

| Field | Value |
|-------|-------|
| **Description** | Rename a translation key across all locale files in a layer. Preserves the value in every locale. |
| **Input** | `{ layer: string, oldKey: string, newKey: string }` |
| **Output** | Summary: files modified, old key removed, new key inserted |

---

### 6.9 `translate_missing`

Auto-translate missing keys using the host's LLM via MCP sampling.

| Field | Value |
|-------|-------|
| **Description** | Find keys missing in target locales and translate them using the host LLM (via MCP sampling). Translates from the reference locale. Writes results directly to locale files. Uses project config (glossary, translation prompt, locale notes, examples) if available. |
| **Input** | `{ layer: string, referenceLocale?: string, targetLocales?: string[], keys?: string[], batchSize?: number }` |
| **Output** | Summary: keys translated, locales updated, any failures |

**How MCP sampling works:**

The MCP protocol defines a `sampling/createMessage` capability that allows **servers to request the host's LLM** to generate text. This is different from the agent calling a tool — it's the reverse: our server asks the host (Cursor) to run a prompt through its configured model.

This means:
- **No external API key needed** — uses whatever model the user has in their IDE
- **Model-agnostic** — works with GPT-4, Claude, etc.
- **No extra cost** — uses the same LLM the agent is already using

**Sampling prompt construction (uses project config):**

The sampling prompt is assembled from multiple sources:

```
[1. translationPrompt from .i18n-mcp.json — if present]
You are translating for a B2B SaaS booking platform called 'anny'...

[2. Glossary — if present]
GLOSSARY — use these terms consistently:
- Buchung → Booking (never 'Reservation')
- Ressource → Resource (a bookable entity)
- Dienstleistung → Service (a type of offering)

[3. Locale-specific notes — if present for target locale]
TARGET LOCALE NOTE (de-DE-formal): Formal German using 'Sie'. Used by enterprise customers.

[4. Examples — if present]
STYLE EXAMPLES:
- common.actions.bookResource: "{name} buchen" → "Book {name}" (concise, imperative, preserves placeholder)

[5. The actual translation request]
Translate the following i18n key-value pairs from {referenceLang} to {targetLang}.
Preserve all {placeholder} parameters and @:linked.message references.
Return ONLY a JSON object mapping keys to translated values. No markdown, no explanation.

{
  "common.actions.save": "Speichern",
  "common.actions.delete": "Löschen"
}
```

When no `.i18n-mcp.json` exists, only section [5] is sent — the prompt is still functional, just without project-specific context.

**Batch size:** Default 50 keys per sampling request. Configurable via `batchSize`.

**Fallback:** If the host doesn't support sampling (likely the case for Cursor today), the tool returns the list of missing keys with their reference values and instructs the agent to translate them inline, then call `add_translations` / `update_translations` with the results. When returning this fallback, the tool also includes the `translationPrompt`, `glossary`, and relevant `localeNotes` so the agent has full context for manual translation.

---

### 6.10 `search_translations`

Search for keys or values across locale files.

| Field | Value |
|-------|-------|
| **Description** | Search translation files by key pattern (glob/regex) or value substring. Useful for finding existing translations before adding duplicates. |
| **Input** | `{ query: string, searchIn: 'keys' | 'values' | 'both', layer?: string, locale?: string }` |
| **Output** | Array of matches: `{ layer, key, locale, value }` |

---

## 7. MCP Resources

Expose locale files as readable resources so the agent can browse them.

### 7.1 Resource Templates

```
i18n:///{layer}/{localeFile}
```

Examples:
- `i18n:///root/en-US.json` — root English (US) translations
- `i18n:///app-admin/de-DE.json` — app-admin German translations

### 7.2 Resource List

Returns all locale files as resources with metadata: layer, locale name, key count, file size.

---

## 8. MCP Prompts

### 8.1 `add-feature-translations`

Template for adding translations when building a new feature.

```
You are adding i18n translations for a new feature.
Layer: {layer}
Feature namespace: {namespace}

1. Use `detect_i18n_config` to understand the project setup.
   - If `projectConfig.layerRules` exists, use them to decide which layer to target.
   - If `projectConfig.glossary` exists, use it for consistent terminology.
2. Use `search_translations` to check for existing similar keys.
3. Use `add_translations` to add keys for the two primary locales (the project's default + English, or per project conventions).
   - If `projectConfig.examples` exists, follow the same translation style.
4. Use `translate_missing` to auto-translate remaining locales.
```

### 8.2 `fix-missing-translations`

Template for finding and fixing translation gaps.

```
Find and fix all missing translations in the project.

1. Use `detect_i18n_config` to load the project config.
   - If `projectConfig.translationPrompt` exists, use it as context for translations.
   - If `projectConfig.glossary` exists, ensure all translations use consistent terms.
2. Use `get_missing_translations` to find all gaps across all layers.
3. Use `translate_missing` to auto-fill gaps using the reference locale.
4. Report a summary of what was translated.
```

---

## 9. Project Structure

```
packages/i18n-mcp-server/
├── package.json
├── tsconfig.json
├── .i18n-mcp.json                  # Optional project config (glossary, layer rules, etc.)
├── src/
│   ├── index.ts                    # Entry point — stdio transport setup
│   ├── server.ts                   # McpServer instance, tool/resource/prompt registration
│   ├── config/
│   │   ├── detector.ts             # Auto-detect i18n config via @nuxt/kit
│   │   ├── nuxt-loader.ts          # Resilient @nuxt/kit loading (resolve from project)
│   │   ├── project-config.ts       # Read & validate .i18n-mcp.json
│   │   └── types.ts                # I18nConfig + ProjectConfig type definitions
│   ├── tools/
│   │   ├── detect-config.ts        # detect_i18n_config
│   │   ├── list-locale-dirs.ts     # list_locale_dirs
│   │   ├── get-translations.ts     # get_translations
│   │   ├── get-missing.ts          # get_missing_translations
│   │   ├── add-translations.ts     # add_translations
│   │   ├── update-translations.ts  # update_translations
│   │   ├── remove-translations.ts  # remove_translations
│   │   ├── rename-key.ts           # rename_translation_key
│   │   ├── translate-missing.ts    # translate_missing (sampling + fallback)
│   │   └── search-translations.ts  # search_translations
│   ├── resources/
│   │   └── locale-files.ts         # Resource templates for locale files
│   ├── prompts/
│   │   └── workflows.ts            # Prompt templates
│   ├── io/
│   │   ├── json-reader.ts          # Read & parse locale JSON files
│   │   ├── json-writer.ts          # Write locale JSON (detect & preserve formatting)
│   │   └── key-operations.ts       # Nested key get/set/remove/list/sort
│   └── utils/
│       ├── logger.ts               # stderr logger (NEVER stdout)
│       └── errors.ts               # Typed error helpers
├── tests/
│   ├── fixtures/                   # Sample locale files for testing
│   ├── config-detector.test.ts
│   ├── project-config.test.ts
│   ├── key-operations.test.ts
│   ├── json-writer.test.ts
│   └── tools/
│       ├── add-translations.test.ts
│       ├── get-missing.test.ts
│       └── ...
└── README.md
```

---

## 10. Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.25.0",
    "glob": "^11.0.0"
  },
  "peerDependencies": {
    "@nuxt/kit": "^3.0.0"
  },
  "devDependencies": {
    "@nuxt/kit": "^3.17.0",
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0",
    "vitest": "^3.2.0"
  }
}
```

- `@nuxt/kit` is a **peer dependency** — resolved from the user's project at runtime. The server uses the project's own version for compatibility.
- No LLM SDK needed — translation uses MCP sampling (host's model) with a graceful fallback.

---

## 11. Host Configuration

### Cursor `.cursor/mcp.json` (project-level)

```json
{
  "mcpServers": {
    "anny-i18n": {
      "command": "node",
      "args": ["./packages/i18n-mcp-server/dist/index.js"]
    }
  }
}
```

### VS Code `.vscode/mcp.json`

```json
{
  "servers": {
    "anny-i18n": {
      "type": "stdio",
      "command": "node",
      "args": ["./packages/i18n-mcp-server/dist/index.js"]
    }
  }
}
```

No API keys. No env vars. The server auto-detects everything from the project's Nuxt config via `@nuxt/kit`.

---

## 12. Implementation Phases

### Phase 1 — Core (MVP) ✅
**Goal:** Agent can read, add, and update translations efficiently.

- [x] Project scaffolding (`package.json`, `tsconfig.json`, build script)
- [x] `@nuxt/kit` loader (`nuxt-loader.ts`) — resilient kit resolution from project
- [x] Config auto-detection (`detector.ts`) — `loadNuxt()` → extract i18n config + layers
- [x] JSON I/O layer (reader, writer, key operations)
- [x] Tools: `detect_i18n_config`, `list_locale_dirs`, `get_translations`, `add_translations`, `update_translations`
- [x] stdio transport entry point
- [x] Unit tests for key operations and JSON writer
- [x] Playground with root + app-admin layer for integration testing
- [x] Integration tests for config detection against playground
- [x] MCP Inspector manual testing
- [ ] README with setup instructions

### Phase 2 — Analysis, Search & Project Config ✅
**Goal:** Agent can find gaps, search translations, and use project-specific context.

- [x] **Project config** (`project-config.ts`): read `.i18n-mcp.json`, validate, include in `detect_i18n_config` response
- [x] **Types**: add `ProjectConfig` interface to `types.ts`
- [x] Tools: `get_missing_translations`, `search_translations`
- [x] Resources: locale file resource template (`i18n:///{layer}/{file}`)
- [x] Tests for missing key detection
- [x] Tests for project config loading (with and without `.i18n-mcp.json`)
- [x] Playground: add `.i18n-mcp.json` example to playground

### Phase 3 — Refactoring & Cleanup ✅
**Goal:** Agent can safely restructure i18n keys.

- [x] Tools: `remove_translations`, `rename_translation_key`
- [x] Safety: dry-run preview mode (`dryRun: true`) for both tools
- [x] Conflict detection for rename (new key already exists)
- [x] Alias layer rejection with helpful error
- [x] Tests for remove/rename across all locales

### Phase 4 — Auto-Translation ✅
**Goal:** Agent can fill in missing locales automatically, using project context.

- [x] Tool: `translate_missing` — MCP sampling integration (VS Code) + fallback (Zed, others)
- [x] **Sampling prompt assembly**: prepend `translationPrompt`, `glossary`, `localeNotes`, `examples` from project config
- [x] **Fallback**: when sampling unsupported, return keys + project config context for agent to translate inline
- [x] Batch chunking logic (default 50 keys per sampling request, configurable)
- [x] Prompts: `add-feature-translations`, `fix-missing-translations`

### Phase 5 — Polish (in progress)
**Goal:** Production-ready, team-wide rollout.

- [x] Comprehensive error messages with actionable hints (`ToolError` with structured error codes)
- [x] Performance: file-level caching for parsed JSON (mtime-based invalidation)
- [x] Handle edge cases: `validateTranslationValue()` + `getTranslationStats()` for `@:` linked messages, `{param}` placeholders, HTML, pluralization pipes
- [x] BabelEdit compatibility (sorted keys, consistent formatting, valid JSON)
- [x] Auto-detect indentation style per file (tabs vs spaces, 2-space vs 4-space) and preserve it
- [x] `.i18n-mcp.json` JSON schema for IDE autocompletion
- [x] README with setup instructions
- [x] Team documentation and onboarding guide (covered by README)

---

## 13. Key Design Decisions

### Why `@nuxt/kit` instead of parsing config files directly?

Parsing `nuxt.config.ts` and helper files with regex is fragile — it breaks when the config uses variables, imports, or dynamic logic. `loadNuxt()` resolves everything exactly as Nuxt does: layers, module merging, env vars, `defu` defaults. This makes the server **project-agnostic** — it works with any `@nuxtjs/i18n` setup, not just anny-ui.

### How layers are discovered

After `loadNuxt()`, `nuxt.options._layers` is an ordered array of all Nuxt layers. Each layer has `config.rootDir` and optionally `config.i18n`. The `@nuxtjs/i18n` module resolves `langDir` per layer as:

```
resolve(layer.config.rootDir, 'i18n', i18n.langDir ?? 'locales')
```

We replicate this resolution to discover all locale directories. For layers with custom `langDir` (like `app-outlook → ../../app-shop/i18n/locales`), we detect the aliasing by checking if the resolved path matches another layer's directory.

### Why `.i18n-mcp.json` is optional and agent-interpreted?

The project config solves a fundamentally fuzzy problem: "which layer does this key belong to?" and "what terminology should translations use?". These are decisions that require understanding context, not matching rules — perfect for an LLM, terrible for code. So the server just reads the file and passes it to the agent. The agent reads `layerRules` like a human developer would read a CONTRIBUTING.md.

### Why not bundle translation LLM directly?

MCP sampling means zero API key management. The host (Cursor/VS Code) already has a configured LLM. We ask it to translate via the protocol. If sampling isn't available (likely today), the fallback is natural: the tool returns the missing keys (along with project config context) and the agent translates inline, then calls `add_translations`. Translation is trivial for the agent — the hard part (structured file I/O) is handled by us.

### Why fail on add if key exists (and vice versa)?

Prevents accidental overwrites. The agent must explicitly choose `add` vs `update`. This matches defensive i18n practices where overwriting a human-reviewed translation should be intentional.

### Why alphabetical key sorting?

BabelEdit and human reviewers expect sorted keys. Unsorted insertions cause noisy git diffs and make manual file inspection painful. We sort at every nesting level on write.

### Why nested JSON, not flat keys?

The project uses nested JSON everywhere. BabelEdit reads nested JSON. The MCP server accepts dot-paths as **input** (convenient for the agent) but always reads/writes **nested JSON** (compatible with the existing ecosystem).

### Handling formal/informal variants

`de-DE-formal` and `de-DE` are separate files with separate locale codes. The server treats them as independent locales. When `translate_missing` translates to `de-DE-formal`, the sampling prompt includes register context from `localeNotes` if available in `.i18n-mcp.json`, otherwise defaults to "Use formal/polite register (Sie-Form)."

### Handling aliased layers

`app-outlook` reuses `app-shop` translations via `langDir` override. The server detects this by comparing resolved directory paths and marks the layer as `aliasOf: 'app-shop'`. Tools targeting `app-outlook` redirect to `app-shop` files.

---

## 14. Agent Workflow Examples

### Adding translations for a new feature (with project config)

```
Agent: calls detect_i18n_config → learns 17 locales, 6 layers, default=de
  Response includes projectConfig with layerRules, glossary, examples.

Agent: reads layerRules → "I'm editing app-admin/components/BookingTable.vue,
  so per the rules the key goes in the app-admin layer."

Agent: reads glossary → "Buchung = Booking (never 'Reservation')"

Agent: calls search_translations("booking") → checks for existing keys

Agent: calls add_translations({
  layer: "app-admin",          ← decided based on layerRules
  translations: {
    "components.bookingTable.title": {
      "de-DE": "Buchungsübersicht",    ← uses glossary term "Buchung"
      "en-US": "Booking Overview",     ← uses glossary term "Booking"
      "en-GB": "Booking Overview"
    },
    "components.bookingTable.empty": {
      "de-DE": "Keine Buchungen vorhanden",
      "en-US": "No bookings available",
      "en-GB": "No bookings available"
    }
  }
})

Agent: calls translate_missing({
  layer: "app-admin",
  keys: ["components.bookingTable.title", "components.bookingTable.empty"]
})
→ translate_missing uses translationPrompt + glossary + localeNotes from project config.
→ All 17 locales updated. Consistent terminology across all languages.
```

### Adding a common/shared translation

```
Agent: calls detect_i18n_config → reads layerRules

Agent: decides "Date" is generic, used across multiple apps →
  layerRules say: root layer for generic keys like 'Date', 'Time'.

Agent: calls add_translations({
  layer: "root",               ← root, not app-specific
  translations: {
    "common.terms.date": {
      "de-DE": "Datum",
      "en-US": "Date"
    }
  }
})
```

### Fixing missing translations before release

```
Agent: calls detect_i18n_config → gets project config with translationPrompt + glossary
Agent: calls get_missing_translations() → finds 12 keys missing in fr-FR, 3 in es-ES
Agent: calls translate_missing({ targetLocales: ["fr-FR", "es-ES"] })
→ All gaps filled using project terminology. Agent reports summary.
```

### Renaming a key across all locales

```
Agent: calls rename_translation_key({
  layer: "root",
  oldKey: "common.actions.clearFilters",
  newKey: "common.actions.resetFilters"
})
→ Key renamed in all 17 locale files. Agent updates the t() call in the component.
```

---

## 15. Logging & Debugging

- **All logging to stderr** — never stdout (corrupts JSON-RPC protocol).
- Structured log format: `[anny-i18n] [level] message`.
- Log config detection results on startup.
- Log each tool invocation with input summary (not full payload — locale files are large).
- Testable with [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `npx @modelcontextprotocol/inspector node ./dist/index.js`.

---

## 16. Testing Strategy

| Layer | Tool | What |
|-------|------|------|
| Unit | vitest | Key operations (get/set/remove/sort), JSON writer (formatting, atomic writes), config parser |
| Integration | vitest + fixtures | Full tool execution against fixture locale files — verify file output matches expected |
| Manual | MCP Inspector | Connect to running server, call each tool, verify JSON-RPC responses |

Test fixtures = copies of real locale files trimmed to ~50 keys each, covering nested structures, placeholders, linked messages, and formal/informal variants.

---

## 17. Open Questions

1. **Sampling support in Cursor:** Does Cursor's MCP client support `sampling/createMessage` today? If not, `translate_missing` uses the fallback strategy (return keys → agent translates → agent calls `add_translations`). This fallback is fully functional, just requires more tool calls.

2. **Concurrent file access:** If multiple agent sessions run simultaneously, file writes could conflict. For v1, assume single-agent usage. Future: file locking or write queue.

3. **BabelEdit round-trip:** Need to verify that JSON files written by the MCP server are cleanly importable into BabelEdit without diff noise. Manual test required in Phase 5.

4. **`@nuxt/kit` startup time:** `loadNuxt()` can take a few seconds. This is acceptable for the initial `detect_i18n_config` call since the result is cached. Measure actual time and optimize if needed (e.g., skip module initialization if possible).

5. **`i18n.config.ts` runtime evaluation:** The fallback locale config is defined in a runtime config file. We may need to use `jiti` or similar to evaluate it at build time. Check if `loadNuxt()` already resolves this.

---

## 18. Backlog / Future Considerations

### MCP Nested Tasks (Subtasks)

The MCP spec has a [SEP for nested task execution](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) — allowing a server to spawn subtasks as part of a parent task, with progress tracking and hierarchical task IDs.

**Why we don't need it now:** Our tools are designed to be granular and fast (single file I/O operations, < 1 second each). The agent orchestrates the workflow by chaining tool calls. There's no long-running server-side operation that needs progress tracking or subtask decomposition.

**When it would become relevant:**
- `translate_missing` at scale (translating 6,000+ keys across 100+ files in one call — could take minutes with sampling)
- A future "validate all translations" tool that checks consistency, detects orphaned keys, finds untranslated placeholders, etc.
- Batch operations across all layers simultaneously

**What we'd do:** Wrap `translate_missing` (or a new `batch_translate`) in a task that spawns per-locale subtasks, each reporting progress. The agent could monitor completion and retrieve partial results. For now, the simpler pattern of the agent calling tools in a loop is sufficient and works with every MCP host today.

### Other Backlog Items

- **`move_translations`** — Move keys between layers (e.g., promote app-specific key to `common.*`)
- **Dry-run mode** — ✅ Implemented for `remove_translations`, `rename_translation_key`, and `translate_missing` via `dryRun: true` parameter
- **File watching** — Notify the agent when locale files change on disk (via MCP `notifications/resources/updated`)
- **Translation memory** — Cache previous translations to ensure consistency when the same phrase appears in multiple places
- **Pluralization support** — Handle vue-i18n plural forms (`{ count } item | { count } items`)
- **Key usage analysis** — Scan Vue/TS source files to find unused translation keys. Two sub-features:
  - **Hardcoded string detection** — Find user-facing strings in Vue/TS files not wrapped in `$t()` / `t()` / `useI18n()`. Inspired by better-i18n's `scan` command. Could support `--staged` for pre-commit hooks.
  - **Orphan key detection** — Find keys that exist in translation files but are never referenced in code. The inverse of `get_missing_translations`. Helps clean up dead translations.
- **`.i18n-mcp.json` JSON Schema** — Publish a JSON Schema so IDEs provide autocompletion and validation when editing the config file
- **Glossary validation** — Tool that checks existing translations against the glossary and reports inconsistencies (e.g., "fr-FR uses 'Réservation' but glossary says 'Booking' should be used")
- **Auto-generate `.i18n-mcp.json`** — Tool that analyzes existing translations and proposes a glossary, layer rules, and examples based on patterns found
- **Flat JSON support** — vue-i18n supports `flatJson: true` in its config, which uses dot-separated keys in a flat object instead of nested JSON (e.g., `{ "common.actions.save": "Save" }` instead of `{ "common": { "actions": { "save": "Save" } } }`). Detect this from the i18n config and support reading/writing flat JSON files alongside nested ones.