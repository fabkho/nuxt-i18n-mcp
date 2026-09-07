/**
 * Every operation the kit exposes, declared once.
 *
 * The CLI builds its fifteen commands from this table and the MCP server builds
 * its fifteen tools from it. Read `./types.ts` first for what a descriptor is
 * allowed to say; this file is the table itself.
 *
 * The core operations are imported per run rather than at module load. This
 * table is read by `--help`, by the tool registrar and by the reference
 * generator, none of which run anything, while the core barrel pulls in the
 * scanner, the parsers and the file writers — a quarter of a megabyte nobody
 * asking for usage text should pay for.
 */

import { BASE_URL_ENV } from '../llm/providers.js'
// The two mappings a report can carry. Imported outright rather than per run
// like the operations below: they are pure transforms over a result, with
// nothing behind them but a hash and a path join.
import {
  duplicateKeysToCodeQuality,
  missingTranslationsToCodeQuality,
  orphanResultToCodeQuality,
  statusToCodeQuality,
  undefinedKeysToCodeQuality,
} from '../core/codequality.js'
// The result types the report builders below are written against. Type-only,
// so the core barrel is still not loaded to print usage text.
import type { CheckUndefinedKeysResult } from '../core/ops-check.js'
import type { FindDuplicateKeysResult } from '../core/ops-duplicates.js'
import type {
  CodeUsageResult,
  FindOrphanKeysResult,
  MissingTranslationsResult,
  RemoveOrphanKeysResult,
  SearchTranslationsResult,
  TranslationStatusResult,
} from '../core/types.js'
// The result schemas. Imported outright, like the report mappings above: they
// are what the tool registrar advertises to a host, and the CLI already loads
// zod to read a project config.
import {
  checkUndefinedKeysResult,
  discoverResult,
  findDuplicateKeysResult,
  getTranslationsResult,
  initResult,
  listNamespacesResult,
  missingTranslationsResult,
  moveTranslationKeyOutcome,
  orphanCommandResult,
  orphanReportSummary,
  removeTranslationsResult,
  scaffoldLocaleResult,
  searchReportSummary,
  searchTranslationsResult,
  translateKeyResult,
  translateMissingOutcome,
  translationStatusResult,
  writeTranslationsResult,
} from './results.js'
import { defineOperation } from './types.js'
import type { AnyOperationDescriptor, ParamSpec, Params } from './types.js'
import {
  applyTranslateKeyGuidance,
  applyTranslateMissingGuidance,
} from './guidance.js'

const core = () => import('../core/operations.js')

/** What the orphans command answers with, whichever of its three questions was asked. */
type OrphanCommandResult = FindOrphanKeysResult | RemoveOrphanKeysResult | CodeUsageResult

// ─── Shared parameter fragments ──────────────────────────────────
// One concept, one description. These used to be fifteen hand-written
// variations that had drifted into saying different things.

const layerFilter = {
  type: 'string',
  description: 'Layer name to scope this to (e.g., "root", "app-admin"). If omitted, every layer is included. Call discover to list the layers.',
} as const satisfies ParamSpec

const layerRequired = {
  type: 'string',
  required: true,
  description: 'Layer name from discover (e.g., "root", "app-admin").',
} as const satisfies ParamSpec

const referenceLocale = {
  type: 'string',
  description: 'Locale code used as the source of truth (e.g., "en", "en-US"). Defaults to the project default locale.',
  // `--ref` was the CLI spelling before the two surfaces agreed on one name.
  cli: { alias: 'ref' },
} as const satisfies ParamSpec

const readLocale = {
  type: 'string',
  description: 'Locale code to read from (e.g., "en", "en-US"). Defaults to the project default locale. Keys are the same across locales, so one is enough.',
} as const satisfies ParamSpec

const dryRun = (description: string) => ({
  type: 'boolean',
  default: false,
  description,
} as const satisfies ParamSpec)

const scanDirs = {
  type: 'string[]',
  description: 'Absolute paths of the directories to scan for source usage. Overrides scope-aware scanning: every layer is then checked against these directories alone. Example: ["/home/user/my-app/apps/admin"].',
  // Manual scan roots were never a CLI flag: a terminal run gets the
  // scope-aware plan, which is the answer that accounts for layer consumption.
  cli: { hidden: true },
} as const satisfies ParamSpec

const excludeDirs = {
  type: 'string[]',
  description: 'Directory names to skip when scanning source files. Example: ["storybook", "__tests__", "node_modules"].',
  // Paired with scanDirs, and hidden on the CLI for the same reason.
  cli: { hidden: true },
} as const satisfies ParamSpec

/**
 * Provider selection, shared by the two translating operations.
 *
 * CLI only: the server resolves one backend at startup from I18N_PROVIDER,
 * I18N_MODEL and the provider's API key env, so a request cannot pick another
 * one — and an API key does not belong in a tool call an agent composes.
 */
const providerParams = {
  provider: {
    type: 'string',
    enum: ['openai', 'anthropic', 'google'],
    description: 'LLM provider to translate through. Without one nothing is translated automatically — the result carries the contexts to translate by hand instead.',
    mcp: { hidden: true },
  },
  model: {
    type: 'string',
    description: 'Model name. Required whenever a provider is set.',
    mcp: { hidden: true },
  },
  apiKey: {
    type: 'string',
    description: 'API key. Falls back to the OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY environment variables.',
    mcp: { hidden: true },
  },
  baseUrl: {
    type: 'string',
    description: `Provider base URL for gateways, self-hosted models and proxies speaking the provider's protocol. Falls back to ${BASE_URL_ENV}, then to providerBaseUrl in .i18n-mcp.json.`,
    mcp: { hidden: true },
  },
} as const satisfies Params

// ─── The table ───────────────────────────────────────────────────

/**
 * Registry order: it is the order `the-i18n-cli --help` lists commands in and
 * the order both generated reference overviews are written in.
 */
export const descriptors: readonly AnyOperationDescriptor[] = [

  defineOperation({
    id: 'init',
    cli: { name: 'init' },
    // Writing a config file is a setup step someone takes at a terminal, with
    // the framework detection in front of them. An agent that wants one calls
    // discover and writes the file itself.
    mcp: null,
    description: 'Create a schema-valid .i18n-mcp.json from framework detection. Non-interactive; refuses to overwrite without force.',
    params: {
      force: {
        type: 'boolean',
        default: false,
        description: 'Overwrite an existing .i18n-mcp.json.',
      },
      dryRun: dryRun('Report the config that would be written without touching disk. Default: false.'),
    },
    result: initResult,
    async run(args) {
      const { initProjectConfig } = await core()
      return initProjectConfig({
        projectDir: args.projectDir,
        force: args.force,
        dryRun: args.dryRun,
      })
    },
  }),

  defineOperation({
    id: 'discover',
    cli: { name: 'discover' },
    mcp: {
      name: 'discover',
      title: 'Discover i18n Setup',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Describe the project: detected config, locale directories per layer with file counts and top-level namespaces, the layer graph, and the hand-maintained locales.',
    longDescription: 'Call this first to understand the project before reading or writing translations. The result also names the active translation mode ("provider" when the server has an env-configured LLM provider, "agent" otherwise). layerGraph answers where a new key belongs: a key used by more than one app belongs in a layer those apps share, and layerGraph.shared names those layers.',
    params: {},
    result: discoverResult,
    async run(args) {
      const { describeProject } = await core()
      return describeProject({ projectDir: args.projectDir })
    },
  }),

  defineOperation({
    id: 'list-namespaces',
    // No command: the same question is answered at a terminal by `discover`,
    // which lists the top-level namespaces per layer. Stated here rather than
    // left as an absence nobody could see.
    cli: null,
    mcp: {
      name: 'list_namespaces',
      title: 'List Namespaces',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'List the translation key tree grouped by namespace prefix, with a count per namespace node.',
    longDescription: 'Use this to explore the available keys without guessing path prefixes.',
    params: {
      layer: {
        ...layerFilter,
        description: 'Layer name to filter by (e.g., "root", "app-admin"). If omitted or "*", scans all layers. Call discover to list the layers.',
      },
      locale: readLocale,
    },
    result: listNamespacesResult,
    async run(args) {
      const { listNamespaces } = await core()
      return listNamespaces({ layer: args.layer, locale: args.locale, projectDir: args.projectDir })
    },
  }),

  defineOperation({
    id: 'get',
    cli: { name: 'get' },
    mcp: {
      name: 'get_translations',
      title: 'Get Translations',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Get translation values for given key paths from a specific locale and layer. Use "*" as the locale to read from all locales.',
    params: {
      layer: layerRequired,
      locale: {
        type: 'string',
        required: true,
        description: 'Locale code, locale file name, or "*" to read all locales. Examples: "en", "en-US", "en-US.json", "*".',
      },
      keys: {
        type: 'string[]',
        required: true,
        description: 'Dot-separated key paths to read. Example: ["common.actions.save", "auth.login.title"].',
      },
      compact: {
        type: 'boolean',
        description: 'When true and locale is "*", returns a summary grouped by key instead of per-locale detail. Default: false.',
        // Never exposed as a flag: the CLI answer is already a stream a caller
        // pipes into jq, which is where they would trim it.
        cli: { hidden: true },
      },
    },
    result: getTranslationsResult,
    async run(args) {
      const { getTranslations } = await core()
      return getTranslations({
        layer: args.layer,
        locale: args.locale,
        keys: args.keys,
        compact: args.compact,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'write',
    cli: { name: 'write' },
    mcp: {
      name: 'write_translations',
      title: 'Write Translations',
      // Destructive because the default mode is upsert: an existing value is
      // replaced without a trace of what it was.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    description: 'Write translation key-value pairs to a layer. Keys are inserted in alphabetical order.',
    longDescription: 'Mode "upsert" adds new keys and updates existing ones (default, most common). Mode "add" only creates new keys, skipping existing ones. Mode "update" only modifies existing keys, skipping missing ones. Use dryRun to preview without writing.',
    params: {
      layer: layerRequired,
      translations: {
        type: 'record',
        required: true,
        description: 'Map of dot-path keys to locale-value pairs. IMPORTANT: values must be locale maps, NOT plain strings. Locale refs may be a code ("en-us"), a language ("en-US") or a file ("en-US.json"). Wrong: { "auth.failed": "Login failed" }. Correct: { "auth.failed": { "en-US": "Login failed", "de-DE": "Anmeldung fehlgeschlagen" } }',
      },
      mode: {
        type: 'string',
        enum: ['add', 'update', 'upsert'],
        default: 'upsert',
        description: 'Write mode. "upsert": add-or-update (never fails). "add": only new keys. "update": only existing keys. Default: "upsert".',
      },
      dryRun: dryRun('Return a preview of what would be written without writing any files. Default: false.'),
    },
    result: writeTranslationsResult,
    async run(args) {
      const { writeTranslations } = await core()
      return writeTranslations({
        layer: args.layer,
        translations: args.translations,
        mode: args.mode,
        dryRun: args.dryRun,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'missing',
    cli: { name: 'missing' },
    mcp: {
      name: 'get_missing_translations',
      title: 'Get Missing Translations',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Find translation keys that exist in the reference locale but are missing in other locales. Scans a specific layer or all layers.',
    params: {
      layer: layerFilter,
      referenceLocale,
      targetLocales: {
        type: 'string[]',
        description: 'Locale codes to check for missing keys (e.g., ["de", "fr", "es"]). Defaults to all locales except the reference.',
        // `--targets` was the CLI spelling before the two surfaces agreed.
        cli: { alias: 'targets' },
      },
      failOnMissing: {
        type: 'boolean',
        default: false,
        description: 'Exit 2 when any key is missing (CI gate).',
        // Exit codes exist at a terminal. A host reads the summary instead.
        mcp: { hidden: true },
      },
    },
    result: missingTranslationsResult,
    gates: [{ flag: 'failOnMissing', counter: 'totalMissingKeys', threshold: 0 }],
    report: {
      name: 'get_missing_translations',
      outputFile: { example: '.i18n-reports/missing-translations.json' },
      summary: (result: MissingTranslationsResult) => result.summary,
      summarySchema: missingTranslationsResult.shape.summary,
      codequality: {
        findings: 'missing translations',
        issues: (result: MissingTranslationsResult, ctx) => missingTranslationsToCodeQuality(result, {
          config: ctx.config,
          projectDir: ctx.projectDir,
        }),
      },
    },
    async run(args) {
      const { getMissingTranslations } = await core()
      return getMissingTranslations({
        layer: args.layer,
        referenceLocale: args.referenceLocale,
        targetLocales: args.targetLocales,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'status',
    cli: { name: 'status' },
    mcp: {
      name: 'get_translation_status',
      title: 'Get Translation Status',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Translation coverage in one call: per-locale and per-layer counts of total, translated, missing and empty keys, plus an overall completion percentage.',
    longDescription: 'Use this instead of calling get_missing_translations per layer and counting keys yourself. Empty-string values count as untranslated; set listEmpty to get the keys behind that count — they exist in the locale file, so they are never reported as missing, and they render as nothing in the UI. Locales listed in protectedLocales are reported but excluded from the overall figure, since they are maintained by hand.',
    params: {
      layer: layerFilter,
      referenceLocale,
      listEmpty: {
        type: 'boolean',
        default: false,
        description: 'Also list the keys behind summary.emptyKeys under "empty" (locale → layer → keys), and keys that are empty in the reference locale itself under "emptyInReference" — useful after a scaffold or an interrupted translation run. Default: false, which returns counts only.',
      },
      failUnder: {
        type: 'number',
        description: 'Exit 2 when overall completion is below this percentage (CI gate).',
        mcp: { hidden: true },
      },
    },
    result: translationStatusResult,
    // The threshold comes from the flag's own value; `direction: below` is what
    // makes this a floor rather than a ceiling (see resolveExitCode).
    gates: [{ flag: 'failUnder', counter: 'completionPercent', direction: 'below' }],
    report: {
      name: 'get_translation_status',
      outputFile: { example: '.i18n-reports/translation-status.json' },
      // Summary only: the per-locale and per-layer arrays grow with the
      // project, and a health check must never flood a caller's context.
      summary: (result: TranslationStatusResult) => result.summary,
      summarySchema: translationStatusResult.shape.summary,
      codequality: {
        findings: 'incomplete locales and unconsumed layers',
        // The gate's threshold is the report's threshold: a pipeline that asks
        // to fail under 90% should not see a finding for every locale at 97%.
        issues: (result: TranslationStatusResult, ctx) => statusToCodeQuality(result, {
          config: ctx.config,
          projectDir: ctx.projectDir,
          failUnder: ctx.args.failUnder,
        }),
      },
    },
    async run(args) {
      const { getTranslationStatus } = await core()
      return getTranslationStatus({
        layer: args.layer,
        referenceLocale: args.referenceLocale,
        listEmpty: args.listEmpty,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'search',
    cli: { name: 'search' },
    mcp: {
      name: 'search_translations',
      title: 'Search Translations',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Search translation files by key path or value, one compact row per matching key rather than one per key and locale.',
    longDescription: 'Useful for finding an existing translation before adding a duplicate of it. A key that seven layers and thirty locales define comes back as a single row: layers names every layer that defines it, which is what tells reuse from duplication, and value is the one the reference locale holds. Pass includeLocales for the detail rows — one per key and locale — when what each locale holds is the question. Matching is a case-insensitive substring unless matchMode says otherwise.',
    params: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to search for, matched against keys and/or values. Compared as a case-insensitive substring unless matchMode says otherwise. Example: "save" matches the key "common.actions.save" and the value "Save changes".',
      },
      searchIn: {
        type: 'string',
        enum: ['keys', 'values', 'both'],
        default: 'both',
        description: 'Whether to search translation keys, values, or both. Default: "both".',
        // `--in` was the CLI spelling before the two surfaces agreed.
        cli: { alias: 'in' },
      },
      matchMode: {
        type: 'string',
        enum: ['contains', 'exact', 'fuzzy'],
        default: 'contains',
        description: 'How query is compared. "contains" is a case-insensitive substring, over every locale searched. "exact" is the whole string, and "fuzzy" also accepts near-misses in wording, both ignoring case, accents, punctuation and whitespace and both comparing against one locale only — locale when given, otherwise the project default. Default: "contains".',
      },
      layer: {
        ...layerFilter,
        description: 'Layer name to search in (e.g., "root", "app-admin"), or "*" for all layers. If omitted, searches every layer.',
      },
      locale: {
        type: 'string',
        description: 'Locale code to search in (e.g., "en", "de"). If omitted, searches every locale.',
      },
      includeLocales: {
        type: 'boolean',
        default: false,
        description: 'Return one row per key and locale — layer, locale, key, value — instead of one row per key. Several times the output for the same findings, so ask for it when the per-locale values are what you are after. Default: false.',
      },
    },
    result: searchTranslationsResult,
    report: {
      name: 'search_translations',
      outputFile: {
        example: '.i18n-reports/search-results.json',
        // The only read operation the CLI never gave a report path to. Left as
        // it was rather than quietly growing the command's surface.
        cli: { hidden: true },
      },
      // The one operation whose result carries no summary of its own: the match
      // count is what is left of it once the matches are on disk.
      summary: (result: SearchTranslationsResult) => ({ totalMatches: result.totalMatches }),
      summarySchema: searchReportSummary,
    },
    async run(args) {
      const { searchTranslations } = await core()
      return searchTranslations({
        query: args.query,
        searchIn: args.searchIn,
        matchMode: args.matchMode,
        includeLocales: args.includeLocales,
        layer: args.layer,
        locale: args.locale,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'remove',
    cli: { name: 'remove' },
    mcp: {
      name: 'remove_translations',
      title: 'Remove Translations',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    description: 'Remove one or more translation keys from ALL locale files in the given layer.',
    longDescription: 'Use dryRun to preview the changes before applying them.',
    params: {
      layer: {
        ...layerRequired,
        description: 'Layer name from discover (e.g., "root", "app-admin"). The keys are removed from ALL locale files in this layer.',
      },
      keys: {
        type: 'string[]',
        required: true,
        description: 'Dot-separated key paths to remove from every locale file in the layer. Example: ["common.actions.delete", "auth.errors.expired"].',
      },
      dryRun: dryRun('Return a preview of what would be removed without writing any files. Default: false.'),
    },
    result: removeTranslationsResult,
    async run(args) {
      const { removeTranslations } = await core()
      return removeTranslations({
        layer: args.layer,
        keys: args.keys,
        dryRun: args.dryRun,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'move',
    cli: { name: 'move' },
    mcp: {
      name: 'move_translation_key',
      title: 'Move or Rename a Translation Key',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    description: 'Move a translation key to another layer, to another key path, or both, carrying every locale that defines it.',
    longDescription: 'Pass toLayer to promote an app-layer key to a shared layer once a second app needs it (or to demote a shared key that turned out to be app-specific); call discover first, layerGraph.shared names the layers more than one app consumes. Pass newKey alone to rename the key in place across every locale file of its layer. Writes nothing at all if the destination already holds the key with a different value in any locale; if it holds the same value, that locale is deduplicated instead. Use dryRun to preview the plan.',
    params: {
      layer: {
        ...layerRequired,
        description: 'Layer the key lives in today, from discover. Example: "app-admin".',
      },
      key: {
        type: 'string',
        required: true,
        description: 'Dot-separated key path to move. Example: "calendar.views.save".',
      },
      // Neither destination is required on its own: which one is passed is what
      // the caller meant to do, and passing neither is the error.
      toLayer: {
        type: 'string',
        description: 'Layer to move it to, from discover. Example: "root". Omit (or repeat layer) to rename the key within its current layer, which then requires newKey.',
      },
      newKey: {
        type: 'string',
        description: 'Key path to give it. Example: "common.actions.save". Omit to keep the current path, which then requires toLayer.',
      },
      dryRun: dryRun('Return the plan without writing any files. Default: false.'),
    },
    result: moveTranslationKeyOutcome,
    async run(args) {
      const { moveTranslationKey } = await core()
      return moveTranslationKey({
        layer: args.layer,
        key: args.key,
        toLayer: args.toLayer,
        newKey: args.newKey,
        dryRun: args.dryRun,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'translate',
    cli: { name: 'translate' },
    mcp: {
      name: 'translate_missing',
      title: 'Translate Missing',
      annotations: { title: 'Translate Missing Translations', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    description: 'Find the keys missing in the target locales and translate them. Without a translation backend nothing is written: the result carries per-locale fallback contexts to translate by hand instead.',
    longDescription: 'Two modes: in provider mode (the server env-configured with I18N_PROVIDER, I18N_MODEL and an API key) it calls the LLM provider directly and writes the results; in agent mode it returns those fallbackContexts — translate them inline and persist via write_translations. Check the discover output for the active mode. Uses the project config (glossary, translation prompt, locale notes, examples) where there is one. Translates all locales concurrently, so pass every target locale at once.',
    params: {
      layer: {
        ...layerFilter,
        description: 'Layer to translate (e.g., "root", "app-admin"). Omit to translate every locale-backed layer in one call — the recommended default for layered projects, which returns a result per layer plus an aggregated summary.',
      },
      referenceLocale: {
        ...referenceLocale,
        description: 'Locale code used as the translation source (e.g., "en", "en-US"). Defaults to the project default locale.',
      },
      targetLocales: {
        type: 'string[]',
        description: 'Locale codes to translate into (e.g., ["de", "fr", "sv"]). Defaults to all locales except the reference.',
        cli: { alias: 'targets' },
      },
      keys: {
        type: 'string[]',
        description: 'Dot-path keys to translate (e.g., ["auth.login.title", "common.save"]). If omitted, translates every missing key in the layer.',
      },
      batchSize: {
        type: 'number',
        integer: true,
        min: 1,
        description: 'Maximum number of keys per provider request. Default: 50. A lower value reduces per-batch risk and increases round trips.',
      },
      overwriteStale: {
        type: 'boolean',
        default: false,
        description: 'Also re-translate keys whose target value was written from source text that has changed since. Requires translationMemory in the project config — without it nothing is known to be stale and this changes nothing. Default: false, which reports those keys under "stale" and leaves their values alone.',
      },
      dryRun: dryRun('Return which keys would be translated without calling the provider or writing files. Default: false.'),
      compact: {
        type: 'boolean',
        description: 'Return a compact summary (totalTranslated, totalFailed, byLocale) instead of full per-locale results. Default: false.',
        // The CLI answer is a stream a caller pipes into jq, which is where a
        // terminal user trims it.
        cli: { hidden: true },
      },
      ...providerParams,
      failOnFailed: {
        type: 'boolean',
        default: false,
        description: 'Exit 2 when any key failed to translate (CI gate).',
        mcp: { hidden: true },
      },
    },
    result: translateMissingOutcome,
    // Without this gate a partly failed run is indistinguishable from a clean
    // one: isTotalFailure only reports exit 1 when NOTHING was translated, so a
    // run that wrote 795 keys and lost 141 exits 0 and its partial result gets
    // committed. Opt-in rather than default, because providers fail transiently
    // and a red pipeline on every flake is a red pipeline nobody reads.
    gates: [{ flag: 'failOnFailed', counter: 'totalFailed', threshold: 0 }],
    usesTranslateFn: true,
    async run(args, ctx) {
      const { translateMissing } = await core()
      const result = await translateMissing({
        layer: args.layer,
        referenceLocale: args.referenceLocale,
        targetLocales: args.targetLocales,
        keys: args.keys,
        batchSize: args.batchSize,
        overwriteStale: args.overwriteStale,
        dryRun: args.dryRun,
        compact: args.compact,
        projectDir: args.projectDir,
        translateFn: ctx.translateFn,
        progressFn: ctx.progressFn,
        onProgressTotal: ctx.onProgressTotal,
      })
      applyTranslateMissingGuidance(result, ctx.surface)
      return result
    },
  }),

  defineOperation({
    id: 'translate-key',
    cli: { name: 'translate-key' },
    mcp: {
      name: 'translate_key',
      title: 'Translate Key',
      annotations: { title: 'Translate Single Key', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    description: 'Add or update one source translation key and translate it into the target locales.',
    longDescription: 'Unlike translate_missing, this can overwrite an existing but stale target translation. Same two modes as translate_missing: provider mode (the server env-configured) translates directly; agent mode returns a fallbackContext — translate it inline and persist via write_translations.',
    params: {
      layer: {
        ...layerRequired,
        description: 'Layer holding the key, from discover (e.g., "root", "app-admin").',
      },
      key: {
        type: 'string',
        required: true,
        description: 'Dot-separated key path to translate. Example: "bookingCreator.options.removeSubResource".',
      },
      sourceLocale: {
        type: 'string',
        required: true,
        description: 'Source locale ref. May be a code ("en-us"), a language ("en-US") or a file ("en-US.json").',
      },
      sourceValue: {
        type: 'string',
        description: 'Source value to write before translating. If omitted, the existing source value is read.',
      },
      targetLocales: {
        type: 'string[]',
        allowAll: true,
        description: 'Locales to translate into. Pass "all", or omit, for every locale except the source.',
        cli: { alias: 'targets' },
      },
      overwrite: {
        type: 'boolean',
        default: true,
        description: 'Overwrite existing target translations. When false, only missing targets are filled. Default: true.',
      },
      dryRun: dryRun('Report the source and target locales without writing files or calling the translation backend. Default: false.'),
      includePreview: {
        type: 'boolean',
        default: false,
        description: 'Include the translated values in the result. Default: false, which keeps the response compact.',
      },
      ...providerParams,
    },
    result: translateKeyResult,
    usesTranslateFn: true,
    async run(args, ctx) {
      const { translateKey } = await core()
      const result = await translateKey({
        layer: args.layer,
        key: args.key,
        sourceLocale: args.sourceLocale,
        sourceValue: args.sourceValue,
        targetLocales: args.targetLocales,
        overwrite: args.overwrite,
        dryRun: args.dryRun,
        includePreview: args.includePreview,
        projectDir: args.projectDir,
        translateFn: ctx.translateFn,
      })
      applyTranslateKeyGuidance(result, ctx.surface)
      return result
    },
  }),

  defineOperation({
    id: 'check',
    cli: { name: 'check' },
    mcp: {
      name: 'find_undefined_keys',
      title: 'Find Used-But-Undefined Translation Keys',
      // Hints are static and `write` is a parameter: declared for the run
      // that writes, since a host that auto-approves the read-only shape
      // would also auto-approve the one that seeds locale files.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    description: 'Find keys referenced in source code but defined in NO locale layer the using app consumes — the direction that ships raw keys to production.',
    longDescription: 'The inverse of find_orphan_keys. Scope-aware: each scan unit (app) is checked against the layers it consumes (summary.searchedLayersByApp), so a key defined only in a layer the using app does not consume is still undefined for that app. Known limitation: extraction is line-based and static — dynamically built keys (template literals, concatenation) cannot be verified and are reported as uncertainKeys, never as hard findings. With write, the hard findings are also added to a locale file as empty translations, which is the first half of the fix; uncertain findings are never written.',
    params: {
      locale: {
        ...readLocale,
        description: 'Reference locale to resolve key definitions in (e.g., "en", "en-US"). Defaults to the project default locale.',
      },
      write: {
        type: 'boolean',
        default: false,
        description: 'Add every undefined key to a locale file, with an empty string as its value, in the project default locale only. Existing values are never touched, and uncertain findings are never written. The layer is the one the using code resolves against; when that is more than one layer, the run refuses and asks for a layer name. Default: false, which only reports.',
      },
      layer: {
        type: 'string',
        description: 'Layer to write the undefined keys into (e.g., "root", "app-admin"). Only read together with write, and only needed when the using code resolves against more than one layer. Call discover to list the layers.',
      },
      scanDirs,
      excludeDirs,
    },
    result: checkUndefinedKeysResult,
    /**
     * Always on, and a gate rather than a run failure. A key that renders raw in
     * production is a defect, so there is no flag to opt into caring about it —
     * but it is still a finding, and reporting it as exit 1 left the caller
     * unable to tell an undefined key from a scan that fell over.
     *
     * Reads summary.undefinedCount, which the result carries whether or not it
     * was diverted to a file. Uncertain findings never trip it.
     *
     * A `write` run counts what it wrote out of that number: a key with a
     * definition, even an empty one, no longer renders raw, so extracting every
     * finding exits 0 and anything left over — a key the layer already defined,
     * skipped by the add-only write — still exits 2.
     */
    gates: [{ name: 'undefined-keys', counter: 'undefinedCount', threshold: 0 }],
    report: {
      name: 'find_undefined_keys',
      outputFile: { example: '.i18n-reports/undefined-keys.json' },
      summary: (result: CheckUndefinedKeysResult) => result.summary,
      summarySchema: checkUndefinedKeysResult.shape.summary,
      codequality: {
        findings: 'findings',
        // Uncertain findings are deliberately not mapped; see codequality.ts.
        issues: (result: CheckUndefinedKeysResult) => undefinedKeysToCodeQuality(result.undefinedKeys),
      },
    },
    async run(args) {
      const { checkUndefinedKeys } = await core()
      return checkUndefinedKeys({
        locale: args.locale,
        write: args.write,
        layer: args.layer,
        scanDirs: args.scanDirs,
        excludeDirs: args.excludeDirs,
        projectDir: args.projectDir,
      })
    },
  }),

  defineOperation({
    id: 'orphans',
    cli: { name: 'orphans' },
    mcp: {
      name: 'find_orphan_keys',
      title: 'Find Orphan Translation Keys',
      // Declared for the `remove: true` run — the one a host must confirm.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    /**
     * Three questions about one subject, so one operation: which keys nothing
     * references, where the references that do exist are, and delete the first
     * set. Deleting is the only destructive spelling and it has to be asked for.
     */
    description: 'Report translation keys that no source code references. Nothing is deleted unless remove is set.',
    longDescription: 'Scans a specific layer or all layers, and also detects dynamic key patterns and uncertain matches. Scope-aware: each layer is checked only against the code of the apps that consume it (summary.scanScope shows each layer\'s effective scope), and keys referenced only from non-consuming apps are reported separately as misplacedUsages rather than as orphans. With remove the orphan keys are deleted from every locale file of their layer — uncertain keys and misplaced usages are never deleted, in any mode.',
    params: {
      layer: layerFilter,
      locale: {
        ...readLocale,
        description: 'Locale code to read the translation keys from (e.g., "en", "en-US"). Defaults to the project default locale.',
      },
      remove: {
        type: 'boolean',
        default: false,
        description: 'Permanently delete the orphan keys from every locale file of their layer. Default: false, which only reports them — run without it first and read the findings. Uncertain keys and misplaced usages are never deleted.',
      },
      usages: {
        type: 'boolean',
        default: false,
        description: 'Report where keys are referenced in source (file paths and line numbers) instead of which keys are unreferenced.',
        // The inverted question, which the tool surface answers through the
        // orphan report itself; adding it to a tool would give one tool two
        // result shapes an agent has to tell apart.
        mcp: { hidden: true },
      },
      keys: {
        type: 'string[]',
        description: 'Keys to report usages for. Only read together with usages; without it, every key is considered.',
        mcp: { hidden: true },
      },
      scanDirs,
      excludeDirs,
      failOnOrphans: {
        type: 'boolean',
        default: false,
        description: 'Exit 2 when any orphan key is found (CI gate).',
        mcp: { hidden: true },
      },
    },
    result: orphanCommandResult,
    gates: [{ flag: 'failOnOrphans', counter: 'orphanCount', threshold: 0 }],
    report: {
      // Three questions, three report names — the paths pipelines archive.
      name: args => (args.usages === true
        ? 'scan_code_usage'
        : args.remove === true ? 'remove_orphan_keys' : 'find_orphan_keys'),
      outputFile: { example: '.i18n-reports/orphan-keys.json' },
      summary: (result: OrphanCommandResult) => result.summary,
      summarySchema: orphanReportSummary,
      codequality: {
        findings: 'orphan findings',
        // A result carrying usages answers where keys are referenced, which is
        // not a finding — nothing to write, not even the empty baseline.
        issues: (result: OrphanCommandResult, ctx) => ('usages' in result
          ? undefined
          : orphanResultToCodeQuality(result, {
              config: ctx.config,
              projectDir: ctx.projectDir,
              locale: ctx.args.locale,
            })),
      },
    },
    async run(args, ctx) {
      const { findOrphanKeys, removeOrphanKeys, scanCodeUsage } = await core()

      if (args.usages) {
        if (args.remove) {
          throw new Error('--usages reports where keys are used and never writes. Drop --remove, or drop --usages to delete orphans.')
        }
        // No progress here: the usage question walks the layer root dirs
        // directly rather than the scope-aware plan, so it is a different scan
        // with a different file count.
        return scanCodeUsage({
          keys: args.keys,
          scanDirs: args.scanDirs,
          excludeDirs: args.excludeDirs,
          projectDir: args.projectDir,
        })
      }

      // Two functions behind one operation: the report is richer than the
      // removal report (candidate-only keys, unresolved dynamic references),
      // and deleting is not something a caller should reach by omitting a flag.
      if (args.remove) {
        return removeOrphanKeys({
          layer: args.layer,
          locale: args.locale,
          scanDirs: args.scanDirs,
          excludeDirs: args.excludeDirs,
          dryRun: false,
          projectDir: args.projectDir,
          progressFn: ctx.progressFn,
          onProgressTotal: ctx.onProgressTotal,
        })
      }

      return findOrphanKeys({
        layer: args.layer,
        locale: args.locale,
        scanDirs: args.scanDirs,
        excludeDirs: args.excludeDirs,
        projectDir: args.projectDir,
        progressFn: ctx.progressFn,
        onProgressTotal: ctx.onProgressTotal,
      })
    },
  }),

  defineOperation({
    id: 'find-duplicates',
    cli: { name: 'find-duplicates' },
    mcp: {
      name: 'find_duplicate_keys',
      title: 'Find Duplicate Translation Keys Across Layers',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    description: 'Find translation keys defined in BOTH a shared layer and an app layer that consumes it.',
    longDescription: 'For example the same key in a monorepo root layer and in app-shop. At runtime the app layer\'s value shadows the shared one, so a collision with divergent values is the dangerous case: the shared value silently never shows. Compares one reference locale and reports each collision with both values and a divergent flag. Fix by deleting one side, never by moving.',
    params: {
      locale: {
        ...readLocale,
        description: 'Locale code to compare values in (e.g., "de", "en-US"). Defaults to the project default locale.',
      },
      byValue: {
        type: 'boolean',
        default: false,
        description: 'Also group different keys carrying the same value — e.g. common.actions.save and calendar.views.save both "Speichern". Each group says what to do about it: "reuse" (a shared layer already has it — delete the app copies and repoint the call sites), "promote" (move one to a shared layer) or "consolidate" (duplication inside one layer). Default: false.',
      },
      minValueLength: {
        type: 'number',
        integer: true,
        min: 1,
        description: 'Shortest value worth grouping when byValue is set. Default: 4 — below that, values like "OK" repeat across unrelated namespaces legitimately.',
      },
    },
    result: findDuplicateKeysResult,
    report: {
      name: 'find_duplicate_keys',
      outputFile: { example: '.i18n-reports/duplicate-keys.json' },
      summary: (result: FindDuplicateKeysResult) => result.summary,
      summarySchema: findDuplicateKeysResult.shape.summary,
      codequality: {
        findings: 'duplicate keys',
        issues: (result: FindDuplicateKeysResult, ctx) => duplicateKeysToCodeQuality(result, {
          config: ctx.config,
          projectDir: ctx.projectDir,
          locale: ctx.args.locale,
        }),
      },
    },
    async run(args) {
      const { findDuplicateKeys } = await core()
      return findDuplicateKeys({
        locale: args.locale,
        projectDir: args.projectDir,
        byValue: args.byValue,
        minValueLength: args.minValueLength,
      })
    },
  }),

  defineOperation({
    id: 'scaffold',
    cli: { name: 'scaffold' },
    mcp: {
      name: 'scaffold_locale',
      title: 'Scaffold Locale',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    description: 'Create empty locale files for new languages, copying the key structure of the default locale with every value set to an empty string.',
    longDescription: 'Supports both JSON (Nuxt) and PHP (Laravel) formats. Does NOT modify the framework configuration — add the locale there first, then call this.',
    params: {
      locales: {
        type: 'string[]',
        description: 'Locale codes to scaffold empty files for (e.g., ["sv", "ja", "pt-BR"]). If omitted, auto-detects the locales the config declares but has no files for.',
      },
      layer: {
        ...layerFilter,
        description: 'Layer to scaffold in (e.g., "root", "app-admin"). If omitted, scaffolds across every layer.',
      },
      dryRun: dryRun('Report the files that would be created without writing them. Default: false.'),
    },
    result: scaffoldLocaleResult,
    async run(args) {
      const { scaffoldLocaleFiles } = await core()
      return scaffoldLocaleFiles({
        locales: args.locales,
        layer: args.layer,
        dryRun: args.dryRun,
        projectDir: args.projectDir,
      })
    },
  }),
]

/** The descriptors a surface exposes, in registry order. */
export function descriptorsFor(surface: 'cli' | 'mcp'): AnyOperationDescriptor[] {
  return descriptors.filter(descriptor => descriptor[surface] !== null)
}

/** The parameter names a surface exposes for one operation, in declaration order. */
export function visibleParams(
  descriptor: AnyOperationDescriptor,
  surface: 'cli' | 'mcp',
): string[] {
  return Object.entries(descriptor.params)
    .filter(([, spec]) => spec[surface]?.hidden !== true)
    .map(([name]) => name)
}
