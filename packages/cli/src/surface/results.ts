/**
 * What every operation answers with, as a schema.
 *
 * The MCP server advertises one of these per tool as its `outputSchema` and
 * validates the `structuredContent` it returns against it, so this file is the
 * text a host shows a model about a result — the same role `params` plays for
 * a call. Write a `.describe()` for that reader: what the field means, what
 * unit it is in, and when it is absent.
 *
 * `core/types.ts` stays the source of truth for the shapes; the guard at the
 * bottom of this file fails the build when a schema and its interface stop
 * describing the same thing, the way `config/schema.ts` holds the config
 * schema to `ProjectConfig`.
 *
 * Shapes are stated in full. `z.unknown()` appears only where the value
 * genuinely is open — a translation value can be a string, a plural array or a
 * nested object, and the agent-mode fallback contexts are prompt material
 * rather than a fixed record — because a schema that says nothing tells a
 * model nothing.
 */

import { z } from 'zod'
import { projectConfigSchema } from '../config/schema.js'
import type { CheckUndefinedKeysResult } from '../core/ops-check.js'
import type { FindDuplicateKeysResult } from '../core/ops-duplicates.js'
import type { DescribeProjectOutcome, getTranslations, ListNamespacesResult, MissingTranslationsPage, NamespaceNode, SearchTranslationsPage } from '../core/ops-read.js'
import type {
  CodeUsageResult,
  DescribeProjectResult,
  FindOrphanKeysResult,
  InitProjectConfigResult,
  MissingTranslationsResult,
  MoveTranslationKeyResult,
  RemoveOrphanKeysResult,
  RemoveTranslationsResult,
  RenameTranslationKeyResult,
  ScaffoldLocaleResult,
  SearchTranslationsResult,
  TranslateAllLayersResult,
  TranslateKeyResult,
  TranslateMissingResult,
  TranslationStatusResult,
  WriteTranslationsResult,
} from '../core/types.js'

// ─── Shared leaves ───────────────────────────────────────────────
// One concept, one schema. A locale ref, a placeholder check and a count of
// keys mean the same thing in every result that carries them.

/**
 * A translation value as a locale file holds it. Usually a string, but a
 * vue-i18n plural is one string with `|` separators, and a namespaced PHP file
 * can nest — so the value stays open rather than claiming to be a string.
 */
const translationValue = z.unknown()

const localeRefInfo = z.object({
  code: z.string()
    .describe('Canonical locale code, e.g. "en-US". This is the spelling to pass back to another call.'),
  language: z.string().optional()
    .describe('BCP-47 language tag, e.g. "en-GB". Absent when the framework config carries none.'),
  file: z.string().optional()
    .describe('Locale file name, e.g. "en-US.json". Absent for directory-per-locale layouts such as Laravel.'),
  name: z.string().optional()
    .describe('Human-readable language name, e.g. "Deutsch". Absent unless the framework config names one.'),
})

/**
 * A locale as a summary reports it: the resolved locale, or the bare code the
 * caller passed when the operation had no resolution to report.
 */
const localeRef = z.union([
  z.string().describe('Locale code, e.g. "de".'),
  localeRefInfo,
]).describe('The locale, either as a bare code or resolved to its code, language tag and file.')

const localeDefinition = z.object({
  code: z.string().describe('Locale code used in URLs and as the identifier everywhere else, e.g. "de".'),
  language: z.string().describe('BCP-47 language tag, e.g. "de-DE".'),
  file: z.string().optional()
    .describe('Locale file name, e.g. "de-DE.json". Absent for directory-per-locale layouts.'),
  name: z.string().optional().describe('Human-readable language name. Absent unless the framework config names one.'),
})

const localeRefAmbiguity = z.object({
  ref: z.string().describe('The locale ref as the caller wrote it.'),
  matchedBy: z.enum(['code', 'language', 'file'])
    .describe('Which field of the locale the ref matched on, in resolution precedence order.'),
  candidates: z.array(z.string()).describe('Codes of every locale the ref matched, in config order.'),
  resolvedTo: z.string().describe('The code that was used — the first candidate.'),
})

const unresolvedLocaleRef = z.object({
  ref: z.string().describe('The locale ref that matched no known locale. Nothing was written for it.'),
  keys: z.array(z.string()).describe('Dot-path keys whose value for this ref was dropped.'),
  suggestion: z.string().optional().describe('"Did you mean …?", when a near match exists.'),
})

const placeholderValidationIssue = z.object({
  locale: z.string().describe('Locale code the mismatch was found in.'),
  key: z.string().describe('Dot-path key of the mismatching translation.'),
  missing: z.array(z.string()).describe('Placeholders the source has and the translation dropped.'),
  extra: z.array(z.string()).describe('Placeholders the translation invented and the source does not have.'),
  kind: z.enum(['placeholder', 'plural-count']).optional()
    .describe('What failed: a placeholder set mismatch (the default) or a vue-i18n plural variant-count mismatch.'),
  sourceVariants: z.number().int().optional()
    .describe('Plural variants in the source value. Present only for kind "plural-count".'),
  targetVariants: z.number().int().optional()
    .describe('Plural variants in the translated value. Present only for kind "plural-count".'),
})

const placeholderValidation = z.object({
  ok: z.boolean().describe('True when every checked translation carries the same placeholders as its source.'),
  placeholders: z.array(z.string()).describe('Placeholder names found in the source values, e.g. ["{name}"].'),
  errors: z.array(placeholderValidationIssue).describe('One entry per translation that did not match. Empty when ok is true.'),
})

const mutationPreview = z.object({
  locale: z.string().describe('Locale code the value would be written to.'),
  key: z.string().describe('Dot-path key that would be written.'),
  value: z.string().describe('The value that would be written.'),
})

const translateMode = z.enum(['provider', 'agent', 'dry-run'])
  .describe('How the run was executed: "provider" called the configured LLM, "agent" returned contexts to translate by hand, "dry-run" wrote nothing.')

const translateFailReason = z.enum([
  'provider-error',
  'omitted-by-model',
  'placeholder-mismatch',
  'plural-mismatch',
  'write-error',
  'truncated',
]).describe('Why the key could not be translated. A closed set — branch on the value.')

const translateSkipReason = z.enum(['no-provider', 'already-translated', 'protected-locale'])
  .describe('Why the key or locale was deliberately not attempted. A closed set — branch on the value.')

/** Layer → the keys of that layer, as every scan reports its findings. */
const keysByLayer = z.record(
  z.string().describe('Layer name.'),
  z.array(z.string()).describe('Dot-path keys of that layer.'),
)

/** Locale → layer → keys, the shape every per-locale finding uses. */
const keysByLocaleAndLayer = z.record(
  z.string().describe('Locale code.'),
  keysByLayer,
)

const dynamicKeyRef = z.object({
  expression: z.string().describe('The key expression as written in source, e.g. "`errors.${code}`".'),
  file: z.string().optional()
    .describe('Source file, relative to the project directory. Absent for context-free bare candidates, which have no single call site.'),
  line: z.number().int().optional().describe('1-based line number in that file. Absent with file.'),
})

const unresolvedKeyWarningRef = z.object({
  expression: z.string().describe('The dynamic key expression that could not be resolved to concrete keys.'),
  file: z.string().describe('Source file, relative to the project directory.'),
  line: z.number().int().describe('1-based line number of the call.'),
  callee: z.string().describe('The translation function the expression was passed to, e.g. "t" or "$t".'),
  suggestedIgnorePattern: z.string().optional()
    .describe('A key glob for orphanScan.ignorePatterns that would cover this expression, when one can be derived.'),
})

const misplacedUsageRef = z.object({
  key: z.string().describe('Dot-path key referenced only from outside its layer\'s consumption scope.'),
  layer: z.string().describe('Layer the key is defined in.'),
  usingApps: z.array(z.string()).describe('Scan units (apps or layers) that reference it without consuming that layer.'),
})

const declaredNamespaceRef = z.object({
  pattern: z.string().describe('The declaredNamespaces pattern from the project config, e.g. "views.defaults.**".'),
  reason: z.string().describe('What keeps these keys alive, as the config declares it.'),
  matchedKeys: z.array(z.string()).describe('Keys of the checked layers this pattern covers. Empty means the declaration is stale.'),
})

const codeUsageRef = z.object({
  file: z.string().describe('Source file the key is referenced from, relative to the project directory.'),
  line: z.number().int().describe('1-based line number of the reference.'),
  callee: z.string().describe('The translation function the key was passed to, e.g. "t" or "$t".'),
})

/**
 * A read that takes limit and offset says whether it left rows behind. Read
 * the fields together: truncated says a cap applied, nextOffset is where the
 * next call starts.
 */
const pagedShape = {
  truncated: z.boolean().describe('True when limit cut the result short. The totals still count everything.'),
  nextOffset: z.number().int().optional().describe('The offset to pass to continue where this result stopped. Present only when truncated.'),
  message: z.string().optional().describe('The step to take next — how to continue a capped read. Present when there is one.'),
}

// ─── init ────────────────────────────────────────────────────────

const generatedProjectConfig = z.object({
  $schema: z.string().describe('Path or URL to the config JSON schema, for editor completion.'),
  context: z.string().describe('Free-form project background for a translating agent. Empty until you fill it in.'),
  glossary: z.record(
    z.string().describe('Source term.'),
    z.string().describe('How it must be translated.'),
  ).describe('Term dictionary for consistent translations. Empty until you fill it in.'),
  translationPrompt: z.string().describe('System prompt prepended to every translation request. Empty until you fill it in.'),
  localeNotes: z.record(
    z.string().describe('Locale code.'),
    z.string().describe('Register, regional conventions or other guidance for that locale.'),
  ).describe('Per-locale context included in translation prompts.'),
  localeDirs: z.array(z.union([
    z.string().describe('Relative path to a locale directory; its layer is named "default".'),
    z.object({
      path: z.string().describe('Relative path to a locale directory.'),
      layer: z.string().describe('Layer name for that directory.'),
    }),
  ])).optional()
    .describe('Locale directories. Written only for the generic adapter, which cannot derive them from a framework config.'),
  defaultLocale: z.string().optional()
    .describe('Default locale code. Written only where the adapter cannot derive it.'),
  locales: z.array(z.string()).optional()
    .describe('Locale codes. Written only where the adapter cannot derive them.'),
})

export const initResult = z.object({
  config: generatedProjectConfig.describe('The config that was written, or would be written under dryRun.'),
  detected: z.object({
    adapter: z.string().describe('Framework adapter that matched, e.g. "nuxt", "laravel", "generic".'),
    label: z.string().describe('Human-readable name of that adapter.'),
    confidence: z.number().describe('Detection score. 0 when nothing matched and the generic adapter was assumed.'),
    derivesLocaleConfig: z.boolean()
      .describe('True when the adapter resolves locales, layers and the default locale from the framework config. False only for the generic adapter, whose settings have to be written into the config file.'),
    runnersUp: z.array(z.object({
      name: z.string().describe('Adapter name.'),
      confidence: z.number().describe('Its detection score.'),
    })).optional().describe('Other adapters that also scored, best first. Absent when nothing else matched.'),
    note: z.string().optional().describe('Present when detection found nothing to point the config at.'),
  }).describe('What framework detection concluded.'),
  configPath: z.string().describe('Path of the config file, relative to the project directory.'),
  written: z.boolean().describe('True when the file was written. False under dryRun, and when an existing file was kept.'),
  overwritten: z.boolean().describe('True when an existing config file was replaced, which needs force.'),
})

// ─── discover ────────────────────────────────────────────────────

const localeDir = z.object({
  path: z.string().describe('Absolute path to the locale directory.'),
  layer: z.string().describe('Layer name, e.g. "root", "app-admin".'),
  layerRootDir: z.string().describe('Absolute path to that layer\'s root directory.'),
  aliasOf: z.string().optional()
    .describe('The layer this one points at, when the directory is an alias of another layer\'s. Absent for a layer of its own.'),
})

const appInfo = z.object({
  name: z.string().describe('App name, as orphan and status reports name it.'),
  rootDir: z.string().describe('Absolute path to the app\'s root directory.'),
  layers: z.array(z.string()).describe('Layer names this app consumes — its own plus every shared layer it can render.'),
  source: z.enum(['workspace', 'declared']).optional()
    .describe('Where the consumption edges came from when not the framework adapter: "workspace" from package.json inference, "declared" from the config. Absent means the adapter.'),
})

const localeDirInfo = z.object({
  layer: z.string().describe('Layer name. Pass this as the layer argument of any other call.'),
  path: z.string().describe('Absolute path to the locale directory.'),
  aliasOf: z.string().optional().describe('The layer this one aliases. Absent for a layer of its own.'),
  fileCount: z.number().int().describe('Number of locale files in the directory. 0 for an alias layer.'),
  topLevelKeys: z.array(z.string()).optional()
    .describe('Top-level keys of one locale file, for a flat layout. Absent for a namespaced layout.'),
  namespaces: z.array(z.string()).optional()
    .describe('Namespace file names of one locale directory, for a namespaced layout such as Laravel. Absent for a flat layout.'),
})

const serializedLayerGraph = z.object({
  canonical: z.array(z.string()).describe('Alias-free layer names, in config order.'),
  shared: z.array(z.string())
    .describe('Canonical layers more than one app consumes — where a key used by several apps belongs.'),
  aliases: z.record(
    z.string().describe('Alias layer name.'),
    z.string().describe('The canonical layer whose locale directory it points at.'),
  ).describe('Alias layer → canonical layer. Empty when no layer aliases another.'),
  consumers: z.record(
    z.string().describe('Canonical layer name.'),
    z.array(z.string()).describe('Apps that consume it; empty when nothing does.'),
  ).describe('Every canonical layer is a key, so "no consumers" and "not computed" cannot be confused.'),
})

/**
 * The resolved configuration, which `discover` answers with as a superset
 * rather than nesting under a `config` key. Kept as a shape rather than a
 * schema of its own because that is how it is spread into the result.
 */
const i18nConfigShape = {
  framework: z.string().optional().describe('Detected framework, e.g. "nuxt", "laravel". Absent when nothing was detected.'),
  rootDir: z.string().describe('Absolute path to the project root.'),
  defaultLocale: z.string().describe('Default locale code — the source locale every translate call falls back to.'),
  fallbackLocale: z.record(
    z.string().describe('Locale code, or "default".'),
    z.array(z.string()).describe('Locale codes to fall back to, in order.'),
  ).describe('The framework\'s fallback chain. Empty when the framework declares none.'),
  locales: z.array(localeDefinition).describe('Every locale of the project.'),
  localeDirs: z.array(localeDir).describe('Every locale directory, one per layer, alias layers included.'),
  layerRootDirs: z.array(z.string()).describe('Absolute root directories of every layer, which is what source scanning walks.'),
  projectConfig: z.union([
    projectConfigSchema,
    // A tool call gets the config without its translation prose, which the
    // server's prompts already carry; the flag says the prose exists.
    projectConfigSchema
      .omit({ context: true, glossary: true, translationPrompt: true, localeNotes: true, examples: true })
      .extend({
        translationGuidanceOmitted: z.literal(true)
          .describe('The translation prose (context, glossary, translationPrompt, localeNotes, examples) exists but was left out. Ask with includeTranslationGuidance for it.'),
      }),
  ]).optional()
    .describe('The declared config from i18n-kit.config.ts or .i18n-mcp.json, as written — or without its translation prose, flagged. Absent when the project has none.'),
  localeFileFormat: z.enum(['json', 'php-array', 'yaml']).optional()
    .describe('Format of the locale files. Absent means the default, "json".'),
  apps: z.array(appInfo).describe('Apps and the layers each consumes — the consumer graph orphan scoping reads.'),
}

/**
 * Everything `discover` answers with. The three server-owned fields at the end
 * are added by the MCP server after the operation returns: the project cannot
 * know how the process running it is configured, and this is where an operator
 * verifies that configuration without triggering a translation.
 */
export const discoverResult = z.object({
  ...i18nConfigShape,
  protectedLocales: z.array(z.string())
    .describe('Canonical codes of the locales the translate operations leave alone. Empty when none are protected.'),
  layers: z.array(localeDirInfo).describe('One entry per locale directory, with file counts and key namespaces.'),
  layerGraph: serializedLayerGraph
    .describe('Which layers are shared and which apps consume which layer — what answers where a new key belongs.'),
  translationMode: z.enum(['provider', 'agent']).optional()
    .describe('Added by the server: whether it has an LLM provider configured ("provider") or hands back contexts to translate inline ("agent"). Check this before calling a translating tool.'),
  translationProvider: z.string().optional()
    .describe('Added by the server: the configured provider name. Absent in agent mode.'),
  translationModel: z.string().optional()
    .describe('Added by the server: the configured model name. Absent in agent mode.'),
})

/** The fields the MCP server adds to the discover result after the operation ran. */
type ServerAddedDiscoverFields = 'translationMode' | 'translationProvider' | 'translationModel'

// ─── list_namespaces ─────────────────────────────────────────────

/** The recursive half of the namespace tree, stated once for the lazy schema. */
interface NamespaceNodeShape {
  keyCount: number
  children?: Record<string, NamespaceNodeShape>
}

const namespaceNode: z.ZodType<NamespaceNodeShape> = z.lazy(() => z.object({
  keyCount: z.number().int().describe('Translation keys under this namespace, including every nested one.'),
  children: z.record(
    z.string().describe('Next path segment.'),
    namespaceNode,
  ).optional().describe('Nested namespaces. Absent at a leaf, where the segment holds keys and no further nesting.'),
}))

export const listNamespacesResult = z.object({
  layers: z.record(
    z.string().describe('Layer name.'),
    z.object({
      namespaces: z.record(
        z.string().describe('Top-level key segment, e.g. "auth".'),
        namespaceNode,
      ).describe('The key tree of that layer, one entry per top-level segment.'),
    }),
  ).describe('One entry per scanned layer. Alias layers are skipped.'),
  totalNamespaces: z.number().int().describe('Top-level namespaces across every scanned layer, before limit. A namespace brings its whole subtree, so this is what limit counts.'),
  ...pagedShape,
})

// ─── get_translations ────────────────────────────────────────────

const getTranslationsLayerResult = z.record(
  z.string().describe('Locale code, or "byKey" in compact mode.'),
  z.record(
    z.string().describe('The dot-path key as it was requested, or the key being summarised in compact mode.'),
    translationValue.describe('The value that locale holds, or null when the key is not defined there. In compact mode, a per-key digest: status ("ok" | "partial" | "missing"), totalPresent, and the locales the key is empty or missing in.'),
  ),
).describe('Locale code → requested key → value. With compact and locale "*", one entry keyed "byKey" holding a digest per key instead.')

export const getTranslationsResult = z.union([
  getTranslationsLayerResult,
  z.object({
    byLayer: z.record(
      z.string().describe('Layer name.'),
      getTranslationsLayerResult,
    ).describe('One entry per layer that defines at least one of the keys, each exactly what a read of that layer alone returns.'),
    layersSearched: z.array(z.string()).describe('Every layer that was read, the ones defining none of the keys included.'),
    ...pagedShape,
  }).describe('The shape a read with no layer answers with.'),
]).describe('With a layer: locale → key → value. Without one: the same per layer that defines the keys, under byLayer.')

// ─── write_translations ──────────────────────────────────────────

export const writeTranslationsResult = z.object({
  dryRun: z.boolean().optional().describe('True when nothing was written because a preview was asked for. Absent otherwise.'),
  wouldWrite: z.array(mutationPreview).optional()
    .describe('The writes a dry run would make. Present only with dryRun.'),
  written: z.array(z.string()).optional()
    .describe('Dot-path keys that were written. Absent on a dry run.'),
  skipped: z.array(z.string())
    .describe('Keys the write mode left alone — existing keys under mode "add", missing ones under mode "update".'),
  filesWritten: z.number().int().optional().describe('Number of locale files changed on disk. Absent on a dry run.'),
  warnings: z.array(z.string()).optional().describe('Non-fatal problems, e.g. a value written over a nested object. Absent when there are none.'),
  placeholderValidation: placeholderValidation.optional()
    .describe('Placeholder comparison of the written values against the reference locale. Absent when nothing was comparable.'),
  unresolvedLocales: z.array(unresolvedLocaleRef).optional()
    .describe('Locale refs that matched no known locale; their values were dropped while other locales were still written. Absent when every ref resolved.'),
  ambiguousLocales: z.array(localeRefAmbiguity).optional()
    .describe('Locale refs that matched several locales, with the one precedence picked. Absent when every ref was unambiguous.'),
  summary: z.object({
    keysWritten: z.number().int().describe('Number of keys written across every locale.'),
    keysSkipped: z.number().int().describe('Number of keys the write mode left alone.'),
    message: z.string().describe('One sentence stating what the run did.'),
  }).optional().describe('Counts of what the run did. Absent on a dry run.'),
  skippedKeys: z.array(z.string()).optional()
    .describe('The keys behind keysSkipped, when the mode skipped any. Absent when nothing was skipped.'),
  message: z.string().optional().describe('The step to take next, as the surface the call ran on phrases it. Present only when there is no summary to carry it.'),
})

// ─── get_missing_translations ────────────────────────────────────

export const missingTranslationsResult = z.object({
  ...pagedShape,
  missing: keysByLocaleAndLayer
    .describe('Locale → layer → keys the reference locale defines and this locale does not. A locale with nothing missing is absent.'),
  summary: z.object({
    referenceLocale: localeRef.describe('The locale the missing keys were compared against.'),
    targetLocales: z.array(localeRef).describe('The locales that were checked.'),
    layersScanned: z.array(z.string()).describe('Layer names the scan covered.'),
    totalMissingKeys: z.number().int().describe('Missing keys across every locale and layer. The counter the missing gate reads.'),
    message: z.string().optional().describe('The step to take next, as the surface the call ran on phrases it. Present when there is one.'),
  }).describe('What was compared, and how much of it is missing. This is what comes back when the full result is diverted to a file.'),
})

// ─── get_translation_status ──────────────────────────────────────

const localeStatus = localeRefInfo.extend({
  total: z.number().int().describe('Keys the reference locale defines in the scanned layers.'),
  translated: z.number().int().describe('Keys this locale holds a non-empty value for.'),
  missing: z.number().int().describe('Keys absent from this locale\'s files.'),
  empty: z.number().int().describe('Keys present with an empty-string value — scaffolded and never filled. They render as nothing, and are never reported as missing.'),
  completion: z.number().describe('translated ÷ total as a percentage, 0–100.'),
  stale: z.number().int().optional()
    .describe('Keys whose value was written from source text that has changed since, per the translation memory. Present only when a lockfile exists; translate with overwriteStale refreshes them.'),
  protected: z.literal(true).optional()
    .describe('Present when the locale is listed in protectedLocales, so translation leaves it alone.'),
  excludedFromOverall: z.literal(true).optional()
    .describe('Present when the locale is kept out of summary.completionPercent, which is what protection means for the overall figure.'),
})

const layerStatus = z.object({
  layer: z.string().describe('Layer name.'),
  total: z.number().int().describe('Keys the reference locale defines in this layer, times the locales checked.'),
  translated: z.number().int().describe('Of those, the ones holding a non-empty value.'),
  missing: z.number().int().describe('Of those, the ones absent from the locale file.'),
  empty: z.number().int().describe('Of those, the ones present with an empty-string value.'),
  completion: z.number().describe('translated ÷ total as a percentage, 0–100.'),
  stale: z.number().int().optional()
    .describe('Keys of this layer, over the locales checked, whose value was written from source text that has changed since. Present only when a translation memory lockfile exists.'),
  consumedBy: z.array(z.string())
    .describe('Apps whose declared layers include this one. Empty means either no app information exists or nothing consumes the layer.'),
})

export const translationStatusResult = z.object({
  locales: z.array(localeStatus).describe('Coverage per locale, protected locales included and marked.'),
  layers: z.array(layerStatus).describe('Coverage per layer, summed over the locales checked.'),
  empty: keysByLocaleAndLayer.optional()
    .describe('Locale → layer → the keys behind summary.emptyKeys. Present only when the caller asked for them.'),
  emptyInReference: keysByLayer.optional()
    .describe('Layer → keys whose value is empty in the reference locale itself, so there is nothing to translate from. Present only alongside empty, and only when there are any.'),
  summary: z.object({
    referenceLocale: localeRefInfo.describe('The locale coverage was measured against.'),
    layersScanned: z.array(z.string()).describe('Layer names the scan covered.'),
    unconsumedLayers: z.array(z.string())
      .describe('Scanned layers no app consumes — keys nothing can render. Empty unless the project declares more than one app.'),
    localesChecked: z.number().int().describe('Number of locales measured, protected ones included.'),
    protectedLocales: z.array(z.string()).describe('Canonical codes kept out of the overall figure because they are maintained by hand.'),
    totalKeys: z.number().int().describe('Keys expected across every checked locale and layer.'),
    translatedKeys: z.number().int().describe('Of those, the ones holding a non-empty value.'),
    missingKeys: z.number().int().describe('Of those, the ones absent from their locale file.'),
    emptyKeys: z.number().int().describe('Of those, the ones present with an empty-string value.'),
    staleCount: z.number().int().optional()
      .describe('Of those, the ones written from source text that has changed since, per the translation memory. Present only when a lockfile exists.'),
    completionPercent: z.number().describe('Overall completion, 0–100, protected locales excluded. The counter the completion gate reads.'),
  }).describe('Project-wide coverage in one object. This is what comes back when the full result is diverted to a file.'),
})

// ─── search_translations ─────────────────────────────────────────

const searchKeyMatch = z.object({
  key: z.string().describe('The matching dot-path key.'),
  layers: z.array(z.string()).describe('Every searched layer that defines it. More than one means the key is duplicated across layers.'),
  value: translationValue.describe('What the locale named below holds for the key.'),
  locale: z.string().describe('Which locale value was read from: the reference locale where it defines the key, otherwise the first searched locale that does.'),
  localeCount: z.number().int().describe('How many of the searched locales define the key.'),
})

const searchMatch = z.object({
  layer: z.string().describe('Layer the match was found in.'),
  locale: z.string().describe('Locale the match was found in.'),
  key: z.string().describe('The matching dot-path key.'),
  value: translationValue.describe('What that locale holds for the key.'),
})

export const searchTranslationsResult = z.object({
  matches: z.union([z.array(searchKeyMatch), z.array(searchMatch)])
    .describe('One row per key by default; one row per key and locale when includeLocales was passed.'),
  totalMatches: z.number().int().describe('Number of rows the search found, whichever shape they are in — before limit, so it exceeds the rows in matches when truncated.'),
  ...pagedShape,
})

/** The stand-in a diverted search returns: the count is what is left once the matches are on disk. */
export const searchReportSummary = z.object({
  totalMatches: searchTranslationsResult.shape.totalMatches,
  truncated: z.literal(true).optional().describe('Present when the diverted search was cut by limit.'),
  nextOffset: pagedShape.nextOffset,
})

// ─── remove_translations ─────────────────────────────────────────

export const removeTranslationsResult = z.object({
  dryRun: z.boolean().optional().describe('True when nothing was removed because a preview was asked for. Absent otherwise.'),
  wouldRemove: z.array(z.object({
    locale: z.string().describe('Locale the key would be removed from.'),
    key: z.string().describe('Dot-path key that would be removed.'),
    oldValue: translationValue.describe('The value that would be lost.'),
  })).optional().describe('What a dry run would remove. Present only with dryRun.'),
  removed: z.array(z.string()).optional().describe('Dot-path keys removed from at least one locale file. Absent on a dry run.'),
  removedPerLocale: z.array(z.string()).optional().describe('One "locale:key" entry per file-level removal. Absent on a dry run.'),
  notFound: z.array(z.string()).optional().describe('Requested keys no locale file of the layer defined. Absent when every key existed.'),
  filesWritten: z.number().int().optional().describe('Number of locale files changed on disk. Absent on a dry run.'),
  summary: z.object({
    keysFound: z.number().int().describe('Requested keys that existed and were removed.'),
    message: z.string().describe('One sentence stating what the run did.'),
  }).optional().describe('Counts of what the run did. Absent on a dry run.'),
  message: z.string().optional().describe('The step to take next, as the surface the call ran on phrases it. Present only when there is no summary to carry it.'),
})

// ─── move_translation_key ────────────────────────────────────────

const moveSummary = z.object({
  localesAffected: z.number().int().describe('Number of locales whose files changed, or would change.'),
  message: z.string().describe('One sentence stating what the run did.'),
  warning: z.string().optional().describe('Present when the run wrote less than asked — a conflict, or a key some locales do not define.'),
})

const moveTranslationKeyResult = z.object({
  dryRun: z.boolean().optional().describe('True when nothing was written because a plan was asked for. Absent otherwise.'),
  wouldMove: z.array(z.object({
    locale: z.string().describe('Locale this entry is about.'),
    value: translationValue.describe('The value that would be carried over.'),
    action: z.enum(['move', 'deduplicate'])
      .describe('"move" writes the target and drops the source; "deduplicate" finds the target already holding the same value, so only the source is dropped.'),
  })).optional().describe('The plan, one entry per locale. Present only with dryRun.'),
  movedLocales: z.array(z.string()).optional().describe('Locales whose value was written to the destination layer. Absent on a dry run.'),
  deduplicatedLocales: z.array(z.string()).optional()
    .describe('Locales where the destination already held this value, so only the source copy was dropped.'),
  filesWritten: z.number().int().optional().describe('Number of locale files changed on disk. Absent on a dry run.'),
  fromLayer: z.string().optional().describe('Layer the key was moved out of.'),
  toLayer: z.string().optional().describe('Layer the key was moved into.'),
  key: z.string().optional().describe('The key as it was before the move.'),
  newKey: z.string().optional().describe('The key path it now has. Equal to key when only the layer changed.'),
  notFoundInLocales: z.array(z.string()).optional().describe('Locales whose source layer does not define the key at all.'),
  conflictsInLocales: z.array(z.string()).optional()
    .describe('Locales where the destination holds a different value. Nothing is written at all when this is non-empty.'),
  summary: moveSummary.optional().describe('Counts of what the run did.'),
  message: z.string().optional().describe('The step to take next, as the surface the call ran on phrases it. Present only when there is no summary to carry it.'),
})

const renameTranslationKeyResult = z.object({
  dryRun: z.boolean().optional().describe('True when nothing was written because a plan was asked for. Absent otherwise.'),
  wouldRename: z.array(z.object({
    locale: z.string().describe('Locale this entry is about.'),
    oldKey: z.string().describe('The key path today.'),
    newKey: z.string().describe('The key path it would get.'),
    value: translationValue.describe('The value that would move with it.'),
  })).optional().describe('The plan, one entry per locale. Present only with dryRun.'),
  renamed: z.array(z.string()).optional().describe('Locales whose file was rewritten with the new key. Absent on a dry run.'),
  filesWritten: z.number().int().optional().describe('Number of locale files changed on disk. Absent on a dry run.'),
  oldKey: z.string().optional().describe('The key path before the rename.'),
  newKey: z.string().optional().describe('The key path after it.'),
  notFoundInLocales: z.array(z.string()).optional().describe('Locales that do not define the key at all.'),
  conflictsInLocales: z.array(z.string()).optional().describe('Locales that already hold a different value under the new key.'),
  skippedDueToConflict: z.array(z.string()).optional().describe('Locales left untouched because of such a conflict.'),
  summary: moveSummary.optional().describe('Counts of what the run did.'),
  message: z.string().optional().describe('The step to take next, as the surface the call ran on phrases it. Present only when there is no summary to carry it.'),
})

/**
 * A rename result when the key stayed in its layer, a move result when it
 * changed layers — the union the operation returns rather than one merged
 * shape carrying fields that can never be set for the other half.
 */
export const moveTranslationKeyOutcome = z.union([
  moveTranslationKeyResult,
  renameTranslationKeyResult,
])

// ─── translate_missing ───────────────────────────────────────────

const translateMissingLocaleResult = z.object({
  mode: translateMode,
  missing: z.number().int()
    .describe('Keys missing for this locale. Always equals translated + wouldTranslate + failed + skipped.'),
  translated: z.array(z.string()).describe('Keys translated and written.'),
  wouldTranslate: z.array(z.string()).optional().describe('Keys a dry run would translate. Present only on a dry run.'),
  failed: z.array(z.object({
    key: z.string().describe('The key that could not be translated.'),
    reason: translateFailReason,
  })).describe('Keys the run attempted and lost. They are still missing; a re-run retries them.'),
  skipped: z.array(z.object({
    key: z.string().describe('The key that was not attempted.'),
    reason: translateSkipReason,
  })).describe('Keys deliberately not attempted.'),
  stale: z.array(z.string()).optional()
    .describe('Keys whose target was written from source text that has changed since, left untouched by this run. Translation memory only, and outside the missing invariant — these keys are translated, just outdated.'),
  batches: z.number().int().optional().describe('Provider requests this locale took. Absent outside provider mode.'),
  model: z.string().optional().describe('Model that produced the translations. Absent outside provider mode.'),
  writeError: z.string().optional().describe('Present when translations were produced but writing the locale file failed.'),
  placeholderValidation: placeholderValidation.optional()
    .describe('Placeholder comparison of the new values against their source. Absent when nothing was translated.'),
})

const translateMissingCompactEntry = z.object({
  locale: z.string().describe('Locale code this digest is about.'),
  mode: translateMode,
  missing: z.number().int().describe('Keys missing for this locale.'),
  translated: z.number().int().describe('Of those, the ones translated and written.'),
  failed: z.number().int().describe('Of those, the ones attempted and lost.'),
  skipped: z.number().int().describe('Of those, the ones deliberately not attempted.'),
  wouldTranslate: z.number().int().optional().describe('Keys a dry run would translate. Present only on a dry run.'),
  stale: z.number().int().optional().describe('Keys left untouched as outdated. Translation memory only.'),
  batches: z.number().int().optional().describe('Provider requests this locale took. Absent outside provider mode.'),
  model: z.string().optional().describe('Model that produced the translations. Absent outside provider mode.'),
  writeError: z.string().optional().describe('Present when writing the locale file failed.'),
})

/** Prompt material for agent mode: what to translate, plus the project's own glossary and notes. */
const fallbackContexts = z.record(
  z.string().describe('Target locale code.'),
  z.record(
    z.string().describe('Context field, e.g. "keysToTranslate", "glossary", "instructions".'),
    z.unknown().describe('The value of that field, as the prompt builder produced it.'),
  ),
).describe('Per-locale context to translate inline and persist with write_translations. Present only in agent mode.')

const translateMissingLayerResult = z.object({
  results: z.record(
    z.string().describe('Target locale code.'),
    translateMissingLocaleResult,
  ).optional().describe('Full per-locale results. Absent in compact mode, which returns summary.byLocale instead.'),
  fallbackContexts: fallbackContexts.optional(),
  summary: z.object({
    byLocale: z.array(translateMissingCompactEntry).optional()
      .describe('A per-locale digest in place of full results. Present only in compact mode.'),
    mode: translateMode,
    totalTranslated: z.number().int().describe('Keys translated and written across every locale.'),
    totalFailed: z.number().int().describe('Keys attempted and lost across every locale. The counter the translate gate reads.'),
    totalSkipped: z.number().int().describe('Keys deliberately not attempted across every locale.'),
    totalWouldTranslate: z.number().int().optional().describe('Keys a dry run would translate. Present only on a dry run.'),
    staleCount: z.number().int().optional().describe('Stale keys left untouched across every locale. Translation memory only.'),
    layer: z.string().describe('The layer that was translated.'),
    referenceLocale: localeRef.describe('The locale the translations were made from.'),
    targetLocales: z.array(localeRef).describe('The locales that were translated into.'),
    dryRun: z.boolean().describe('True when nothing was written because a preview was asked for.'),
    message: z.string().optional()
      .describe('What to do next: how to persist the fallback contexts in agent mode, or which locales lost keys after a partial failure. Absent when a run needs nothing from you.'),
  }).describe('What the run did across every locale of the layer.'),
})

const translateLayerTotals = z.object({
  layer: z.string().describe('Layer these totals are for.'),
  totalTranslated: z.number().int().describe('Keys translated and written in that layer.'),
  totalFailed: z.number().int().describe('Keys attempted and lost in that layer.'),
  totalSkipped: z.number().int().describe('Keys deliberately not attempted in that layer.'),
  totalWouldTranslate: z.number().int().describe('Keys a dry run would translate. 0 outside a dry run.'),
})

const translateAllLayersResult = z.object({
  layers: z.record(
    z.string().describe('Layer name.'),
    translateMissingLayerResult,
  ).describe('One full result per locale-backed layer.'),
  summary: z.object({
    mode: translateMode,
    totalTranslated: z.number().int().describe('Keys translated and written across every layer and locale.'),
    totalFailed: z.number().int().describe('Keys attempted and lost across every layer and locale. The counter the translate gate reads.'),
    totalSkipped: z.number().int().describe('Keys deliberately not attempted across every layer and locale.'),
    totalWouldTranslate: z.number().int().optional().describe('Keys a dry run would translate. Present only on a dry run.'),
    staleCount: z.number().int().optional().describe('Stale keys left untouched across every layer and locale. Translation memory only.'),
    layers: z.array(z.string()).describe('Layer names that were translated.'),
    byLayer: z.array(translateLayerTotals).describe('The same totals split per layer.'),
    dryRun: z.boolean().describe('True when nothing was written because a preview was asked for.'),
    referenceLocale: localeRef.optional().describe('The locale the translations were made from.'),
    targetLocales: z.array(localeRef).optional().describe('The locales that were translated into.'),
    message: z.string().optional()
      .describe('What to do next: how to persist the fallback contexts in agent mode, or which locales lost keys after a partial failure. Absent when a run needs nothing from you.'),
  }).describe('What the run did across every layer and locale, with the per-layer split under byLayer.'),
})

/**
 * One layer, or every layer at once. Both members carry a `summary` and both
 * summaries carry `mode`, so a mode check needs no narrowing; `layers` is what
 * tells the all-layers answer apart.
 */
export const translateMissingOutcome = z.union([
  translateMissingLayerResult,
  translateAllLayersResult,
])

// ─── translate_key ───────────────────────────────────────────────

export const translateKeyResult = z.object({
  key: z.string().describe('The key that was translated.'),
  sourceLocale: localeRefInfo.describe('The locale the translation was made from.'),
  updatedSource: z.boolean().describe('True when a sourceValue was written to the source locale before translating.'),
  mode: translateMode,
  translated: z.array(z.string()).describe('Locales whose value was written.'),
  wouldTranslate: z.array(z.string()).optional().describe('Locales a dry run would translate. Present only on a dry run.'),
  skipped: z.array(z.object({
    locale: z.string().describe('Locale that was left alone.'),
    reason: translateSkipReason,
    stale: z.boolean().optional()
      .describe('Refines "already-translated": true when the existing value was written from source text that has changed since. Translation memory only.'),
  })).describe('Locales deliberately not translated.'),
  failed: z.array(z.object({
    locale: z.string().describe('Locale that could not be translated.'),
    reason: z.union([translateFailReason, z.literal('read-error')])
      .describe('Why it failed. "read-error" means the locale file could not be read at all.'),
    detail: z.string().optional().describe('The underlying message, when there is one worth passing on.'),
  })).describe('Locales the run attempted and lost.'),
  filesWritten: z.number().int().describe('Number of locale files changed on disk. 0 on a dry run.'),
  dryRun: z.boolean().describe('True when nothing was written because a preview was asked for.'),
  model: z.string().optional().describe('Model that produced the translations. Absent outside provider mode.'),
  placeholderValidation: placeholderValidation
    .describe('Placeholder comparison of the new values against the source value.'),
  preview: z.record(
    z.string().describe('Locale code.'),
    z.string().describe('The value written for that locale.'),
  ).optional().describe('The translated values. Present only when includePreview was passed.'),
  fallbackContext: z.record(
    z.string().describe('Context field, e.g. "keysToTranslate", "glossary", "instructions".'),
    z.unknown().describe('The value of that field, as the prompt builder produced it.'),
  ).optional().describe('Context to translate inline and persist with write_translations. Present only in agent mode.'),
  message: z.string().optional()
    .describe('What to do next, when the run needs something from you — in agent mode, that the fallbackContext has to be translated and written back.'),
})

// ─── find_undefined_keys ─────────────────────────────────────────

const keyUsageLocation = z.object({
  file: z.string().describe('Source file, relative to the project directory.'),
  line: z.number().int().describe('1-based line number of the reference.'),
})

const undefinedKeyFinding = z.object({
  key: z.string().describe('The key source code calls and no consumed layer defines.'),
  app: z.string().describe('Scan unit the usage lives in — an app name, a layer name, or "project-root".'),
  searchedLayers: z.array(z.string()).describe('Layers that unit can resolve keys from. All were searched.'),
  usages: z.array(keyUsageLocation).describe('Every call site of the key.'),
})

export const checkUndefinedKeysResult = z.object({
  undefinedKeys: z.array(undefinedKeyFinding)
    .describe('Hard findings: keys that render raw at runtime. A write run leaves them listed, because the call sites are what a reader has to visit either way.'),
  uncertainKeys: z.array(undefinedKeyFinding.extend({
    reason: z.string().describe('Why this is not a hard finding — a dynamically built key, an existence check, a vendor namespace.'),
  })).describe('Findings static extraction cannot verify. Never written, never counted by the gate.'),
  limitation: z.string().describe('What this scan cannot see, in one paragraph. Read it before acting on the uncertain findings.'),
  written: z.object({
    layer: z.string().describe('Layer the keys were added to.'),
    locale: z.string().describe('The project default locale — the only one written, and the source every other is filled from.'),
    keys: z.array(z.string()).describe('The keys that reached the file, alphabetically.'),
  }).optional().describe('Present only when write was asked for and the scan found something to write.'),
  summary: z.object({
    usedKeysChecked: z.number().int().describe('Distinct statically referenced keys across every scan unit.'),
    undefinedCount: z.number().int()
      .describe('Keys that render raw at runtime, which is the counter the always-on gate reads. After a write run this counts the ones still undefined.'),
    writtenCount: z.number().int().optional().describe('Keys extracted into a locale file. Present only alongside written.'),
    uncertainCount: z.number().int().describe('Findings static extraction could not verify.'),
    ignoredCount: z.number().int().describe('Unresolvable keys excluded by an orphanScan ignorePattern.'),
    declaredCount: z.number().int().describe('Unresolvable keys covered by a declaredNamespaces entry — defined by contract, never written.'),
    filesScanned: z.number().int().describe('Source files read.'),
    filesDeclined: z.number().int().describe('Files a syntax frontend declined; pattern matching read them instead.'),
    locale: z.string().describe('Locale the key definitions were resolved in.'),
    searchedLayersByApp: z.record(
      z.string().describe('Scan unit name.'),
      z.array(z.string()).describe('Layers searched for that unit\'s key usages.'),
    ).describe('What "undefined" meant per scan unit: a key defined only in a layer the unit does not consume is still undefined for it.'),
    message: z.string().describe('One sentence stating what the scan found.'),
  }).describe('What the scan covered and what it found. This is what comes back when the full result is diverted to a file.'),
})

// ─── find_orphan_keys ────────────────────────────────────────────

const orphanScanSummaryShape = {
  totalKeys: z.number().int().describe('Translation keys of the checked layers.'),
  uncertainCount: z.number().int().optional().describe('Keys with ambiguous usage evidence. Never deleted, in any mode.'),
  misplacedCount: z.number().int().optional().describe('Keys used only from apps that do not consume their layer. Never deleted.'),
  dynamicMatchedCount: z.number().int().optional().describe('Keys kept alive by a dynamic key expression rather than a literal call.'),
  ignoredCount: z.number().int().optional().describe('Keys excluded by an orphanScan ignorePattern.'),
  declaredCount: z.number().int().optional().describe('Keys withheld from the orphan list by a declaredNamespaces entry.'),
  linkedCount: z.number().int().optional().describe('Keys withheld because another message\'s value links to them with @:. Protected in every layer, never deleted.'),
  usedCount: z.number().int().optional().describe('Keys with usage evidence in a consuming app.'),
  layersChecked: z.array(z.string()).optional().describe('Layer names the scan covered.'),
  dirsScanned: z.array(z.string()).optional().describe('Directories the source scan walked.'),
  scanScope: z.record(
    z.string().describe('Layer name.'),
    z.array(z.string()).describe('Directories that layer was checked against.'),
  ).optional().describe('Each layer\'s effective scope: the code of the apps that consume it.'),
  locale: z.string().optional().describe('Locale the translation keys were read from.'),
  message: z.string().optional().describe('One sentence stating what the scan found.'),
}

const orphanFindingsShape = {
  uncertainKeys: keysByLayer.optional().describe('Layer → keys with ambiguous usage evidence. Never deleted, in any mode.'),
  misplacedUsages: z.array(misplacedUsageRef).optional()
    .describe('Keys referenced only from apps that do not consume the owning layer. Reported instead of being called orphans, and never deleted.'),
  misplacedUsageNote: z.string().optional().describe('What to do about the misplaced usages. Present alongside them.'),
  declaredNamespaces: z.array(declaredNamespaceRef).optional()
    .describe('Every declared namespace with the keys it covers — the keys this scan will not report. Present when the config declares any.'),
  declaredNamespaceNote: z.string().optional().describe('How to read the declared namespaces. Present alongside them.'),
  dynamicKeyWarning: z.string().optional().describe('Present when dynamic key expressions were found, which is when the orphan list is a candidate list rather than a verdict.'),
  dynamicKeys: z.array(dynamicKeyRef).optional().describe('Dynamic key expressions found in source, with their call sites.'),
  unresolvedKeyWarnings: z.array(unresolvedKeyWarningRef).optional()
    .describe('Dynamic expressions that could not be resolved to concrete keys, each with an ignore pattern that would cover it.'),
}

export const findOrphanKeysResult = z.object({
  orphanKeys: keysByLayer.describe('Layer → keys no source code of a consuming app references. The only keys remove ever deletes.'),
  ...orphanFindingsShape,
  candidateOnlyKeys: keysByLayer.optional()
    .describe('Layer → keys kept alive only by the bare-candidate net: a dotted string somewhere shares their name, but nothing a frontend calls a usage references them. Not orphans, but where dead references hide.'),
  candidateOnlyNote: z.string().optional().describe('How to read the candidate-only keys. Present alongside them.'),
  linkedNote: z.string().optional().describe('Why keys linked with @: from another message\'s value are not orphans. Present when any is.'),
  summary: z.object({
    ...orphanScanSummaryShape,
    orphanCount: z.number().int().describe('Keys nothing references. The counter the orphan gate reads.'),
    candidateOnlyCount: z.number().int().optional().describe('Keys kept alive only by the bare-candidate net.'),
    filesScanned: z.number().int().describe('Source files read.'),
    filesDeclined: z.number().int().optional().describe('Files a syntax frontend declined; pattern matching read them instead.'),
  }).describe('What the scan covered and what it found. This is what comes back when the full result is diverted to a file.'),
})

export const removeOrphanKeysResult = z.object({
  orphanKeys: keysByLayer.optional().describe('Layer → keys that were found unreferenced. Present on a dry run.'),
  removed: keysByLayer.optional().describe('Layer → keys deleted from every locale file of that layer.'),
  ...orphanFindingsShape,
  summary: z.object({
    ...orphanScanSummaryShape,
    dryRun: z.boolean().optional().describe('True when nothing was deleted because a preview was asked for.'),
    orphanCount: z.number().int().optional().describe('Keys nothing references. The counter the orphan gate reads.'),
    removedCount: z.number().int().optional().describe('Keys deleted from their layer.'),
    remainingCount: z.number().int().optional().describe('Keys left in the layer after the removal.'),
    filesScanned: z.number().int().optional().describe('Source files read.'),
    filesWritten: z.number().int().optional().describe('Locale files changed on disk.'),
  }).describe('What the removal covered and what it deleted. This is what comes back when the full result is diverted to a file.'),
})

export const codeUsageResult = z.object({
  usages: z.record(
    z.string().describe('Dot-path key.'),
    z.array(codeUsageRef).describe('Every place that key is referenced.'),
  ).describe('Key → its references in source. Only keys with at least one reference appear.'),
  notFoundInCode: z.array(z.string()).optional().describe('Requested keys with no reference anywhere in the scanned source.'),
  dynamicKeys: z.array(dynamicKeyRef).optional().describe('Dynamic expressions that could reach the requested keys.'),
  summary: z.object({
    uniqueKeysFound: z.number().int().describe('Distinct keys with at least one reference.'),
    totalReferences: z.number().int().describe('Reference sites across every key.'),
    filesScanned: z.number().int().describe('Source files read.'),
    filesDeclined: z.number().int().optional().describe('Files a syntax frontend declined; pattern matching read them instead.'),
    dirsScanned: z.array(z.string()).optional().describe('Directories the scan walked.'),
    message: z.string().optional().describe('One sentence stating what the scan found.'),
  }).describe('What the usage scan covered and what it found. This is what comes back when the full result is diverted to a file.'),
})

/**
 * Three questions about one subject, so three shapes: which keys nothing
 * references, the same after deleting them, and where the references that do
 * exist are. `remove` and `usages` decide which one comes back.
 */
export const orphanCommandResult = z.union([
  findOrphanKeysResult,
  removeOrphanKeysResult,
  codeUsageResult,
])

/** The stand-in a diverted orphan run returns, whichever of the three it was. */
export const orphanReportSummary = z.union([
  findOrphanKeysResult.shape.summary,
  removeOrphanKeysResult.shape.summary,
  codeUsageResult.shape.summary,
])

// ─── find_duplicate_keys ─────────────────────────────────────────

export const findDuplicateKeysResult = z.object({
  collisions: z.array(z.object({
    key: z.string().describe('The key both layers define.'),
    sharedLayer: z.string().describe('The layer that is fallen through to.'),
    childLayer: z.string().describe('The consuming layer, whose value wins at runtime.'),
    sharedValue: translationValue.describe('What the shared layer holds.'),
    childValue: translationValue.describe('What the child layer holds — this is what renders.'),
    divergent: z.boolean()
      .describe('True when the two values differ, which is the dangerous case: the shared value silently never shows. Fix by deleting one side, never by moving.'),
  })).describe('Keys defined in both a shared layer and a layer that consumes it.'),
  valueDuplicates: z.array(z.object({
    value: z.string().describe('The value as written, taken from the first member.'),
    normalized: z.string().describe('What the members were grouped by — trimmed, case-folded, punctuation-stripped.'),
    action: z.enum(['reuse', 'promote', 'consolidate'])
      .describe('What to do: "reuse" a shared layer already has it, "promote" move one to a shared layer, "consolidate" duplication inside one layer.'),
    members: z.array(z.object({
      key: z.string().describe('A key carrying this value.'),
      layer: z.string().describe('The layer it lives in.'),
      shared: z.boolean().describe('True when other layers fall through to this one, so the key is already reachable from them.'),
    })).describe('Every key carrying the value, ordered so the shared ones come first.'),
  })).optional().describe('Different keys carrying the same value. Present only when byValue was passed.'),
  guidance: z.string().describe('How to act on the findings, in one paragraph.'),
  summary: z.object({
    totalCollisions: z.number().int().describe('Keys defined in both a shared and a consuming layer.'),
    divergentCount: z.number().int().describe('Of those, the ones whose values differ.'),
    pairsChecked: z.number().int().describe('(shared layer, consuming layer) pairs the scan compared. 0 for a single-layer project.'),
    locale: z.string().describe('Locale the values were compared in.'),
    valueGroups: z.number().int().optional().describe('Groups of keys sharing a value. Present only when byValue was passed.'),
    reusableGroups: z.number().int().optional().describe('Of those, the ones a shared layer already covers. Present only when byValue was passed.'),
    message: z.string().optional().describe('One sentence stating what the scan found.'),
  }).describe('What the scan compared and what it found. This is what comes back when the full result is diverted to a file.'),
})

// ─── scaffold_locale ─────────────────────────────────────────────

const scaffoldLocaleFileInfo = z.object({
  locale: z.string().describe('Locale code the file is for.'),
  layer: z.string().describe('Layer the file belongs to.'),
  file: z.string().describe('Absolute path of the locale file.'),
  keys: z.number().int().describe('Keys copied from the default locale, all with an empty-string value.'),
  namespace: z.string().optional().describe('Namespace this file holds, for a namespaced layout such as Laravel. Absent for a flat layout.'),
})

export const scaffoldLocaleResult = z.object({
  created: z.array(scaffoldLocaleFileInfo).describe('Files that were created, or would be under dryRun.'),
  skipped: z.array(scaffoldLocaleFileInfo).describe('Files that already existed and were left alone.'),
  dryRun: z.boolean().describe('True when nothing was written because a preview was asked for.'),
})

// ─── Drift guard ─────────────────────────────────────────────────
//
// A schema that has stopped describing its operation's result is worse than no
// schema: the MCP server validates `structuredContent` against it, so a field
// the schema forgot fails the call, and a field it invented is documented to a
// model that will never see it. `core/types.ts` is the source of truth, so
// every schema is checked against its interface here — in both directions,
// which is what catches an invented field as well as a forgotten one.

/** True only when the two types are assignable to each other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * Assignability alone lets an optional field drift: `{ a: 1 }` and
 * `{ a: 1, b?: 2 }` are mutually assignable, so a schema that forgot an
 * optional field, or invented one, passed. Keys are therefore compared as
 * well, at every object level and through arrays. A union is left to the
 * assignability check — its members cannot be paired up structurally — so a
 * field that is one of several shapes is exactly as checked as before.
 */
type IsObject<T> = T extends object ? (T extends readonly unknown[] ? false : T extends (...args: never) => unknown ? false : true) : false

type IsUnion<T, U = T> = [T] extends [boolean] ? false : T extends unknown ? ([U] extends [T] ? false : true) : never

/** Depth budget: a self-referencing shape (a namespace node holds nodes) would otherwise never resolve. */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6]

type SameKeys<A, B, D extends number = 6> = [D] extends [never]
  ? true
  : true extends IsUnion<A> | IsUnion<B>
    ? true
    : [A] extends [readonly (infer EA)[]]
      ? [B] extends [readonly (infer EB)[]] ? SameKeys<EA, EB, Depth[D]> : false
      : [IsObject<A>] extends [true]
        ? [IsObject<B>] extends [true]
          ? [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
            ? { [K in keyof A]-?: SameKeys<NonNullable<A[K]>, NonNullable<K extends keyof B ? B[K] : never>, Depth[D]> }[keyof A] extends true
              ? true
              : false
            : false
          : false
        : true

/** Fails to compile unless the schema and the interface describe one shape. */
type Describes<S extends z.ZodType, T> = Mutual<z.infer<S>, T> extends true ? SameKeys<z.infer<S>, T> : false

type Expect<T extends true> = T

type _init = Expect<Describes<typeof initResult, InitProjectConfigResult>>
// Without the server's own three fields, which no operation returns.
type _discover = Expect<Mutual<
  Omit<z.infer<typeof discoverResult>, ServerAddedDiscoverFields>,
  DescribeProjectOutcome
>>
type _namespaces = Expect<Describes<typeof listNamespacesResult, ListNamespacesResult>>
type _namespaceNode = Expect<Describes<typeof namespaceNode, NamespaceNode>>
// The one operation with no named result interface, so the guard reads the
// return type of the function itself.
type _get = Expect<Describes<typeof getTranslationsResult, Awaited<ReturnType<typeof getTranslations>>>>
type _write = Expect<Describes<typeof writeTranslationsResult, WriteTranslationsResult>>
type _missing = Expect<Describes<typeof missingTranslationsResult, MissingTranslationsPage>>
type _status = Expect<Describes<typeof translationStatusResult, TranslationStatusResult>>
type _search = Expect<Describes<typeof searchTranslationsResult, SearchTranslationsPage>>
type _remove = Expect<Describes<typeof removeTranslationsResult, RemoveTranslationsResult>>
type _move = Expect<Describes<typeof moveTranslationKeyResult, MoveTranslationKeyResult>>
type _rename = Expect<Describes<typeof renameTranslationKeyResult, RenameTranslationKeyResult>>
type _translate = Expect<Describes<typeof translateMissingLayerResult, TranslateMissingResult>>
type _translateAll = Expect<Describes<typeof translateAllLayersResult, TranslateAllLayersResult>>
type _translateKey = Expect<Describes<typeof translateKeyResult, TranslateKeyResult>>
type _check = Expect<Describes<typeof checkUndefinedKeysResult, CheckUndefinedKeysResult>>
type _orphans = Expect<Describes<typeof findOrphanKeysResult, FindOrphanKeysResult>>
type _removeOrphans = Expect<Describes<typeof removeOrphanKeysResult, RemoveOrphanKeysResult>>
type _usages = Expect<Describes<typeof codeUsageResult, CodeUsageResult>>
type _duplicates = Expect<Describes<typeof findDuplicateKeysResult, FindDuplicateKeysResult>>
type _scaffold = Expect<Describes<typeof scaffoldLocaleResult, ScaffoldLocaleResult>>
