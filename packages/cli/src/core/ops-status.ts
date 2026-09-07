/**
 * status: translation coverage per locale and per layer, in one call.
 */

import { existsSync } from 'node:fs'

import { detectI18nConfig } from '../config/detector.js'
import { buildLayerGraph } from '../config/layer-graph.js'
import { readLocaleData, readLocaleDataIfPresent } from '../io/locale-data.js'
import { getNestedValue, getLeafKeys } from '../io/key-operations.js'
import { findReferenceLocaleOrThrow, localeRefInfo, resolveLayersToScan } from './shared.js'
import { resolveProtectedLocales } from './ops-translate.js'
import { collectEmptyTranslations } from './ops-read.js'
import { memoryFilePath, openTranslationMemory } from './translate/memory.js'
import type { TranslationMemorySession } from './translate/memory.js'
import type { LocaleDefinition, LocaleDir, I18nConfig } from '../config/types.js'
import type { TranslationStatusResult, LocaleStatus, LayerStatus } from './types.js'

/**
 * Keys worth translating: present in the reference locale with a non-empty
 * value. An empty reference value is nothing to translate *from*, so counting
 * it would deflate every locale equally and hide real gaps.
 */
function referenceKeys(refData: Record<string, unknown>): string[] {
  return getLeafKeys(refData).filter((k) => {
    const v = getNestedValue(refData, k)
    return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
  })
}

type KeyState = 'translated' | 'missing' | 'empty'

/**
 * Classify one key in one locale. `missing` and `empty` are both untranslated
 * but distinct: a missing key was never written, an empty one was scaffolded
 * and never filled. Reporting them separately is what tells a scaffold-and-
 * forget locale apart from an untouched one — matching how
 * getMissingTranslations already treats empties as not-translated.
 */
function classify(data: Record<string, unknown>, key: string): KeyState {
  const value = getNestedValue(data, key)
  if (value === undefined || value === null) return 'missing'
  if (typeof value === 'string' && value.length === 0) return 'empty'
  return 'translated'
}

function percent(translated: number, total: number): number {
  if (total === 0) return 100
  return Math.round((translated / total) * 1000) / 10
}

interface Counts { total: number, translated: number, missing: number, empty: number, stale: number }

const emptyCounts = (): Counts => ({ total: 0, translated: 0, missing: 0, empty: 0, stale: 0 })

/**
 * Counts for one locale against one layer's reference keys. `isStaleKey`
 * answers for keys that have a value: a missing or blank one is untranslated,
 * which the other counters already say, and it cannot be out of date.
 */
function countLocale(
  data: Record<string, unknown>,
  keys: string[],
  isStaleKey: (key: string) => boolean,
): Counts {
  const counts = emptyCounts()
  for (const key of keys) {
    counts.total += 1
    const state = classify(data, key)
    counts[state] += 1
    if (state === 'translated' && isStaleKey(key)) counts.stale += 1
  }
  return counts
}

function merge(into: Counts | undefined, from: Counts): void {
  if (!into) return
  into.total += from.total
  into.translated += from.translated
  into.missing += from.missing
  into.empty += from.empty
  into.stale += from.stale
}

/**
 * Coverage for a project: per locale, per layer, and one overall figure.
 *
 * Protected locales are counted and reported but excluded from the overall
 * percentage — they are maintained by hand, so counting their gaps as project
 * debt makes a healthy project read as failing and moves a number nobody can
 * act on.
 *
 * Where a translation memory exists, translated keys whose source text has
 * changed since are counted too: coverage alone reads them as done.
 */
export async function getTranslationStatus(opts: {
  layer?: string
  referenceLocale?: string
  /**
   * Also list the keys behind `summary.emptyKeys`, under `empty`. Off by
   * default: the count is what a health check reads, and the list grows with
   * the project.
   */
  listEmpty?: boolean
  projectDir?: string
}): Promise<TranslationStatusResult> {
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const refLocale = findReferenceLocaleOrThrow(config, opts.referenceLocale)

  const layersToScan = resolveLayersToScan(config, opts.layer)

  const protectedCodes = new Set(resolveProtectedLocales(config).map(l => l.code))
  const targets = config.locales.filter(l => l.code !== refLocale.code)

  const byLocale = new Map<string, Counts>(targets.map(l => [l.code, emptyCounts()]))
  const byLayer = new Map<string, Counts>(layersToScan.map(d => [d.layer, emptyCounts()]))

  // Only a memory already on disk can answer for staleness: an empty one calls
  // every key current, which a caller cannot tell from a real all-clear. The
  // session decides the rest — it is null when the feature is off, and when the
  // reference locale is not the one the recorded hashes are of. Dry run because
  // reporting coverage must not rewrite the project's bookkeeping.
  const memory = existsSync(memoryFilePath(dir))
    ? await openTranslationMemory({ config, projectDir: dir, sourceLocale: refLocale.code, dryRun: true })
    : null

  await tally({ config, layersToScan, refLocale, targets, protectedCodes, byLocale, byLayer, memory })

  const locales: LocaleStatus[] = targets.map((locale) => {
    const { stale, ...c } = byLocale.get(locale.code) ?? emptyCounts()
    const isProtected = protectedCodes.has(locale.code)
    return {
      ...localeRefInfo(locale),
      ...c,
      completion: percent(c.translated, c.total),
      ...(memory ? { stale } : {}),
      ...(isProtected ? { protected: true, excludedFromOverall: true } : {}),
    }
  })

  // The layer graph already knows which apps declare which layers; a layer no
  // app consumes holds keys nothing can render, which no other tool reports.
  const graph = buildLayerGraph(config)

  const layers: LayerStatus[] = [...byLayer.entries()].map(([layer, { stale, ...c }]) => ({
    layer,
    ...c,
    completion: percent(c.translated, c.total),
    ...(memory ? { stale } : {}),
    consumedBy: graph.appsUsingLayer(layer),
  }))

  // With one app (what every single-locale-dir adapter builds) every layer is
  // either that app's or nobody's, and "nobody's" is then an artefact of the
  // config rather than a monorepo smell. Only flag it where apps compete.
  const unconsumedLayers = (config.apps ?? []).length > 1
    ? layers.filter(l => l.consumedBy.length === 0).map(l => l.layer)
    : []

  const counted = locales.filter(l => !l.protected)
  const overallTranslated = counted.reduce((n, l) => n + l.translated, 0)
  const overallTotal = counted.reduce((n, l) => n + l.total, 0)

  return {
    locales,
    layers,
    ...(opts.listEmpty ? await listEmptyKeys(config, layersToScan, refLocale, opts.layer) : {}),
    summary: {
      referenceLocale: localeRefInfo(refLocale),
      layersScanned: layersToScan.map(d => d.layer),
      unconsumedLayers,
      localesChecked: counted.length,
      protectedLocales: locales.filter(l => l.protected).map(l => l.code),
      totalKeys: overallTotal,
      translatedKeys: overallTranslated,
      missingKeys: counted.reduce((n, l) => n + l.missing, 0),
      emptyKeys: counted.reduce((n, l) => n + l.empty, 0),
      ...(memory ? { staleCount: counted.reduce((n, l) => n + (l.stale ?? 0), 0) } : {}),
      // The gate in #248 reads this counter, so the name is load-bearing.
      completionPercent: percent(overallTranslated, overallTotal),
    },
  }
}

/**
 * The two listings behind `--listEmpty`. `empty` holds exactly the keys
 * `summary.emptyKeys` counts: empty in a target locale while the reference has
 * a value. A key that is empty in the reference locale is nothing to translate
 * from, so it is excluded from every count and listed separately — it is
 * usually intentional, and it should not read as translation debt.
 */
async function listEmptyKeys(
  config: I18nConfig,
  layersToScan: LocaleDir[],
  refLocale: LocaleDefinition,
  layer: string | undefined,
): Promise<Pick<TranslationStatusResult, 'empty' | 'emptyInReference'>> {
  const emptyInRefByLayer = new Map<string, Set<string>>()
  for (const localeDir of layersToScan) {
    const refData = await readLocaleDataIfPresent(config, localeDir.layer, refLocale)
    if (!refData) continue
    emptyInRefByLayer.set(localeDir.layer, new Set(
      getLeafKeys(refData).filter(k => getNestedValue(refData, k) === ''),
    ))
  }

  const all = (await collectEmptyTranslations(config, { layer })).emptyKeys
  const empty: Record<string, Record<string, string[]>> = {}
  const emptyInReference: Record<string, string[]> = {}
  for (const [locale, byLayer] of Object.entries(all)) {
    for (const [layerName, keys] of Object.entries(byLayer)) {
      const refEmpty = emptyInRefByLayer.get(layerName) ?? new Set<string>()
      const counted = keys.filter(k => !refEmpty.has(k))
      if (locale === refLocale.code) {
        if (keys.length > 0) emptyInReference[layerName] = keys
        continue
      }
      if (counted.length > 0) (empty[locale] ??= {})[layerName] = counted
    }
  }
  return {
    empty,
    ...(Object.keys(emptyInReference).length > 0 ? { emptyInReference } : {}),
  }
}

async function readTargetData(
  config: I18nConfig,
  layer: string,
  target: LocaleDefinition,
): Promise<Record<string, unknown>> {
  try {
    return await readLocaleData(config, layer, target)
  }
  catch {
    // A locale with no file in this layer is entirely missing, not an error.
    return {}
  }
}

/** Walk every layer once, accumulating both breakdowns in a single pass. */
async function tally(ctx: {
  config: I18nConfig
  layersToScan: LocaleDir[]
  refLocale: LocaleDefinition
  targets: LocaleDefinition[]
  protectedCodes: Set<string>
  byLocale: Map<string, Counts>
  byLayer: Map<string, Counts>
  /** Null when nothing can be said about staleness; see getTranslationStatus. */
  memory: TranslationMemorySession | null
}): Promise<void> {
  for (const localeDir of ctx.layersToScan) {
    const refData = await readLocaleDataIfPresent(ctx.config, localeDir.layer, ctx.refLocale)
    if (!refData) continue

    const keys = referenceKeys(refData)
    if (keys.length === 0) continue

    for (const target of ctx.targets) {
      const isStaleKey = (key: string): boolean => {
        if (!ctx.memory) return false
        const source = getNestedValue(refData, key)
        return typeof source === 'string' && ctx.memory.isStale(localeDir.layer, key, target.code, source)
      }
      const counts = countLocale(await readTargetData(ctx.config, localeDir.layer, target), keys, isStaleKey)
      merge(ctx.byLocale.get(target.code), counts)
      // A protected locale's gaps are deliberate, so they must not drag the
      // layer figure down either — the layer is not what is incomplete.
      if (!ctx.protectedCodes.has(target.code)) merge(ctx.byLayer.get(localeDir.layer), counts)
    }
  }
}
