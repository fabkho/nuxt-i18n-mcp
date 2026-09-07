/**
 * The one definition of the declared half of the kit's configuration —
 * everything a human tells the tool, as opposed to what it can see for itself.
 *
 * `.i18n-mcp.json`, `i18n-kit.config.ts` and the `i18nKit` block in
 * `nuxt.config.ts` all accept this same shape, and all validate against this
 * same schema. The `ProjectConfig` interface in `./types.ts` documents it;
 * the guard at the bottom of this file fails the build if the two drift.
 *
 * The `.describe()` text on each field is the published documentation of that
 * field: `./schema-json.ts` converts this schema into `packages/mcp/schema.json`,
 * which editors read for validation and tooltips. Write it for a user looking
 * at their own config file, not for a reader of this module.
 */
import { z } from 'zod'
import type { ProjectConfig } from './types.js'
import { log } from '../utils/logger.js'

const nonEmptyString = z.string().min(1).refine(s => s.trim().length > 0, 'Must not be empty or whitespace-only')

const layerRuleSchema = z.object({
  layer: z.string()
    .describe('Layer name (e.g., \'root\', \'app-admin\', \'app-shop\', \'lang\').'),
  description: z.string()
    .describe('What this layer contains — key namespaces, domain scope, etc.'),
  when: z.string()
    .describe('Natural-language rule describing when a key should go in this layer.'),
})

const localeDirEntrySchema = z.union([
  nonEmptyString
    .describe('Relative path to a locale directory. Layer name defaults to \'default\'.'),
  z.object({
    path: nonEmptyString.describe('Relative path to a locale directory.'),
    layer: nonEmptyString.describe('Layer name for this locale directory.'),
  }),
])

const appEntrySchema = z.object({
  name: nonEmptyString
    .describe('App name, as it appears in orphan and status reports (e.g., \'shop\', \'@acme/admin\').'),
  layers: z.array(nonEmptyString)
    .describe('Layer names this app can render — its own layer plus every shared layer it consumes.'),
})

export const projectConfigSchema = z.object({
  $schema: z.string()
    .describe('Path or URL to the JSON schema for IDE autocompletion.')
    .optional(),
  framework: z.string()
    .describe(
      'Force framework detection instead of auto-detecting from project structure. '
      + 'Any registered adapter name is accepted — the suggestions are the adapters '
      + 'that ship today, not the only permitted values. \'vue\' is accepted as an '
      + 'alias for \'generic\', which resolves Vue projects: declare localeDirs when '
      + 'the locale files are not in a conventional directory.',
    )
    .optional(),
  context: z.string()
    .describe(
      'Free-form project background for the agent — business domain, user base, brand '
      + 'voice, anything that helps the agent understand the project.',
    )
    .optional(),
  layerRules: z.array(layerRuleSchema)
    .describe(
      'Rules that help the agent decide which layer a new translation key belongs to. '
      + 'The agent interprets the natural-language \'when\' field.',
    )
    .optional(),
  glossary: z.record(z.string(), z.string())
    .describe(
      'Term dictionary for consistent translations. Keys are source terms, values '
      + 'describe the required translation or usage note.',
    )
    .optional(),
  translationPrompt: z.string()
    .describe(
      'System prompt prepended to all translation requests (provider mode and agent-mode '
      + 'fallback contexts). Sets tone, style, and constraints.',
    )
    .optional(),
  localeNotes: z.record(z.string(), z.string())
    .describe(
      'Per-locale context included in translation prompts. Each key is matched against a '
      + 'locale\'s code, language tag, or file name (with or without extension) — whichever '
      + 'the project uses, e.g. \'de\', \'de-DE\' or \'de-DE.json\'. Values describe register, '
      + 'regional conventions, or other locale-specific guidance. A key that matches no '
      + 'locale is reported and ignored.',
    )
    .optional(),
  examples: z.array(
    // `key` is required because the prompt builder renders `- ${ex.key}: …`
    // unconditionally: an entry without one reached the provider as the literal
    // string "undefined", offered as a translation key to imitate (#367).
    z.object({
      key: z.string().describe('The dot-path translation key this example demonstrates (e.g., \'common.actions.save\').'),
      note: z.string().describe('Optional style comment shown alongside the example.').optional(),
    })
      .catchall(z.string())
      .describe(
        'A single translation example. \'key\' holds the dot-path translation key (e.g., '
        + '\'common.actions.save\'), \'note\' an optional style comment, and every other '
        + 'property is a locale code (e.g., \'de-DE\', \'en-US\') mapped to its translated value.',
      ),
  )
    .describe(
      'Few-shot translation examples that demonstrate the project\'s style. The agent uses '
      + 'these as reference when generating translations.',
    )
    .optional(),
  declaredNamespaces: z.array(z.object({
    pattern: nonEmptyString
      .describe(
        'Key pattern the declaration covers (e.g., "views.defaults.**"). Use * to match a '
        + 'single key segment, ** to match any depth.',
      ),
    reason: nonEmptyString
      .describe(
        'What keeps these keys alive, named so the report can say why they are protected '
        + '(e.g., "sent by bookings-api as name_key").',
      ),
  }))
    .describe(
      'Namespaces whose keys exist by contract rather than by a call site — sent by a backend, '
      + 'keyed by runtime data, built from a registry. Their keys are never reported as orphans '
      + 'and never written by check --write, in every layer. Each declaration is reported with '
      + 'the keys it matches, so one that matches nothing is visible as stale.',
    )
    .optional(),
  orphanScan: z.record(z.string(), z.object({
    ignorePatterns: z.array(z.string())
      .describe(
        'Glob patterns for translation keys to exclude from orphan detection in this layer '
        + '(e.g., "common.datetime.months.*"). Use * to match a single key segment, ** to match '
        + 'any depth. For keys that exist by contract elsewhere, declare them under '
        + 'declaredNamespaces instead, which records why and reports what each pattern protects.',
      )
      .optional(),
  // passthrough for backwards-compat with deprecated keys like includeParentLayer
  }).passthrough())
    .describe(
      'Per-layer configuration for orphan key detection. Map each layer name to its settings. '
      + 'Scan directories are automatically determined from each layer\'s root directory.',
    )
    .optional(),
  localeDirs: z.array(localeDirEntrySchema)
    .describe(
      'Locale directories for the generic adapter. Each entry is a path string (layer defaults '
      + 'to \'default\') or an object with \'path\' and \'layer\' properties.',
    )
    .optional(),
  defaultLocale: nonEmptyString
    .describe('Default locale code. Required for generic adapter activation.')
    .optional(),
  apps: z.array(appEntrySchema)
    .describe(
      'Which app consumes which layers — the consumer graph behind app-scoped orphan detection, '
      + 'misplaced-usage reports and unconsumed-layer warnings. Declaring it overrides both framework '
      + 'discovery and workspace inference.',
    )
    .optional(),
  consumerGraph: z.enum(['auto', 'off'])
    .describe(
      'Whether to infer the consumer graph from the package manager workspace and package.json '
      + 'dependencies when the framework provides no app information: \'auto\' (default) infers it, '
      + '\'off\' keeps every layer in one app.',
    )
    .optional(),
  locales: z.array(nonEmptyString)
    .describe(
      'Explicit list of locale codes to operate on. If absent, locales are auto-discovered '
      + 'from files on disk.',
    )
    .optional(),
  protectedLocales: z.array(nonEmptyString)
    .describe(
      'Human-maintained locales excluded from automatic translation. Entries may be any locale '
      + 'ref (code, language tag, or file name); entries that do not match a known locale are '
      + 'ignored with a warning. Explicitly naming a protected locale in targetLocales overrides '
      + 'the protection (with a warning).',
    )
    .optional(),
  reportOutput: z.union([
    z.literal(true)
      .describe('Set to true to write reports to the default \'.i18n-reports/\' directory.'),
    nonEmptyString
      .describe('Custom directory path (relative to project root) where diagnostic tool reports are written.'),
  ])
    .describe(
      'Enable file output for diagnostic tools (get_missing_translations, search_translations, '
      + 'find_orphan_keys, find_undefined_keys). When set, each tool writes its full JSON report to '
      + '<reportOutput>/<toolName>.json and returns only a summary in the MCP response. Set to true '
      + 'for the default \'.i18n-reports/\' directory, or a string for a custom path.',
    )
    .optional(),
  localeFileFormat: z.enum(['json', 'php-array', 'yaml'])
    .describe(
      'Override the auto-detected locale file format. \'yaml\' covers both .yaml and .yml files. '
      + 'Useful when several formats exist in one project or auto-detection picks wrong.',
    )
    .optional(),
  translationMemory: z.boolean()
    .describe(
      'Write a translation memory to \'.i18n-kit.lock.json\' at the project root, recording per '
      + 'layer, key and target locale a hash of the source text each translation was made from, so '
      + 'later runs can tell targets that are still current from ones whose source has changed since. '
      + 'Off by default; no file is created until you enable it.',
    )
    .optional(),
  providerBaseUrl: nonEmptyString
    .describe(
      'Base URL for the LLM provider — gateways, self-hosted model servers and corporate proxies '
      + 'that speak the provider\'s own protocol. Overrides the endpoint only, not the request shape '
      + 'or auth header. Overridden by the I18N_BASE_URL environment variable and by --baseUrl.',
    )
    .optional(),
  // Deprecated with the removal of MCP sampling: accepted so existing config
  // files keep validating (the schema is strict), warned about, and ignored.
  samplingPreferences: z.unknown()
    .meta({
      deprecated: true,
      description:
        'Deprecated and ignored — MCP sampling was removed. Still accepted so existing config '
        + 'files keep validating. Configure a provider instead (e.g., I18N_PROVIDER/I18N_MODEL).',
    })
    .optional(),
}).strict()

/**
 * Validate a candidate project config against the published schema, returning
 * the formatted issue list rather than throwing. `init` uses this to refuse to
 * emit a config the tool would then reject; the loaders turn the same failure
 * into a ConfigError naming the file it came from.
 */
export function validateProjectConfig(
  value: unknown,
): { ok: true, data: ProjectConfig } | { ok: false, error: string } {
  const result = projectConfigSchema.safeParse(value)
  if (result.success) return { ok: true, data: result.data as ProjectConfig }

  const error = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `  ${path}: ${issue.message}`
    })
    .join('\n')
  return { ok: false, error }
}

/**
 * Strip the deprecated keys the schema still accepts, warning once, so that a
 * config keeps validating without the value going on to mean anything. Applied
 * by every loader — a key ignored in `.i18n-mcp.json` but silently honoured in
 * `i18n-kit.config.ts` would be exactly the divergence this file exists to
 * prevent.
 */
export function dropDeprecatedKeys(config: ProjectConfig, source: string): ProjectConfig {
  const data = config as ProjectConfig & { samplingPreferences?: unknown }
  if ('samplingPreferences' in data) {
    log.warn(
      `${source}: "samplingPreferences" is deprecated and ignored — `
      + 'MCP sampling was removed. Configure a provider (e.g. I18N_PROVIDER/I18N_MODEL) instead.',
    )
    delete data.samplingPreferences
  }
  return data
}

// ─── Drift guard ────────────────────────────────────────────────
//
// A key added to the interface but not the schema is rejected at runtime as an
// unknown key (the schema is strict) — a typed config that the editor accepts
// and the CLI refuses. A key added to the schema but not the interface is
// accepted at runtime and invisible in an editor. Both are the drift this
// module exists to prevent, so both are a type error here.
//
// `$schema` is JSON-only, and `samplingPreferences` is accepted purely so old
// files keep validating; neither belongs in the documented type.

type SchemaKey = Exclude<keyof z.infer<typeof projectConfigSchema>, '$schema' | 'samplingPreferences'>

/** Fails to compile unless `T` is `never`, naming the offending key when not. */
type NoDrift<T extends never> = T

type _SchemaCoversType = NoDrift<Exclude<keyof ProjectConfig, SchemaKey>>
type _TypeCoversSchema = NoDrift<Exclude<SchemaKey, keyof ProjectConfig>>
