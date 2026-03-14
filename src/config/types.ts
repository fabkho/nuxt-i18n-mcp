/**
 * A single locale definition as detected from the Nuxt i18n config.
 */
export interface LocaleDefinition {
  /** Locale code used in URLs and as identifier (e.g., 'de', 'en', 'en-us') */
  code: string
  /** BCP-47 language tag (e.g., 'de-DE', 'en-GB') */
  language: string
  /** Locale JSON filename (e.g., 'de-DE.json') */
  file: string
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

/**
 * Project-specific configuration from `.i18n-mcp.json`.
 * All fields are optional — the server passes them to the agent as-is.
 */
export interface ProjectConfig {
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
  /** Few-shot translation examples */
  examples?: Array<Record<string, string>>
}

/**
 * The fully resolved i18n configuration for a Nuxt project.
 */
export interface I18nConfig {
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
  /** Optional project-specific config from .i18n-mcp.json */
  projectConfig?: ProjectConfig
}
