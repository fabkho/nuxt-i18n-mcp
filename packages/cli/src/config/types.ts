import type { LocaleFileFormat } from '../adapters/types'

/**
 * A single locale definition as detected from the framework config.
 */
export interface LocaleDefinition {
  /** Locale code used in URLs and as identifier (e.g., 'de', 'en', 'en-us') */
  code: string
  /** BCP-47 language tag (e.g., 'de-DE', 'en-GB') */
  language: string
  /** Locale filename (e.g., 'de-DE.json'). Optional for directory-per-locale layouts (Laravel). */
  file?: string
  /** Human-readable name (e.g., 'Deutsch') */
  name?: string
}

/**
 * A locale directory discovered from a Nuxt layer.
 */
export interface LocaleDir {
  /** Absolute path to the locale directory */
  path: string
  /** Layer name (e.g., 'root', 'app-admin', 'app-shop') */
  layer: string
  /** Absolute path to the layer's root directory */
  layerRootDir: string
  /** If this dir is a symlink/alias to another layer's dir (e.g., app-outlook -> app-shop) */
  aliasOf?: string
}

export interface AppInfo {
  /** App name (e.g., 'app-admin', 'root') */
  name: string
  /** Absolute path to the app's root directory */
  rootDir: string
  /** Layer names this app consumes (from _layers) */
  layers: string[]
  /**
   * Where the consumption edges came from, when it was not the framework
   * adapter: 'workspace' for package.json dependency inference, 'declared'
   * for an `apps` list in the project config. Absent means the adapter.
   */
  source?: 'workspace' | 'declared'
}

/**
 * Project-specific configuration from `.i18n-mcp.json`.
 * All fields are optional — the server passes them to the agent as-is.
 */
export interface ProjectConfig {
  /** Framework hint to bypass auto-detection (e.g., 'nuxt', 'laravel') */
  framework?: string
  /** Free-form project background for the agent */
  context?: string
  /** Rules for deciding which layer a key belongs to */
  layerRules?: Array<{
    layer: string
    description: string
    when: string
  }>
  /** Term dictionary for consistent translations */
  glossary?: Record<string, string>
  /** System prompt for translation requests */
  translationPrompt?: string
  /** Per-locale context (formal register, regional differences, etc.) */
  localeNotes?: Record<string, string>
  /**
   * Few-shot translation examples. `key` is required — the prompt names it, so
   * an entry without one reaches the provider as the word "undefined" (#367).
   * Every other property is a locale code mapped to its translated value.
   */
  examples?: Array<{ key: string, note?: string } & Record<string, string>>
  /**
   * Namespaces whose keys exist by contract rather than by a call site: sent by
   * a backend over the wire, keyed by runtime data, built from a registry. The
   * scanner cannot see them, so they are declared once — with the contract that
   * keeps them alive — and protected in every layer.
   */
  declaredNamespaces?: Array<{
    /** Key pattern the declaration covers (e.g., "views.defaults.**"). */
    pattern: string
    /** What keeps these keys alive (e.g., "sent by bookings-api as name_key"). */
    reason: string
  }>
  /** Per-layer scan directories and ignore patterns for orphan key detection. Keys are layer names. */
  orphanScan?: Record<string, {
    /** Glob patterns for translation keys to exclude from orphan detection in this layer (e.g., "common.datetime.months.*"). */
    ignorePatterns?: string[]
  }>
  /**
   * Where diagnostic reports are written: `true` for '.i18n-reports/', or a
   * relative path. There is no `false` — omitting the key is how you say no,
   * and accepting both spellings of "off" would be two ways to mean one thing.
   */
  reportOutput?: string | true
  /** Locale directories for the generic adapter. Each entry is a path string (layer="default") or { path, layer } object. */
  localeDirs?: Array<string | { path: string; layer: string }>
  /** Declared consumer graph: which app consumes which layers. Overrides both adapter discovery and workspace inference. */
  apps?: Array<{ name: string; layers: string[] }>
  /** Whether the consumer graph may be inferred from the workspace when the adapter has no app information ('auto', the default) or not ('off'). */
  consumerGraph?: 'auto' | 'off'
  /** Default locale code (required for generic adapter activation). */
  defaultLocale?: string
  /** Explicit list of locale codes. If set, overrides framework auto-detection (all adapters). Auto-discovered when absent. */
  locales?: string[]
  /**
   * Human-maintained locales excluded from automatic translation.
   * Entries may be any locale ref (code, language tag, or file name);
   * entries that do not match a known locale are ignored with a warning.
   * Explicitly naming a protected locale in targetLocales overrides the
   * protection (with a warning).
   */
  protectedLocales?: string[]
  /** Override the auto-detected locale file format. E.g., "json", "php-array" or "yaml". Useful when several formats exist or auto-detection picks wrong. */
  localeFileFormat?: LocaleFileFormat
  /**
   * Write a translation memory to `.i18n-kit.lock.json` at the project root:
   * per layer, key and target locale, a hash of the source text the translation
   * was made from. That is what lets a later run tell a current translation from
   * one whose source has changed since — state alone cannot, because a target
   * value exists either way. On by default: the first translate run writes the
   * file. False disables it and leaves any existing file untouched.
   */
  translationMemory?: boolean
  /**
   * Base URL for the LLM provider — gateways, self-hosted model servers and
   * corporate proxies that speak the provider's own protocol. Overrides the
   * endpoint only, not the request shape or auth header. Overridden by the
   * I18N_BASE_URL env var and by --baseUrl. Honoured by every provider, each
   * of which is called over plain HTTP against this base.
   */
  providerBaseUrl?: string
}

/**
 * The fully resolved i18n configuration for a project.
 */
export interface I18nConfig {
  /** Detected framework name (e.g., 'nuxt', 'laravel'). Set by the detector. */
  framework?: string
  /** Absolute path to the project root */
  rootDir: string
  /** Default locale code */
  defaultLocale: string
  /** Fallback locale chain (e.g., { 'de-formal': ['de'], 'default': ['en'] }) */
  fallbackLocale: Record<string, string[]>
  /** All locale definitions */
  locales: LocaleDefinition[]
  /** All discovered locale directories, per layer */
  localeDirs: LocaleDir[]
  /** Root directories of all framework layers/roots. Used for source code scanning. */
  layerRootDirs: string[]
  /** Optional project-specific config from .i18n-mcp.json */
  projectConfig?: ProjectConfig
  /** Locale file format used by this project (default: 'json') */
  localeFileFormat?: LocaleFileFormat
  /** Discovered apps and their layer dependencies. Used for orphan scan scope. */
  apps: AppInfo[]
}
