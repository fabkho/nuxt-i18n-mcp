/**
 * The translate operations themselves: translate_missing (single layer and
 * all layers) and translate_key. Target resolution, prompts, response parsing
 * and the request loop live in the sibling modules.
 */

import { detectI18nConfig } from '../../config/detector.js'
import { buildLayerGraph } from '../../config/layer-graph.js'
import type { I18nConfig, LocaleDefinition } from '../../config/types.js'
import { readLocaleData, mutateLocaleData } from '../../io/locale-data.js'
import {
  getNestedValue,
  setNestedValue,
  getLeafKeys,
} from '../../io/key-operations.js'
import { log } from '../../utils/logger.js'
import { ToolError, toErrorMessage } from '../../utils/errors.js'

import type {
  TranslateFn,
  TranslateLayerTotals,
  TranslateMode,
  TranslateFailReason,
  TranslateKeyLocaleIssue,
  TranslateKeySkip,
  TranslateMissingLocaleResult,
  TranslateMissingOptions,
  PlaceholderValidationResult,
  TranslateKeyResult,
  TranslateMissingResult,
  TranslateMissingOutcome,
  TranslateAllLayersResult,
  TranslateAllLayersSummary,
} from '../types.js'
import { findWritableLayerOrThrow, findReferenceLocaleOrThrow, findLocaleOrThrow, localeRefInfo } from '../shared.js'
import { resolveTranslateTargets, collectProtectedLocaleResults, partitionTranslateKeyTargets } from './targets.js'
import { validatePlaceholders, mergePlaceholderValidation, failReasonForIssue } from './placeholders.js'
import { buildTranslationSystemPrompt, buildTranslationUserMessage, buildFallbackContext, warnUnmatchedLocaleNotes } from './prompts.js'
import { extractJsonFromResponse } from './json-salvage.js'
import { openTranslationMemory } from './memory.js'
import { requestWithRetry } from './retry.js'
import type { TranslateRunState } from './retry.js'
import { planBatches, expansionFor, TRANSLATE_MAX_TOKENS, TRANSLATE_BUDGET_CHARS } from './batching.js'
import type { KeyEntry } from './batching.js'

/**
 * How often a batch that came back truncated may be halved before its keys are
 * given up as `truncated`. Bounds the request count of one planned batch at
 * 2^4 leaf requests, and its size at 50 → 25 → 12 → 6 → 3 keys for the default
 * batchSize: below that, a response that still does not fit is not a batching
 * problem.
 */
const MAX_SPLIT_DEPTH = 4

/**
 * Total progress steps for translate_missing: per locale with missing keys,
 * one step per batchSize keys translated plus a start and a complete step
 * (the +2). Steps count keys rather than requests because reactive splitting
 * makes the request count of a locale unknowable before the run.
 */
export function computeProgressTotal(missingKeyCounts: number[], maxBatch: number): number {
  return missingKeyCounts.reduce((sum, count) => {
    if (count <= 0) return sum
    return sum + Math.ceil(count / maxBatch) + 2
  }, 0)
}

/**
 * Find keys missing in target locales and translate them.
 *
 * When translateFn is provided, uses it to translate via LLM.
 * When translateFn is absent, returns fallback contexts for the agent.
 *
 * When `layer` is omitted, every canonical locale-backed layer is translated
 * in one run and the results are aggregated (see translateMissingAllLayers).
 */
export async function translateMissing(opts: TranslateMissingOptions): Promise<TranslateMissingOutcome> {
  if (opts.layer === undefined) return translateMissingAllLayers(opts)
  const layer = opts.layer
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false
  const maxBatch = opts.batchSize ?? 50
  if (!Number.isFinite(maxBatch) || maxBatch <= 0 || !Number.isInteger(maxBatch)) {
    throw new ToolError(`Invalid batchSize: ${opts.batchSize}. Must be a positive integer.`, 'INVALID_BATCH_SIZE')
  }

  findWritableLayerOrThrow(config, layer)
  warnUnmatchedLocaleNotes(config)

  const refCode = opts.referenceLocale ?? config.defaultLocale
  const refLocale = findReferenceLocaleOrThrow(config, opts.referenceLocale)

  const refData = await readLocaleData(config, layer, refLocale)
  if (Object.keys(refData).length === 0) {
    throw new ToolError(`No locale data found for reference locale "${refCode}" in layer "${layer}". Verify the layer exists and contains data for this locale using list_locale_dirs.`, 'NO_LOCALE_FILE')
  }
  const allRefKeys = getLeafKeys(refData).filter(k => {
    const v = getNestedValue(refData, k)
    return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
  })

  const resolvedTargetLocales = opts.targetLocales ?? opts.locales
  const { targets, protectedDefaults } = resolveTranslateTargets(config, refLocale, resolvedTargetLocales)

  const mode: TranslateMode = isDryRun ? 'dry-run' : opts.translateFn ? 'provider' : 'agent'
  const reportProgress = opts.progressFn ?? (async () => {})

  // Null unless the project opted into the lockfile; every use below is
  // guarded, so the operation behaves exactly as before when it is off.
  const memory = await openTranslationMemory({
    config,
    projectDir: dir,
    sourceLocale: refLocale.code,
    dryRun: isDryRun,
  })
  const overwriteStale = opts.overwriteStale ?? false

  function isKeyMissingIn(data: Record<string, unknown>, k: string): boolean {
    const v = getNestedValue(data, k)
    return v === undefined || v === '' || v === null
  }

  /** The keys in scope for this run: every reference key, or the requested subset. */
  function scopedRefKeys(): string[] {
    return opts.keys ? opts.keys.filter(k => allRefKeys.includes(k)) : allRefKeys
  }

  /** The keys missing in a target locale's data (scoped to opts.keys when given). */
  function missingKeysIn(data: Record<string, unknown>): string[] {
    return scopedRefKeys().filter(k => isKeyMissingIn(data, k))
  }

  /**
   * Keys this locale already has a value for, written from source text that has
   * changed since. Empty without a translation memory: state alone cannot tell
   * an outdated translation from a current one.
   */
  function staleKeysIn(data: Record<string, unknown>, localeCode: string): string[] {
    if (!memory) return []
    return scopedRefKeys().filter((k) => {
      if (isKeyMissingIn(data, k)) return false
      const source = getNestedValue(refData, k)
      return typeof source === 'string' && memory.isStale(layer, k, localeCode, source)
    })
  }

  // Pre-scan: count missing keys per target to compute progressTotal
  if (opts.onProgressTotal) {
    const preScanCounts: number[] = []
    for (const target of targets) {
      let scanData: Record<string, unknown> = {}
      try {
        scanData = await readLocaleData(config, layer, target)
      } catch {}
      preScanCounts.push(missingKeysIn(scanData).length
        + (overwriteStale ? staleKeysIn(scanData, target.code).length : 0))
    }
    // In dry-run or agent mode, only 2 steps per locale (start + complete),
    // no batch steps. Full batching only in provider mode.
    const willBatch = mode === 'provider'
    const total = willBatch
      ? computeProgressTotal(preScanCounts, maxBatch)
      : preScanCounts.filter(c => c > 0).length * 2
    opts.onProgressTotal(total)
  }

  const results: Record<string, TranslateMissingLocaleResult> = {}
  const fallbackContexts: Record<string, Record<string, unknown>> = {}

  // Pre-read all target locale data for missing key detection
  const targetDataCache = new Map<string, Record<string, unknown>>()
  for (const target of targets) {
    let targetData: Record<string, unknown> = {}
    try {
      targetData = await readLocaleData(config, layer, target)
    } catch {}
    targetDataCache.set(target.code, targetData)
  }

  // Set when any locale hits an auth error: the run is doomed, so sibling
  // locales must stop issuing provider requests and must not write output
  // after the abort. Locales that fully completed before the abort keep
  // their writes — translateMissing is idempotent (re-runs only fill the
  // still-missing keys), so completed work is never wasted or wrong.
  const runState: TranslateRunState = { aborted: false }

  async function translateOneLocale(
    target: LocaleDefinition,
    targetData: Record<string, unknown>,
  ): Promise<{ result: TranslateMissingLocaleResult, fallbackContext?: Record<string, unknown> }> {
    const missingKeys = missingKeysIn(targetData)
    const staleKeys = staleKeysIn(targetData, target.code)
    // Stale keys are candidates only when asked for: the documented contract is
    // that this operation fills gaps and never overwrites an existing value.
    // Untouched, they are reported instead of translated.
    const candidateKeys = overwriteStale ? [...missingKeys, ...staleKeys] : missingKeys
    const untouchedStale = overwriteStale ? [] : staleKeys
    const withStale = (result: TranslateMissingLocaleResult): TranslateMissingLocaleResult =>
      (untouchedStale.length > 0 ? { ...result, stale: untouchedStale } : result)

    if (candidateKeys.length === 0) {
      return { result: withStale({ mode, missing: 0, translated: [], failed: [], skipped: [] }) }
    }

    await reportProgress(`Starting ${target.code}: ${candidateKeys.length} missing keys`)

    const keysAndValues: Record<string, string> = {}
    for (const key of candidateKeys) {
      const value = getNestedValue(refData, key)
      if (typeof value === 'string') {
        keysAndValues[key] = value
      }
    }
    const missing = Object.keys(keysAndValues).length

    if (isDryRun) {
      await reportProgress(`Complete ${target.code} (dry run)`)
      return { result: withStale({ mode: 'dry-run', missing, translated: [], wouldTranslate: Object.keys(keysAndValues), failed: [], skipped: [] }) }
    }

    if (opts.translateFn) {
      const translateFn = opts.translateFn
      const translated: string[] = []
      const failed: Array<{ key: string, reason: TranslateFailReason }> = []
      const keyEntries: KeyEntry[] = Object.entries(keysAndValues)
      const allTranslations: Record<string, string> = {}
      const totalKeys = keyEntries.length
      let model: string | undefined
      let requests = 0
      let keysDone = 0
      let stepsReported = 0

      /**
       * One step per maxBatch keys accounted for — the unit
       * computeProgressTotal announced. Splitting changes how many requests a
       * locale takes, never how many keys it has to get through, so the steps
       * still land on the announced total.
       */
      async function reportKeyProgress(): Promise<void> {
        const step = Math.ceil(keysDone / maxBatch)
        if (step <= stepsReported) return
        stepsReported = step
        await reportProgress(`${target.code}: ${keysDone}/${totalKeys} keys`)
      }

      /** Every key of a batch lands in exactly one bucket — totals must reconcile. */
      function failBatch(batch: KeyEntry[], reason: TranslateFailReason): void {
        for (const [key] of batch) failed.push({ key, reason })
        keysDone += batch.length
      }

      /**
       * Issue one request for `batch` and resolve whatever it did not answer:
       * a response cut off at the token limit is re-issued for its remainder,
       * or halved when nothing usable arrived, bounded by MAX_SPLIT_DEPTH.
       * Requests stay sequential within a locale.
       */
      async function translateBatch(batch: KeyEntry[], depth: number): Promise<void> {
        if (runState.aborted || batch.length === 0) return

        const batchValues = Object.fromEntries(batch)
        const systemPrompt = buildTranslationSystemPrompt(config.projectConfig, target, config.localeFileFormat)
        const userMessage = buildTranslationUserMessage(
          refLocale!.language || refLocale!.code,
          target.language || target.code,
          batchValues,
          config.localeFileFormat,
        )

        requests++
        const outcome = await requestWithRetry(
          translateFn,
          { systemPrompt, userMessage, maxTokens: TRANSLATE_MAX_TOKENS },
          {
            label: `batch of ${batch.length} key(s) in ${target.code}`,
            logModel: true,
            runState,
            parse: (text, truncated) => {
              // Keys the model invented are dropped here; keys it omitted are
              // accounted for below.
              const parsed = extractJsonFromResponse(text, { truncated })
              const batchKeys = new Set(Object.keys(batchValues))
              const batchTranslations: Record<string, string> = {}
              for (const [key, value] of Object.entries(parsed)) {
                if (batchKeys.has(key) && typeof value === 'string') {
                  batchTranslations[key] = value
                }
              }
              return batchTranslations
            },
          },
        )
        model = outcome.model ?? model

        if (outcome.status === 'failed') {
          // Transport or parse failure that survived the retry: a smaller
          // request does not make a broken connection work.
          failBatch(batch, 'provider-error')
          await reportKeyProgress()
          return
        }

        if (outcome.status === 'truncated') {
          // Nothing usable arrived. Half the keys is half the output, so the
          // same token budget may well hold the answer — until one key is
          // left, which genuinely does not fit.
          if (batch.length === 1 || depth >= MAX_SPLIT_DEPTH) {
            failBatch(batch, 'truncated')
            await reportKeyProgress()
            return
          }
          const half = Math.ceil(batch.length / 2)
          const head = batch.slice(0, half)
          const tail = batch.slice(half)
          log.info(`Translate batch of ${batch.length} truncated for ${target.code} — split into ${head.length} + ${tail.length}`)
          await translateBatch(head, depth + 1)
          await translateBatch(tail, depth + 1)
          return
        }

        // A cut-off response still carries the pairs that arrived ('partial'),
        // so its keys are read exactly like a complete response's; the ones it
        // does not carry were lost to the cut rather than passed over by the
        // model, and are re-asked for rather than failed.
        const remainder: KeyEntry[] = []
        for (const entry of batch) {
          const [key] = entry
          const value = outcome.value[key]
          if (typeof value === 'string') {
            allTranslations[key] = value
            translated.push(key)
            keysDone++
          } else if (outcome.status === 'partial') {
            remainder.push(entry)
          } else {
            failed.push({ key, reason: 'omitted-by-model' })
            keysDone++
          }
        }
        await reportKeyProgress()

        if (remainder.length === 0) return
        if (depth >= MAX_SPLIT_DEPTH) {
          failBatch(remainder, 'truncated')
          await reportKeyProgress()
          return
        }
        // A partial response carried at least one key, so the remainder is
        // strictly smaller than the batch and the recursion terminates.
        log.info(`Translate batch of ${batch.length} truncated for ${target.code} — kept ${batch.length - remainder.length}, re-asking for ${remainder.length}`)
        await translateBatch(remainder, depth + 1)
      }

      // Weight-based planning keeps most requests inside the token budget;
      // batches are never larger than maxBatch, only smaller.
      const plannedBatches = planBatches(keyEntries, {
        maxKeys: maxBatch,
        budgetChars: TRANSLATE_BUDGET_CHARS,
        expansion: expansionFor(target),
      })
      for (const batch of plannedBatches) {
        if (runState.aborted) break
        await translateBatch(batch, 0)
      }

      const placeholderValidation = mergePlaceholderValidation(Object.entries(allTranslations).map(([key, value]) => {
        return validatePlaceholders(key, keysAndValues[key] ?? '', [{ locale: target.code, value }], config.localeFileFormat)
      }))

      if (placeholderValidation && !placeholderValidation.ok) {
        const reasonByKey = new Map<string, TranslateFailReason>()
        for (const error of placeholderValidation.errors) {
          if (!reasonByKey.has(error.key)) {
            reasonByKey.set(error.key, failReasonForIssue(error))
          }
        }
        for (const [key, reason] of reasonByKey) {
          delete allTranslations[key]
          failed.push({ key, reason })
        }
        for (const key of [...translated]) {
          if (reasonByKey.has(key)) translated.splice(translated.indexOf(key), 1)
        }
      }

      if (runState.aborted) {
        // Run is doomed — don't write partial output for an in-flight locale.
        // The returned result is discarded by the rejecting Promise.all.
        return { result: { mode: 'provider', missing, translated: [], failed, skipped: [] } }
      }

      if (Object.keys(allTranslations).length > 0) {
        try {
          await mutateLocaleData(config, layer, target, (data) => {
            for (const [key, value] of Object.entries(allTranslations)) {
              setNestedValue(data, key, value)
            }
          })
        } catch (error) {
          log.warn(`Failed to write translations for ${target.code}: ${toErrorMessage(error)}`)
          // Only the keys that were about to be written failed on write;
          // earlier failures keep their own reasons.
          for (const key of translated) {
            failed.push({ key, reason: 'write-error' })
          }
          return { result: withStale({ mode: 'provider', missing, translated: [], failed, skipped: [], batches: requests, model, writeError: toErrorMessage(error) }) }
        }
        // Written, so remember what each value was translated from — whether or
        // not this run was allowed to overwrite stale ones.
        for (const key of Object.keys(allTranslations)) {
          const source = keysAndValues[key]
          if (source !== undefined) memory?.record(layer, key, target.code, source)
        }
      }

      await reportProgress(`Complete ${target.code}`)
      // `batches` counts the requests the locale actually took, splits included.
      return { result: withStale({ mode: 'provider', missing, translated, failed, skipped: [], batches: requests, model, ...(placeholderValidation ? { placeholderValidation } : {}) }) }
    } else {
      // Agent mode: return context for the host agent to translate inline
      const fallbackContext = buildFallbackContext(
        config.projectConfig,
        refLocale!,
        [target],
        keysAndValues,
      )
      await reportProgress(`Complete ${target.code}`)
      return {
        result: withStale({
          mode: 'agent',
          missing,
          translated: [],
          failed: [],
          skipped: Object.keys(keysAndValues).map(key => ({ key, reason: 'no-provider' as const })),
        }),
        fallbackContext,
      }
    }
  }

  const localeResults = await Promise.all(targets.map(async (target) => {
    const targetData = targetDataCache.get(target.code) ?? {}
    return translateOneLocale(target, targetData)
  }))

  for (const [i, { result, fallbackContext }] of localeResults.entries()) {
    const target = targets[i]
    if (target === undefined) continue
    const localeCode = target.code
    results[localeCode] = result
    if (fallbackContext) {
      fallbackContexts[localeCode] = fallbackContext
    }
  }

  Object.assign(results, await collectProtectedLocaleResults(config, layer, mode, protectedDefaults, missingKeysIn))

  await memory?.flush()

  const totalTranslated = Object.values(results).reduce((sum, r) => sum + r.translated.length, 0)
  const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed.length, 0)
  const totalSkipped = Object.values(results).reduce((sum, r) => sum + r.skipped.length, 0)
  const totalWouldTranslate = Object.values(results).reduce((sum, r) => sum + (r.wouldTranslate?.length ?? 0), 0)
  const staleCount = Object.values(results).reduce((sum, r) => sum + (r.stale?.length ?? 0), 0)

  const summary: TranslateMissingResult['summary'] = {
    mode,
    totalTranslated,
    totalFailed,
    totalSkipped,
    ...(isDryRun ? { totalWouldTranslate } : {}),
    // Omitted rather than zero, so a project without a translation memory sees
    // the result it has always seen.
    ...(staleCount > 0 ? { staleCount } : {}),
    layer,
    referenceLocale: localeRefInfo(refLocale),
    targetLocales: targets.map(localeRefInfo),
    dryRun: isDryRun,
  }

  const hasFallbackContexts = Object.keys(fallbackContexts).length > 0

  // Compact is a projection of the full result: it may only drop per-key
  // detail, never the fallback contexts, reasons, or locale metadata that
  // change what the caller does next.
  if (opts.compact) {
    const byLocale = Object.entries(results).map(([code, r]) => {
      // Reduce per-key arrays to counts; drop per-key placeholder detail;
      // keep every other per-locale field (mode, missing, batches, model,
      // writeError, …).
      const { translated, failed, skipped, wouldTranslate, stale, placeholderValidation: _placeholderValidation, ...rest } = r
      return {
        locale: code,
        translated: translated.length,
        failed: failed.length,
        skipped: skipped.length,
        ...(wouldTranslate ? { wouldTranslate: wouldTranslate.length } : {}),
        ...(stale ? { stale: stale.length } : {}),
        ...rest,
      }
    })
    return {
      summary: { ...summary, byLocale },
      ...(hasFallbackContexts ? { fallbackContexts } : {}),
    }
  }

  const output: TranslateMissingResult = { results, summary }
  if (hasFallbackContexts) {
    output.fallbackContexts = fallbackContexts
  }
  return output
}

/**
 * All-layers mode: run the single-layer translate pipeline once per canonical
 * locale-backed layer and aggregate into one result. The existing summary
 * fields (`totalTranslated`, `totalFailed`, `totalSkipped`,
 * `totalWouldTranslate`) become cross-layer totals — jq consumers of the
 * single-layer summary keep working unchanged. `summary.byLayer` and the
 * per-layer `layers` sections (each in the single-layer result shape) are
 * additive.
 */
async function translateMissingAllLayers(
  opts: Omit<TranslateMissingOptions, 'layer'>,
): Promise<TranslateAllLayersResult> {
  const config = await detectI18nConfig(opts.projectDir ?? process.cwd())
  const layerNames = collectTranslatableLayers(config)
  if (layerNames.length === 0) {
    throw new ToolError('No locale-backed layers detected. Use list_locale_dirs to inspect the configuration.', 'LAYER_NOT_FOUND')
  }
  const { layers, byLayer } = await runLayerTranslations(layerNames, opts)
  return { layers, summary: buildAllLayersSummary(layers, byLayer, opts) }
}

/**
 * Layers eligible for an all-layers run: each physical locale dir exactly
 * once. Aliases are excluded via canonicalLayers, and same-path canonical
 * entries (possible in hand-written generic configs) collapse to the first —
 * an aliased app layer must never cause a second translate/write of its
 * owner's files.
 */
function collectTranslatableLayers(config: I18nConfig): string[] {
  const seenPaths = new Set<string>()
  const layerNames: string[] = []
  for (const localeDir of buildLayerGraph(config).canonicalLayers) {
    if (seenPaths.has(localeDir.path)) continue
    seenPaths.add(localeDir.path)
    layerNames.push(localeDir.layer)
  }
  return layerNames
}

async function runLayerTranslations(
  layerNames: string[],
  opts: Omit<TranslateMissingOptions, 'layer'>,
): Promise<{ layers: Record<string, TranslateMissingResult>, byLayer: TranslateLayerTotals[] }> {
  const layers: Record<string, TranslateMissingResult> = {}
  const byLayer: TranslateLayerTotals[] = []
  for (const layerName of layerNames) {
    let layerResult: TranslateMissingResult
    try {
      // A named layer always takes the single-layer branch.
      layerResult = await translateMissing({ ...opts, layer: layerName }) as TranslateMissingResult
    } catch (error) {
      // A layer without reference-locale data has nothing to drive
      // translation — skip it so one sparse layer cannot fail the run for
      // its siblings. Explicit single-layer calls still throw.
      if (error instanceof ToolError && error.code === 'NO_LOCALE_FILE') {
        log.warn(`Skipping layer "${layerName}": ${error.message}`)
        continue
      }
      throw error
    }
    layers[layerName] = layerResult
    byLayer.push(layerTotals(layerName, layerResult))
  }
  return { layers, byLayer }
}

function layerTotals(layerName: string, layerResult: TranslateMissingResult): TranslateLayerTotals {
  const layerSummary = layerResult.summary as {
    totalTranslated: number
    totalFailed: number
    totalSkipped: number
    totalWouldTranslate?: number
  }
  return {
    layer: layerName,
    totalTranslated: layerSummary.totalTranslated,
    totalFailed: layerSummary.totalFailed,
    totalSkipped: layerSummary.totalSkipped,
    totalWouldTranslate: layerSummary.totalWouldTranslate ?? 0,
  }
}

function buildAllLayersSummary(
  layers: Record<string, TranslateMissingResult>,
  byLayer: TranslateLayerTotals[],
  opts: Omit<TranslateMissingOptions, 'layer'>,
): TranslateAllLayersSummary {
  const isDryRun = opts.dryRun ?? false
  const total = (pick: (l: TranslateLayerTotals) => number): number =>
    byLayer.reduce((sum, l) => sum + pick(l), 0)
  // Read off the layer summaries rather than byLayer: stale keys are not one of
  // the reconciling totals, so they are not part of the per-layer breakdown.
  const staleCount = Object.values(layers).reduce((sum, l) => sum + (l.summary.staleCount ?? 0), 0)
  // Locales are project-global, so mode, reference locale, and target set are
  // identical across layers — hoist them from the first translated layer.
  const first = Object.values(layers)[0]?.summary
  const summary: TranslateAllLayersSummary = {
    mode: isDryRun ? 'dry-run' : opts.translateFn ? 'provider' : 'agent',
    totalTranslated: total(l => l.totalTranslated),
    totalFailed: total(l => l.totalFailed),
    totalSkipped: total(l => l.totalSkipped),
    ...(isDryRun ? { totalWouldTranslate: total(l => l.totalWouldTranslate) } : {}),
    ...(staleCount > 0 ? { staleCount } : {}),
    layers: byLayer.map(l => l.layer),
    byLayer,
    dryRun: isDryRun,
  }
  if (first?.referenceLocale !== undefined) summary.referenceLocale = first.referenceLocale
  if (first?.targetLocales !== undefined) summary.targetLocales = first.targetLocales
  return summary
}

/**
 * Translate one key from a source locale into target locales. Unlike
 * translate_missing, this can overwrite stale existing target values.
 */
export async function translateKey(opts: {
  layer: string
  key: string
  sourceLocale: string
  sourceValue?: string
  targetLocales?: string[] | 'all'
  overwrite?: boolean
  dryRun?: boolean
  includePreview?: boolean
  projectDir?: string
  translateFn?: TranslateFn
}): Promise<TranslateKeyResult> {
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const isDryRun = opts.dryRun ?? false
  const overwrite = opts.overwrite ?? true
  const sourceLocale = findLocaleOrThrow(config, opts.sourceLocale)
  warnUnmatchedLocaleNotes(config)
  const usesDefaultTargets = opts.targetLocales === undefined || opts.targetLocales === 'all'
  const resolvedTargetLocales = opts.targetLocales === undefined || opts.targetLocales === 'all'
    ? config.locales
    : opts.targetLocales.map(localeRef => findLocaleOrThrow(config, localeRef))
  const { targetLocales, protectedSkipped } = partitionTranslateKeyTargets(
    config, resolvedTargetLocales, sourceLocale.code, usesDefaultTargets,
  )

  const sourceData = await readLocaleData(config, opts.layer, sourceLocale)
  const existingSourceValue = getNestedValue(sourceData, opts.key)
  const sourceValue = opts.sourceValue ?? (typeof existingSourceValue === 'string' ? existingSourceValue : undefined)

  if (sourceValue === undefined) {
    throw new ToolError(`Source value for key "${opts.key}" not found in locale "${opts.sourceLocale}". Provide sourceValue or add the key first.`, 'SOURCE_KEY_NOT_FOUND')
  }

  // Null unless the project opted in; a changed source value needs no entry of
  // its own, since it is what the recorded target hashes are compared against.
  const memory = await openTranslationMemory({
    config,
    projectDir: dir,
    sourceLocale: sourceLocale.code,
    dryRun: isDryRun,
  })

  const preview: Record<string, string> = {}
  let filesWritten = 0
  let updatedSource = false

  if (opts.sourceValue !== undefined && existingSourceValue !== opts.sourceValue) {
    updatedSource = true
    if (opts.includePreview || isDryRun) preview[sourceLocale.code] = opts.sourceValue
    if (!isDryRun) {
      const written = await mutateLocaleData(config, opts.layer, sourceLocale, (data) => {
        setNestedValue(data, opts.key, opts.sourceValue!)
      })
      filesWritten += written.size
    }
  }

  const existingTargets: Array<{ locale: LocaleDefinition, existingValue: unknown }> = []
  const failed: TranslateKeyLocaleIssue[] = []
  for (const locale of targetLocales) {
    try {
      const data = await readLocaleData(config, opts.layer, locale)
      existingTargets.push({ locale, existingValue: getNestedValue(data, opts.key) })
    } catch (error) {
      failed.push({ locale: locale.code, reason: 'read-error', detail: toErrorMessage(error) })
    }
  }

  const targetsToTranslate = existingTargets.filter(({ existingValue }) => {
    return overwrite || existingValue === undefined || existingValue === '' || existingValue === null
  })
  const skipped: TranslateKeySkip[] = [
    ...protectedSkipped,
    ...existingTargets
      .filter(({ existingValue }) => !overwrite && existingValue !== undefined && existingValue !== '' && existingValue !== null)
      // 'already-translated' says a value is there; `stale` says whether it
      // still answers the source text, which is a different question and so a
      // separate field rather than a fourth skip reason.
      .map(({ locale }) => ({
        locale: locale.code,
        reason: 'already-translated' as const,
        ...(memory ? { stale: memory.isStale(opts.layer, opts.key, locale.code, sourceValue) } : {}),
      })),
  ]

  const basePlaceholderValidation = validatePlaceholders(opts.key, sourceValue, [{ locale: sourceLocale.code, value: sourceValue }], config.localeFileFormat)

  if (isDryRun) {
    return {
      key: opts.key,
      sourceLocale: localeRefInfo(sourceLocale),
      updatedSource,
      mode: 'dry-run',
      translated: [],
      wouldTranslate: targetsToTranslate.map(({ locale }) => locale.code),
      skipped,
      failed,
      filesWritten: 0,
      dryRun: true,
      placeholderValidation: basePlaceholderValidation,
      ...(opts.includePreview ? { preview } : {}),
    }
  }

  if (targetsToTranslate.length === 0) {
    return {
      key: opts.key,
      sourceLocale: localeRefInfo(sourceLocale),
      updatedSource,
      mode: opts.translateFn ? 'provider' : 'agent',
      translated: [],
      skipped,
      failed,
      filesWritten,
      dryRun: false,
      placeholderValidation: basePlaceholderValidation,
      ...(opts.includePreview ? { preview } : {}),
    }
  }

  if (!opts.translateFn) {
    // Agent mode: nothing was attempted — targets are skipped, not failed.
    return {
      key: opts.key,
      sourceLocale: localeRefInfo(sourceLocale),
      updatedSource,
      mode: 'agent',
      translated: [],
      skipped: [
        ...skipped,
        ...targetsToTranslate.map(({ locale }) => ({ locale: locale.code, reason: 'no-provider' as const })),
      ],
      failed,
      filesWritten,
      dryRun: false,
      placeholderValidation: basePlaceholderValidation,
      fallbackContext: buildFallbackContext(
        config.projectConfig,
        sourceLocale,
        targetsToTranslate.map(({ locale }) => locale),
        { [opts.key]: sourceValue },
      ),
      ...(opts.includePreview ? { preview } : {}),
    }
  }

  const translated: string[] = []
  const placeholderValidations: PlaceholderValidationResult[] = [basePlaceholderValidation]
  let model: string | undefined

  for (const { locale } of targetsToTranslate) {
    const systemPrompt = buildTranslationSystemPrompt(config.projectConfig, locale, config.localeFileFormat)
    const userMessage = buildTranslationUserMessage(
      sourceLocale.language || sourceLocale.code,
      locale.language || locale.code,
      { [opts.key]: sourceValue },
      config.localeFileFormat,
    )

    const outcome = await requestWithRetry(
      opts.translateFn,
      { systemPrompt, userMessage, maxTokens: TRANSLATE_MAX_TOKENS },
      {
        label: locale.code,
        parse: (text, truncated) => {
          const parsedValue = extractJsonFromResponse(text, { truncated })[opts.key]
          return typeof parsedValue === 'string' ? parsedValue : undefined
        },
      },
    )
    model = outcome.model ?? model
    // One key per request: a truncated response that still carried it is worth
    // as much as a complete one.
    const targetValue = outcome.status === 'ok' || outcome.status === 'partial' ? outcome.value : undefined

    if (!targetValue) {
      failed.push({
        locale: locale.code,
        reason: outcome.status === 'truncated' || outcome.status === 'partial'
          ? 'truncated'
          : outcome.status === 'failed' ? 'provider-error' : 'omitted-by-model',
      })
      continue
    }

    const validation = validatePlaceholders(opts.key, sourceValue, [{ locale: locale.code, value: targetValue }], config.localeFileFormat)
    placeholderValidations.push(validation)
    const firstIssue = validation.errors[0]
    if (firstIssue !== undefined) {
      failed.push({ locale: locale.code, reason: failReasonForIssue(firstIssue) })
      continue
    }

    if (opts.includePreview) preview[locale.code] = targetValue
    try {
      const written = await mutateLocaleData(config, opts.layer, locale, (data) => {
        setNestedValue(data, opts.key, targetValue)
      })
      filesWritten += written.size
      translated.push(locale.code)
      memory?.record(opts.layer, opts.key, locale.code, sourceValue)
    } catch (error) {
      failed.push({ locale: locale.code, reason: 'write-error', detail: toErrorMessage(error) })
    }
  }

  await memory?.flush()

  return {
    key: opts.key,
    sourceLocale: localeRefInfo(sourceLocale),
    updatedSource,
    mode: 'provider',
    translated,
    skipped,
    failed,
    filesWritten,
    dryRun: false,
    model,
    placeholderValidation: mergePlaceholderValidation(placeholderValidations) ?? basePlaceholderValidation,
    ...(opts.includePreview ? { preview } : {}),
  }
}
