/**
 * Read-only operations: project discovery, config detection, locale-dir
 * listing, translation lookup/search, missing/empty detection, and namespace
 * browsing.
 */

import { readdir } from 'node:fs/promises'

import { detectI18nConfig, clearConfigCache } from '../config/detector.js'
import { serializeLayerGraph } from '../config/layer-graph.js'
import type { SerializedLayerGraph } from '../config/layer-graph.js'
import type { I18nConfig, ProjectConfig } from '../config/types.js'
import { readLocaleData, readLocaleDataIfPresent, resolveLocaleEntries } from '../io/locale-data.js'
import { getFormat } from '../io/formats.js'
import { getNestedValue, getLeafKeys } from '../io/key-operations.js'
import { ToolError } from '../utils/errors.js'

import type { LocaleRefInfo } from './types.js'
import { findLayerOrThrow, findReferenceLocaleOrThrow, findLocaleImpl, localeRefInfo, resolveLayersToScan } from './shared.js'
import { resolveProtectedLocales } from './ops-translate.js'

// ─── paging ──────────────────────────────────────────────────────

/**
 * How a read that was capped reports what it left behind.
 *
 * The cap is applied after the full computation, so every count a caller
 * branches on — `totalMatches`, `totalMissingKeys` — is the number for the
 * whole project rather than for the window returned.
 */
export interface PagedResult {
  truncated: boolean
  /** Where a follow-up call has to start to continue. Present only when truncated. */
  nextOffset?: number
  /** The step after this one, as the surface the call ran on phrases it. Present when there is one. */
  message?: string
}

/** The requested window of `items`, and whether anything was left behind it. */
function paginate<T>(
  items: T[],
  opts: { limit?: number, offset?: number },
): { page: T[] } & PagedResult {
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  // No limit means no cap: a terminal answer is piped into jq, not into a
  // context window, so the unbounded read stays available.
  const end = opts.limit === undefined ? items.length : offset + Math.max(0, Math.trunc(opts.limit))
  const page = items.slice(offset, end)
  return end < items.length
    ? { page, truncated: true, nextOffset: end }
    : { page, truncated: false }
}

// ─── discover ────────────────────────────────────────────────────

/**
 * The whole resolved project in one answer: the config, the locale dirs behind
 * it, the topology those dirs form, and which locales are maintained by hand.
 *
 * A superset of `I18nConfig` rather than a wrapper around it, because every
 * caller of the old three-call sequence merged the parts anyway and a nested
 * `config` key would break each of them for nothing.
 */
export interface DescribeProjectResult extends I18nConfig {
  /**
   * Canonical codes of the locales the translate operations leave alone. The
   * raw refs stay visible under `projectConfig.protectedLocales`.
   */
  protectedLocales: string[]
  /** One entry per locale directory, with file counts and key namespaces. */
  layers: LocaleDirInfo[]
  /**
   * Which layers are shared, which apps consume which layer, and what each
   * alias points at — the topology behind the flat `layers` list, and what
   * answers where a new key belongs.
   */
  layerGraph: SerializedLayerGraph
}

/**
 * The project-config fields that carry translation prose rather than structure.
 * The MCP prompts assemble the same text into the instructions they hand a
 * host, so repeating it in every discover answer costs a caller kilobytes of
 * context for something it already has.
 */
const TRANSLATION_GUIDANCE_FIELDS = ['context', 'glossary', 'translationPrompt', 'localeNotes', 'examples'] as const

type TranslationGuidanceField = (typeof TRANSLATION_GUIDANCE_FIELDS)[number]

/** `projectConfig` with the translation prose left out, and a flag saying so. */
export interface TrimmedProjectConfig extends Omit<ProjectConfig, TranslationGuidanceField> {
  /** The omitted fields exist — ask for them with `includeTranslationGuidance`. */
  translationGuidanceOmitted: true
}

/**
 * What {@link describeProject} answers with: {@link DescribeProjectResult} with
 * a `projectConfig` that is trimmed unless the translation prose was asked for.
 */
export interface DescribeProjectOutcome extends Omit<DescribeProjectResult, 'projectConfig'> {
  projectConfig?: ProjectConfig | TrimmedProjectConfig
}

/**
 * Everything a caller needs to know about a project before touching it:
 * resolved config, locale directories, the layer topology, and which locales
 * are hand-maintained.
 *
 * This composition used to live in the MCP `discover` handler, so the terminal
 * had no way to ask the question its own docs told people to ask — and the two
 * surfaces would have had to be kept in step by hand once one of them grew a
 * field. Callers add whatever is theirs alone (the MCP server adds the
 * translation backend it resolved at startup); the project half is here.
 */
export async function describeProject(opts: {
  projectDir?: string
  /** Keep the translation prose in `projectConfig`. Default: false. */
  includeTranslationGuidance?: boolean
} = {}): Promise<DescribeProjectOutcome> {
  // detectConfig first: it warms the config cache listLocaleDirs reuses.
  const config = await detectConfig(opts.projectDir)
  const layers = await listLocaleDirs(opts.projectDir)

  return {
    ...config,
    ...(config.projectConfig !== undefined && opts.includeTranslationGuidance !== true
      ? { projectConfig: withoutTranslationGuidance(config.projectConfig) }
      : {}),
    protectedLocales: resolveProtectedLocales(config).map(l => l.code),
    layers,
    layerGraph: serializeLayerGraph(config),
  }
}

function withoutTranslationGuidance(projectConfig: ProjectConfig): TrimmedProjectConfig {
  // Dropped by name rather than picked by name: a structural field added to
  // ProjectConfig has to keep reaching the caller without an edit here.
  const trimmed = { ...projectConfig, translationGuidanceOmitted: true } as const
  for (const field of TRANSLATION_GUIDANCE_FIELDS) delete trimmed[field]
  return trimmed
}

/**
 * Detect the i18n configuration from the project, always bypassing the
 * config cache (clears it first).
 */
export async function detectConfig(projectDir?: string): Promise<I18nConfig> {
  const dir = projectDir ?? process.cwd()
  clearConfigCache()
  return detectI18nConfig(dir)
}

export interface LocaleDirInfo {
  layer: string
  path: string
  aliasOf?: string
  fileCount: number
  topLevelKeys?: string[]
  namespaces?: string[]
}

/**
 * List all i18n locale directories in the project, grouped by layer.
 */
export async function listLocaleDirs(projectDir?: string): Promise<LocaleDirInfo[]> {
  const dir = projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const format = getFormat(config.localeFileFormat)

  const results: LocaleDirInfo[] = []

  for (const localeDir of config.localeDirs) {
    if (localeDir.aliasOf) {
      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        aliasOf: localeDir.aliasOf,
        fileCount: 0,
        topLevelKeys: [],
      })
      continue
    }

    // A namespaced layout counts directories and reports the namespaces in
    // one; a flat one counts locale files and reports the keys in one.
    if (format.defaultLayout === 'namespaced') {
      let subDirs: string[] = []
      try { subDirs = await readdir(localeDir.path) } catch {}

      const sampleLocale = config.locales[0]
      let namespaces: string[] = []
      if (sampleLocale) {
        try {
          const entries = await resolveLocaleEntries(config, localeDir.layer, sampleLocale)
          namespaces = entries.map(e => e.namespace).filter((n): n is string => n !== null)
        } catch {}
      }

      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        fileCount: subDirs.length,
        namespaces,
      })
    } else {
      const files = await readdir(localeDir.path)
      const localeFiles = files.filter(f => format.extensions.some(ext => f.toLowerCase().endsWith(ext)))

      let topLevelKeys: string[] = []
      const sampleLocale = config.locales[0]
      if (sampleLocale !== undefined && localeFiles.length > 0) {
        try {
          const data = await readLocaleData(config, localeDir.layer, sampleLocale)
          topLevelKeys = Object.keys(data)
        } catch {}
      }

      results.push({
        layer: localeDir.layer,
        path: localeDir.path,
        fileCount: localeFiles.length,
        topLevelKeys,
      })
    }
  }

  return results
}

// ─── get_translations ─────────────────────────────────────────────

/**
 * One layer's answer: locale code → key → value.
 *
 * One thing the index signature cannot state: `compact` replaces the locale
 * entries with a single `byKey` one. A read the cap cut short does not use
 * this shape at all — see {@link getTranslations}.
 */
export type GetTranslationsResult = Record<string, Record<string, unknown>>

/**
 * What a read that named no layer answers with: one entry per layer defining at
 * least one of the keys, each holding exactly what a read of that layer alone
 * would have returned.
 */
export interface GetTranslationsByLayer extends PagedResult {
  byLayer: Record<string, GetTranslationsResult>
  /** Every layer that was read, the ones defining none of the keys included. */
  layersSearched: string[]
}

export type GetTranslationsOutcome = GetTranslationsResult | GetTranslationsByLayer

/** One layer's locale files, read once, with the keys this read asks of them. */
interface LayerSheets {
  layer: string
  sheets: Array<{ locale: string, data: Record<string, unknown> }>
  keys: string[]
}

/**
 * Get translation values for given key paths, from one layer or from every
 * layer that defines them.
 *
 * Either `keys` or `keyPrefix` has to be given. A read with neither has no
 * subject, and defaulting that to the whole layer is how a caller ends up
 * holding a megabyte it never asked for.
 */
export async function getTranslations(opts: {
  layer?: string
  locale: string
  keys?: string[]
  keyPrefix?: string
  compact?: boolean
  limit?: number
  offset?: number
  projectDir?: string
}): Promise<GetTranslationsOutcome> {
  const { layer, locale, keyPrefix } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const requestedKeys = opts.keys ?? []
  if (requestedKeys.length === 0 && (keyPrefix === undefined || keyPrefix === '')) {
    throw new ToolError(
      'Pass keys (the dot-path keys to read) or keyPrefix (a namespace to read every leaf key under). One of the two is required.',
      'EARG',
    )
  }

  const localesToRead = locale === '*'
    ? config.locales
    : (() => {
        const found = findLocaleImpl(config, locale)
        if (!found) {
          throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
        }
        return [found]
      })()

  const layersToRead = resolveLayersToScan(config, layer)

  const perLayer: LayerSheets[] = []
  for (const localeDir of layersToRead) {
    const sheets: LayerSheets['sheets'] = []
    for (const loc of localesToRead) {
      // A named layer keeps failing loudly on a locale file it has not got,
      // which is what a caller who named it means. Reading every layer cannot:
      // a layer without that locale is the normal case there, not a mistake.
      const data = layer === undefined
        ? await readLocaleDataIfPresent(config, localeDir.layer, loc)
        : await readLocaleData(config, localeDir.layer, loc)
      if (!data) continue
      sheets.push({ locale: loc.code, data })
    }
    perLayer.push({
      layer: localeDir.layer,
      sheets,
      keys: resolveReadKeys(sheets, requestedKeys, keyPrefix),
    })
  }

  const compact = opts.compact === true && locale === '*' && localesToRead.length > 1

  // The unit the cap counts is one (layer, key) pair, which for a named layer
  // is simply one key.
  const answering = layer === undefined ? perLayer.filter(definesAnyKey) : perLayer
  const { page, ...paging } = paginate(
    answering.flatMap(entry => entry.keys.map(key => ({ layer: entry.layer, key }))),
    opts,
  )

  const keysByLayer = new Map<string, string[]>()
  for (const pair of page) {
    const keys = keysByLayer.get(pair.layer)
    if (keys) keys.push(pair.key)
    else keysByLayer.set(pair.layer, [pair.key])
  }

  if (layer !== undefined) {
    const values = readValues(perLayer[0]?.sheets ?? [], keysByLayer.get(layer) ?? [], compact)
    // An uncapped read stays byte-for-byte the answer this operation always
    // gave. A capped one cannot: the flat shape is locale codes all the way
    // down, so a flag beside them would be read as a locale — it answers in
    // the layered shape instead, which has a place for the paging fields.
    if (!paging.truncated) return values
    return { byLayer: { [layer]: values }, layersSearched: [layer], ...paging }
  }

  const byLayer: Record<string, GetTranslationsResult> = {}
  for (const entry of answering) {
    const keys = keysByLayer.get(entry.layer)
    if (keys === undefined) continue
    byLayer[entry.layer] = readValues(entry.sheets, keys, compact)
  }

  return { byLayer, layersSearched: perLayer.map(entry => entry.layer), ...paging }
}

/**
 * The keys one layer is read for: the explicit list, plus every leaf key the
 * layer defines under `keyPrefix`. Sorted, so the window a limit returns is the
 * same window on the next call.
 */
function resolveReadKeys(
  sheets: LayerSheets['sheets'],
  keys: string[],
  keyPrefix?: string,
): string[] {
  if (keyPrefix === undefined || keyPrefix === '') return keys

  const found = new Set(keys)
  for (const sheet of sheets) {
    for (const key of getLeafKeys(sheet.data)) {
      if (key === keyPrefix || key.startsWith(`${keyPrefix}.`)) found.add(key)
    }
  }
  return [...found].sort()
}

/** True when the layer holds a value for at least one of the keys asked of it. */
function definesAnyKey(entry: LayerSheets): boolean {
  return entry.keys.some(key => entry.sheets.some(sheet => getNestedValue(sheet.data, key) !== undefined))
}

function readValues(
  sheets: LayerSheets['sheets'],
  keys: string[],
  compact: boolean,
): GetTranslationsResult {
  const values: GetTranslationsResult = {}
  for (const sheet of sheets) {
    values[sheet.locale] = Object.fromEntries(
      keys.map(k => [k, getNestedValue(sheet.data, k) ?? null]),
    )
  }
  return compact ? summarizeByKey(values, keys, sheets.length) : values
}

/** One row per key — how many locales hold a value — instead of every value. */
function summarizeByKey(
  values: GetTranslationsResult,
  keys: string[],
  localeCount: number,
): GetTranslationsResult {
  const byKey: Record<string, { status: string; totalPresent: number; empty?: string[]; missing?: string[] }> = {}
  for (const key of keys) {
    let present = 0
    const empty: string[] = []
    const missing: string[] = []
    for (const [code, row] of Object.entries(values)) {
      const val = row[key]
      if (val === undefined || val === null) {
        missing.push(code)
      } else if (val === '') {
        empty.push(code)
      } else {
        present++
      }
    }
    byKey[key] = {
      status: present === localeCount ? 'ok' : present > 0 ? 'partial' : 'missing',
      totalPresent: present,
      ...(empty.length > 0 && { empty }),
      ...(missing.length > 0 && { missing }),
    }
  }
  return { byKey } as unknown as GetTranslationsResult
}

// ─── get_missing_translations ──────────────────────────────────────

export interface MissingTranslationsResult {
  missing: Record<string, Record<string, string[]>>
  summary: {
    referenceLocale: string | LocaleRefInfo
    targetLocales: Array<string | LocaleRefInfo>
    layersScanned: string[]
    totalMissingKeys: number
    /** The step after this one, as the surface the call ran on phrases it. Present when there is one. */
    message?: string
  }
}

/**
 * The missing keys, capped. The unit is one key of one (layer, locale) pair —
 * the nested map flattened — while `summary.totalMissingKeys` stays the count
 * for the whole project.
 */
export interface MissingTranslationsPage extends MissingTranslationsResult, PagedResult {}

/**
 * Find translation keys that exist in the reference locale but are missing in other locales.
 */
export async function getMissingTranslations(opts: {
  layer?: string
  referenceLocale?: string
  targetLocales?: string[]
  locales?: string[]
  limit?: number
  offset?: number
  projectDir?: string
}): Promise<MissingTranslationsPage> {
  const { layer } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const refLocale = findReferenceLocaleOrThrow(config, opts.referenceLocale)

  const resolvedTargets = opts.targetLocales ?? opts.locales
  const targets = resolvedTargets
    ? resolvedTargets.map((code) => {
        const loc = findLocaleImpl(config, code)
        if (!loc) {
          throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
        }
        return loc
      })
    : config.locales.filter(l => l.code !== refLocale.code)

  const layersToScan = resolveLayersToScan(config, layer)

  const result: Record<string, Record<string, string[]>> = {}
  let totalMissing = 0

  for (const localeDir of layersToScan) {
    const refData = await readLocaleDataIfPresent(config, localeDir.layer, refLocale)
    if (!refData) continue

    const refKeys = getLeafKeys(refData).filter(k => {
      const v = getNestedValue(refData, k)
      return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
    })
    if (refKeys.length === 0) continue

    for (const target of targets) {
      let targetData: Record<string, unknown> = {}

      try {
        targetData = await readLocaleData(config, localeDir.layer, target)
      } catch {}

      const missing = refKeys.filter(k => {
        const v = getNestedValue(targetData, k)
        return v === undefined || v === '' || v === null
      })

      if (missing.length > 0) {
        (result[target.code] ??= {})[localeDir.layer] = missing
        totalMissing += missing.length
      }
    }
  }

  const flat: Array<{ locale: string, layer: string, key: string }> = []
  for (const [locale, byLayer] of Object.entries(result)) {
    for (const [scanned, keys] of Object.entries(byLayer)) {
      for (const key of keys) flat.push({ locale, layer: scanned, key })
    }
  }
  const { page, ...paging } = paginate(flat, opts)

  const missing: Record<string, Record<string, string[]>> = {}
  for (const entry of page) {
    const byLayer = missing[entry.locale] ??= {}
    const keys = byLayer[entry.layer] ??= []
    keys.push(entry.key)
  }

  return {
    missing,
    summary: {
      referenceLocale: localeRefInfo(refLocale),
      targetLocales: targets.map(localeRefInfo),
      layersScanned: layersToScan.map(d => d.layer),
      totalMissingKeys: totalMissing,
    },
    ...paging,
  }
}

// ─── empty translations ──────────────────────────────────────

export interface EmptyTranslationsResult {
  emptyKeys: Record<string, Record<string, string[]>>
  summary: {
    totalEmpty: number
    localesChecked: string[]
    layersChecked: string[]
  }
}

/**
 * Find translation keys that have empty string values in locale files.
 */
export async function findEmptyTranslations(opts: {
  layer?: string
  locale?: string
  projectDir?: string
}): Promise<EmptyTranslationsResult> {
  const { layer, locale } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  return collectEmptyTranslations(config, { layer, locale })
}

/**
 * The scan behind {@link findEmptyTranslations}, against a config the caller
 * already has.
 *
 * Separate so `getTranslationStatus` can embed the listing under its own
 * `--list-empty` flag without detecting the project a second time.
 */
export async function collectEmptyTranslations(
  config: I18nConfig,
  opts: { layer?: string, locale?: string },
): Promise<{
  emptyKeys: Record<string, Record<string, string[]>>
  summary: { totalEmpty: number, localesChecked: string[], layersChecked: string[] }
}> {
  const { layer, locale } = opts

  const localesToCheck = locale
    ? (() => {
        const loc = findLocaleImpl(config, locale)
        if (!loc) {
          throw new ToolError(
            `Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}`,
            'LOCALE_NOT_FOUND',
          )
        }
        return [loc]
      })()
    : config.locales

  const layersToScan = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToScan.length === 0) {
    if (layer) {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
  }

  const emptyKeys: Record<string, Record<string, string[]>> = {}
  let totalEmpty = 0

  for (const localeDir of layersToScan) {
    for (const loc of localesToCheck) {
      const data = await readLocaleDataIfPresent(config, localeDir.layer, loc)
      if (!data) continue

      const leafKeys = getLeafKeys(data)
      const empty = leafKeys.filter(k => getNestedValue(data, k) === '')

      if (empty.length > 0) {
        (emptyKeys[loc.code] ??= {})[localeDir.layer] = empty
        totalEmpty += empty.length
      }
    }
  }

  return {
    emptyKeys,
    summary: {
      totalEmpty,
      localesChecked: localesToCheck.map(l => l.code),
      layersChecked: layersToScan.map(d => d.layer),
    },
  }
}

// ─── search_translations ─────────────────────────────────────

/**
 * One key in one locale of one layer — the detail rows, returned when the
 * caller asks for them.
 */
export interface SearchMatch {
  layer: string
  locale: string
  key: string
  value: unknown
}

/**
 * One key, however many layers and locales define it — the row a search
 * returns by default.
 *
 * A key that exists in seven layers and thirty locales used to come back as
 * dozens of near-identical rows, which an agent pays for and then has to group
 * itself before it can answer the question it asked: does a translation for
 * this text already exist, and where. Grouped here instead, because `layers`
 * is the answer to the second half — one layer means reuse it, several mean
 * the key is already duplicated.
 */
export interface SearchKeyMatch {
  key: string
  /** Every searched layer that defines the key, in layer order. */
  layers: string[]
  /** What `locale` holds for the key. */
  value: unknown
  /**
   * Which locale `value` was read from: the reference locale where it defines
   * the key, otherwise the first searched locale that does.
   */
  locale: string
  /** How many of the searched locales define the key. */
  localeCount: number
}

/** How `query` is compared against a key path or a value. */
export type SearchMatchMode = 'contains' | 'exact' | 'fuzzy'

export interface SearchTranslationsResult {
  /**
   * One row per key by default; one row per key and locale when the caller
   * passed `includeLocales`.
   */
  matches: SearchKeyMatch[] | SearchMatch[]
  /**
   * How many rows matched, whichever shape they are in. Counted before any
   * limit applies, so it stays the size of the finding rather than the size of
   * the window returned.
   */
  totalMatches: number
}

/**
 * Everything a comparison should ignore when the question is whether a
 * translation for some text already exists: case, accents, punctuation and how
 * much whitespace sits between the words. "Save changes!" and "save  changes"
 * are the same phrase to whoever is deciding whether to reuse the key.
 */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * How much of two normalized strings is the same words (Sørensen–Dice over
 * tokens). Word order and the words neither side shares are what it ignores,
 * which is what "Save your changes" and "Changes saved" need it to ignore —
 * and what keeps "Save" away from "Delete".
 */
function tokenSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean))
  const right = new Set(b.split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared++
  }
  return (2 * shared) / (left.size + right.size)
}

/**
 * Where a fuzzy match stops being one. Fixed rather than a parameter: a caller
 * cannot calibrate a number it never sees the scores behind, and a threshold
 * that moves would make the same query answer differently between runs.
 */
const FUZZY_THRESHOLD = 0.6

/**
 * The comparison one search runs against every key path and value, built once
 * so the query is normalized once instead of per candidate.
 */
function buildMatcher(matchMode: SearchMatchMode, query: string): (candidate: string) => boolean {
  if (matchMode === 'contains') {
    const needle = query.toLowerCase()
    return candidate => candidate.toLowerCase().includes(needle)
  }

  const normalizedQuery = normalizeForMatch(query)
  if (matchMode === 'exact') {
    return candidate => normalizeForMatch(candidate) === normalizedQuery
  }

  return (candidate) => {
    if (normalizedQuery === '') return false
    const normalized = normalizeForMatch(candidate)
    // Containment first: a query that is one phrase of a longer value scores
    // low on token overlap and is still exactly what the caller meant.
    return normalized.includes(normalizedQuery)
      || tokenSimilarity(normalizedQuery, normalized) >= FUZZY_THRESHOLD
  }
}

/** One layer's file for one locale, read once and reused by both passes below. */
interface LocaleSheet {
  layer: string
  locale: string
  data: Record<string, unknown>
}

/**
 * Collapse the detail rows to one row per key.
 *
 * `layers` and `localeCount` are counted over every sheet in scope rather than
 * over the rows that matched: a key whose German value matched is still defined
 * in the other six layers, and that is the fact the caller is asking for.
 */
function groupMatchesByKey(
  matches: SearchMatch[],
  sheets: LocaleSheet[],
  referenceCode: string,
): SearchKeyMatch[] {
  const grouped: SearchKeyMatch[] = []

  for (const key of new Set(matches.map(match => match.key))) {
    const defining = sheets.filter(sheet => getNestedValue(sheet.data, key) !== undefined)
    // The reference locale is what a caller reads the value in; any locale that
    // has it beats reporting none at all when the reference locale does not.
    const source = defining.find(sheet => sheet.locale === referenceCode) ?? defining[0]
    if (!source) continue

    grouped.push({
      key,
      layers: [...new Set(defining.map(sheet => sheet.layer))],
      value: getNestedValue(source.data, key),
      locale: source.locale,
      localeCount: new Set(defining.map(sheet => sheet.locale)).size,
    })
  }

  return grouped
}

/**
 * The rows a search returns, capped. `totalMatches` counts every match the
 * project holds, whatever the cap let through.
 */
export interface SearchTranslationsPage extends SearchTranslationsResult, PagedResult {}

/**
 * Search translation files by key path or value.
 *
 * Returns one row per key. The detail rows — one per key and locale — are what
 * `includeLocales` asks for.
 */
export async function searchTranslations(opts: {
  query: string
  searchIn?: 'keys' | 'values' | 'both'
  matchMode?: SearchMatchMode
  includeLocales?: boolean
  layer?: string
  locale?: string
  limit?: number
  offset?: number
  projectDir?: string
}): Promise<SearchTranslationsPage> {
  const { query, layer, locale } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const mode = opts.searchIn ?? 'both'
  const matchMode = opts.matchMode ?? 'contains'
  const isMatch = buildMatcher(matchMode, query)

  const layersToSearch = (layer && layer !== '*')
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToSearch.length === 0) {
    if (layer && layer !== '*') {
      findLayerOrThrow(config, layer)
    }
    throw new ToolError('No locale directories found. Run discover to verify the project setup.', 'LAYER_NOT_FOUND')
  }

  const localesToSearch = locale
    ? (() => {
        const found = findLocaleImpl(config, locale)
        if (!found) {
          throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
        }
        return [found]
      })()
    : config.locales

  // The locale the grouped rows quote their value in. Resolved leniently: a
  // project whose default locale is missing from its own locale list still
  // searched fine before, and grouping is not the place to start refusing it.
  const referenceLocale = findLocaleImpl(config, locale ?? config.defaultLocale) ?? localesToSearch[0]

  // A normalized comparison run against thirty locales answers with the same
  // keys and a translation in a language the caller did not ask about, so the
  // two normalized modes compare against one locale: the requested one, or the
  // project default. Substring search keeps looking everywhere, because that is
  // what it did before and what finds a value by its German wording.
  const localesToMatch = matchMode === 'contains' || locale || !referenceLocale
    ? localesToSearch
    : [referenceLocale]
  const matchedCodes = new Set(localesToMatch.map(l => l.code))

  const sheets: LocaleSheet[] = []
  for (const localeDir of layersToSearch) {
    for (const loc of localesToSearch) {
      const data = await readLocaleDataIfPresent(config, localeDir.layer, loc)
      if (!data) continue
      sheets.push({ layer: localeDir.layer, locale: loc.code, data })
    }
  }

  const matches: SearchMatch[] = []

  for (const sheet of sheets) {
    if (!matchedCodes.has(sheet.locale)) continue

    for (const key of getLeafKeys(sheet.data)) {
      const value = getNestedValue(sheet.data, key)
      const valueStr = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')

      const keyMatch = (mode === 'keys' || mode === 'both') && isMatch(key)
      const valueMatch = (mode === 'values' || mode === 'both') && isMatch(valueStr)

      if (keyMatch || valueMatch) {
        matches.push({
          layer: sheet.layer,
          locale: sheet.locale,
          key,
          value,
        })
      }
    }
  }

  if (opts.includeLocales) {
    const detail = paginate(matches, opts)
    const { page, ...detailPaging } = detail
    return { matches: page, totalMatches: matches.length, ...detailPaging }
  }

  const grouped = groupMatchesByKey(matches, sheets, referenceLocale?.code ?? config.defaultLocale)
  const { page, ...paging } = paginate(grouped, opts)
  return { matches: page, totalMatches: grouped.length, ...paging }
}

// ─── list_namespaces ────────────────────────────────────────────

export interface NamespaceNode {
  keyCount: number
  children?: Record<string, NamespaceNode>
}

export interface ListNamespacesResult extends PagedResult {
  layers: Record<string, { namespaces: Record<string, NamespaceNode> }>
  /**
   * Top-level namespace nodes across every scanned layer, before the cap. The
   * unit the cap counts is one such node — a namespace brings its whole subtree.
   */
  totalNamespaces: number
}

/**
 * Build a prefix tree of all translation keys grouped by layer and namespace.
 * Useful for agents to browse available keys without guesswork.
 */
export async function listNamespaces(opts: {
  layer?: string
  locale?: string
  limit?: number
  offset?: number
  projectDir?: string
}): Promise<ListNamespacesResult> {
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  if (opts.layer && opts.layer !== '*') {
    findLayerOrThrow(config, opts.layer)
  }
  const layersToScan = (opts.layer && opts.layer !== '*')
    ? config.localeDirs.filter(d => d.layer === opts.layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  const localeToUse = opts.locale
    ? findLocaleImpl(config, opts.locale) ?? (() => {
        throw new ToolError(`Locale not found: "${opts.locale}". Available: ${config.locales.map(l => l.code).join(', ')}.`, 'LOCALE_NOT_FOUND')
      })()
    : findLocaleImpl(config, config.defaultLocale) ?? config.locales[0]

  if (!localeToUse) {
    throw new ToolError('No locales found in configuration.', 'LOCALE_NOT_FOUND')
  }

  const layers: Record<string, { namespaces: Record<string, NamespaceNode> }> = {}

  for (const ld of layersToScan) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, ld.layer, localeToUse)
    }
    catch {
      continue
    }

    const keys = getLeafKeys(data)
    if (keys.length === 0) continue

    const root: NamespaceNode = { keyCount: 0, children: {} }

    for (const key of keys) {
      const segments = key.split('.')
      let node = root
      for (const seg of segments) {
        if (!node.children) node.children = {}
        if (!node.children[seg]) {
          node.children[seg] = { keyCount: 0 }
        }
        node = node.children[seg]
      }
      node.keyCount++ // leaf count at terminal node
    }

    propagateCounts(root)

    layers[ld.layer] = { namespaces: root.children ?? {} }
  }

  const nodes: Array<{ layer: string, namespace: string, node: NamespaceNode }> = []
  for (const [layer, entry] of Object.entries(layers)) {
    for (const [namespace, node] of Object.entries(entry.namespaces)) {
      nodes.push({ layer, namespace, node })
    }
  }
  const { page, ...paging } = paginate(nodes, opts)

  const paged: Record<string, { namespaces: Record<string, NamespaceNode> }> = {}
  for (const entry of page) {
    (paged[entry.layer] ??= { namespaces: {} }).namespaces[entry.namespace] = entry.node
  }

  return { layers: paged, totalNamespaces: nodes.length, ...paging }
}

function propagateCounts(node: NamespaceNode): number {
  if (!node.children || Object.keys(node.children).length === 0) {
    return node.keyCount
  }

  let total = 0
  for (const child of Object.values(node.children)) {
    total += propagateCounts(child)
  }
  node.keyCount = total
  return total
}
