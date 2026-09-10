/**
 * Used-but-undefined key detection — the inverse of orphan scanning.
 *
 * A key referenced in source code but defined in no locale file of the
 * using app's consumed layers renders as a raw key at runtime. Nothing
 * else catches this direction (orphan scanning only computes
 * locale − code; this computes code − locale, per scan unit).
 */

import { detectI18nConfig } from '../config/detector.js'
import type { I18nConfig, LocaleDefinition } from '../config/types.js'
import { readLocaleData } from '../io/locale-data.js'
import { getLeafKeys } from '../io/key-operations.js'
import {
  scanSourceFiles,
  toRelativePath,
  buildDynamicKeyRegexes,
  buildIgnorePatternRegexes,
  nestedUnitIgnores,
} from '../scanner/code-scanner.js'
import type { DynamicKeyUsage, KeyUsage, ScanResult, ScanUnit } from '../scanner/code-scanner.js'
import { getPatternSet } from '../scanner/patterns.js'
import { ToolError } from '../utils/errors.js'

import { findWritableLayerOrThrow, resolveReferenceLocale } from './shared.js'
import { buildOrphanScanPlan, resolveDeclaredNamespaces, resolveOrphanIgnorePatterns } from './ops-orphans.js'
import { writeTranslations } from './ops-write.js'

export interface KeyUsageLocation {
  /** Source file path, relative to the project dir. */
  file: string
  line: number
}

export interface UndefinedKeyFinding {
  key: string
  /** Scan unit the usage lives in (app name, layer name, or project-root). */
  app: string
  /** Layers whose keys this unit can resolve — all were searched. */
  searchedLayers: string[]
  usages: KeyUsageLocation[]
}

export interface UncertainKeyFinding extends UndefinedKeyFinding {
  /** Why this is not a hard finding. */
  reason: string
}

/** The locale file `write` extracted the undefined keys into. */
export interface ExtractedUndefinedKeys {
  layer: string
  /** The project's default locale — the source every other locale is filled from. */
  locale: string
  /** The keys that reached the file, in alphabetical order. */
  keys: string[]
}

export interface CheckUndefinedKeysSummary {
  /** Distinct statically referenced keys across all scan units. */
  usedKeysChecked: number
  /**
   * Keys that render raw at runtime, which is what the gate reads. After a
   * `write` run this counts the ones still undefined: an extracted key now has
   * a definition — an empty one — so it resolves, and `status` reports it as an
   * empty translation instead.
   */
  undefinedCount: number
  /** Keys extracted into a locale file. Present only alongside `written`. */
  writtenCount?: number
  uncertainCount: number
  /** Unresolvable keys excluded by orphanScan ignorePatterns. */
  ignoredCount: number
  /** Unresolvable keys covered by a declaredNamespaces entry — defined by contract, never written. */
  declaredCount: number
  filesScanned: number
  /** Files a syntax frontend declined; pattern matching read them instead. */
  filesDeclined: number
  locale: string
  /** Scan unit → layers searched for that unit's key usages. */
  searchedLayersByApp: Record<string, string[]>
  message: string
}

export interface CheckUndefinedKeysResult {
  /**
   * The findings as the scan made them. A `write` run leaves them in place —
   * what was extracted is named in `written`, and the summary counts what is
   * left — because the call sites are what a reader has to visit either way.
   */
  undefinedKeys: UndefinedKeyFinding[]
  uncertainKeys: UncertainKeyFinding[]
  limitation: string
  /**
   * Present only when `write` was asked for and the scan found something to
   * write. A clean scan reports nothing here, having written nothing.
   */
  written?: ExtractedUndefinedKeys
  summary: CheckUndefinedKeysSummary
}

const CHECK_LIMITATION
  = 'Static extraction is line-based: dynamically built keys (template literals, string '
  + 'concatenation) cannot be verified and appear under uncertainKeys, never as hard findings. '
  + 'Multiline translation calls are only caught heuristically.'

const UNCERTAIN_DYNAMIC_USAGE
  = 'dynamically built key — no defined key matches its pattern, but static analysis cannot verify which concrete keys it produces'
const UNCERTAIN_DYNAMIC_OVERLAP
  = 'matches a dynamic key pattern used in this app — may be a partial extraction of that expression'
const UNCERTAIN_EXISTENCE_CHECK
  = 'referenced only via existence checks ($te) — likely a deliberately optional key'
const UNCERTAIN_NAMESPACED_KEY
  = 'package-namespaced key (namespace::group.key) — vendor language files outside the project cannot be resolved'
const UNCERTAIN_STRING_KEY
  = 'string-key (no dot-separated key-path shape) — Laravel/JSON-style translations render these as-is when unresolved'

/** Dot-separated identifier path; anything else is a JSON-style string-key. */
const KEY_PATH_SHAPE = /^[\w-]+(?:\.[\w-]+)+$/
/** Laravel package-namespace syntax: accounting::messages.invoice.total */
const NAMESPACED_KEY = /^[\w-]+::/

/** Existence-check callees probe whether a key is defined; a miss is handled by the caller. */
function isExistenceCheckCallee(callee: string): boolean {
  return callee === '$te' || callee === 'this.$te'
}

/**
 * All resolvable dot-paths of one layer in the reference locale: leaf keys
 * plus every ancestor prefix, so parent-node references (`$tm('a.b')`,
 * scoped `useI18n` roots) resolve too.
 */
async function layerKeyPaths(
  config: I18nConfig,
  layer: string,
  locale: LocaleDefinition,
): Promise<Set<string>> {
  // readLocaleData yields {} for missing files; real failures (parse errors,
  // permissions) must surface — reading them as "no keys" would flag every
  // key of that layer as undefined.
  const data = await readLocaleData(config, layer, locale)
  const paths = new Set<string>()
  for (const leaf of getLeafKeys(data)) {
    paths.add(leaf)
    let prefix = leaf
    for (let idx = prefix.lastIndexOf('.'); idx > 0; idx = prefix.lastIndexOf('.')) {
      prefix = prefix.slice(0, idx)
      if (paths.has(prefix)) break
      paths.add(prefix)
    }
  }
  return paths
}

function toLocations(usages: Array<{ file: string; line: number }>, projectDir: string): KeyUsageLocation[] {
  const seen = new Set<string>()
  const locations: KeyUsageLocation[] = []
  for (const u of usages) {
    const file = toRelativePath(u.file, projectDir)
    const id = `${file}:${u.line}`
    if (seen.has(id)) continue
    seen.add(id)
    locations.push({ file, line: u.line })
  }
  return locations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

const byAppThenKey = (a: { app: string; key: string }, b: { app: string; key: string }): number =>
  a.app.localeCompare(b.app) || a.key.localeCompare(b.key)

// ─── Scan planning ──────────────────────────────────────────────

interface CheckScanPlan {
  units: ScanUnit[]
  /** True with explicit scanDirs: every layer resolvable from every unit. */
  globalScope: boolean
  /**
   * Layers a unit's code can resolve = layers whose orphan-scan scope
   * includes the unit (for app units this equals layersOfApp plus layers
   * with degenerate all-unit scope; project-root resolves everything).
   */
  layersForUnit: (unitName: string) => string[]
}

function buildCheckScanPlan(config: I18nConfig, projectDir: string, scanDirs: string[] | undefined): CheckScanPlan {
  const allLayerNames = config.localeDirs.filter(d => !d.aliasOf).map(d => d.layer)

  // An empty scanDirs array means "not provided" (matches the orphan ops).
  if (scanDirs?.length) {
    return {
      units: scanDirs.map(d => ({ name: toRelativePath(d, projectDir) || '.', dir: d })),
      globalScope: true,
      layersForUnit: () => allLayerNames,
    }
  }

  const plan = buildOrphanScanPlan(config, projectDir)
  return {
    units: plan.units,
    globalScope: false,
    layersForUnit: unitName => allLayerNames.filter((layer) => {
      const scope = plan.scopeByLayer.get(layer)
      return !scope || scope.includes(unitName)
    }),
  }
}

// ─── Per-unit classification ────────────────────────────────────

interface UnitCheckContext {
  unitName: string
  searchedLayers: string[]
  resolvable: Set<string>
  ignoreRegexes: RegExp[]
  /** Declared namespaces, which hold in every layer rather than per layer. */
  declaredRegexes: RegExp[]
  projectDir: string
}

interface UnitCheckOutcome {
  undefinedKeys: UndefinedKeyFinding[]
  uncertainKeys: UncertainKeyFinding[]
  ignoredCount: number
  declaredCount: number
  checkedKeys: Set<string>
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  return groups
}

/**
 * Classify one unit's static keys: keys not resolvable in the searched
 * layers become undefined findings — unless a declared namespace covers
 * them, an ignore pattern excludes them, a dynamic pattern overlaps them
 * (possible partial extraction of a dynamic expression), or they are only
 * probed via $te.
 */
function classifyStaticKeys(
  usages: KeyUsage[],
  dynRegexes: RegExp[],
  ctx: UnitCheckContext,
  outcome: UnitCheckOutcome,
): void {
  for (const [key, keyUsages] of groupBy(usages, u => u.key)) {
    // Concat-prefix artifact: the static pattern also extracts the quoted
    // prefix of `t('some.prefix.' + x)`. A trailing dot can never be a real
    // key, and the concat usage is already covered as a dynamic expression.
    if (key.endsWith('.')) continue
    if (ctx.resolvable.has(key)) continue
    // Declared by contract: the definition lives wherever the contract does, so
    // the key is neither a finding nor something `write` may extract.
    if (ctx.declaredRegexes.some(re => re.test(key))) {
      outcome.declaredCount++
      continue
    }
    if (ctx.ignoreRegexes.some(re => re.test(key))) {
      outcome.ignoredCount++
      continue
    }
    if (dynRegexes.some(re => re.test(key))) {
      pushUncertain(outcome, ctx, key, keyUsages, UNCERTAIN_DYNAMIC_OVERLAP)
      continue
    }
    if (keyUsages.every(u => isExistenceCheckCallee(u.callee))) {
      pushUncertain(outcome, ctx, key, keyUsages, UNCERTAIN_EXISTENCE_CHECK)
      continue
    }
    // Two Laravel idioms are never hard findings: namespaced keys resolve in
    // vendor lang dirs this scan cannot see, and string-keys (JSON-style
    // full-sentence translations) legitimately render as-is when undefined.
    if (NAMESPACED_KEY.test(key)) {
      pushUncertain(outcome, ctx, key, keyUsages, UNCERTAIN_NAMESPACED_KEY)
      continue
    }
    if (!KEY_PATH_SHAPE.test(key)) {
      pushUncertain(outcome, ctx, key, keyUsages, UNCERTAIN_STRING_KEY)
      continue
    }
    outcome.undefinedKeys.push({
      key,
      app: ctx.unitName,
      searchedLayers: ctx.searchedLayers,
      usages: toLocations(keyUsages, ctx.projectDir),
    })
  }
}

/**
 * Dynamic usages whose pattern matches NO resolvable key are likely to
 * produce raw keys too — but unverifiable, so always uncertain.
 */
function classifyDynamicUsages(
  dynamicKeys: DynamicKeyUsage[],
  ctx: UnitCheckContext,
  outcome: UnitCheckOutcome,
): void {
  for (const [expression, usages] of groupBy(dynamicKeys, dk => dk.expression)) {
    const [regex] = buildDynamicKeyRegexes([{ expression }])
    if (!regex) continue // no interpolation — already handled as static
    if ([...ctx.resolvable].some(key => regex.test(key))) continue
    pushUncertain(outcome, ctx, expression, usages, UNCERTAIN_DYNAMIC_USAGE)
  }
}

function pushUncertain(
  outcome: UnitCheckOutcome,
  ctx: UnitCheckContext,
  key: string,
  usages: Array<{ file: string; line: number }>,
  reason: string,
): void {
  outcome.uncertainKeys.push({
    key,
    app: ctx.unitName,
    searchedLayers: ctx.searchedLayers,
    usages: toLocations(usages, ctx.projectDir),
    reason,
  })
}

/** Classify one unit's scan evidence (static keys, then dynamic usages). */
function classifyUnitUsages(scan: ScanResult, ctx: UnitCheckContext): UnitCheckOutcome {
  const outcome: UnitCheckOutcome = {
    undefinedKeys: [],
    uncertainKeys: [],
    ignoredCount: 0,
    declaredCount: 0,
    checkedKeys: new Set(scan.uniqueKeys),
  }

  // Dynamic evidence downgrades static findings to uncertain: bare
  // candidates are included here (conservative), but only located t()
  // dynamic calls are themselves reported as uncertain usages.
  const dynRegexes = buildDynamicKeyRegexes([
    ...scan.dynamicKeys,
    ...[...scan.bareDynamicCandidates].map(expression => ({ expression })),
  ])

  // A component's own `<i18n>` block is the definition of the keys it uses, so
  // those usages resolve without any locale file carrying them.
  const usages = scan.usages.filter(u => !scan.localDefinitions.get(u.file)?.has(u.key))

  classifyStaticKeys(usages, dynRegexes, ctx, outcome)
  classifyDynamicUsages(scan.dynamicKeys, ctx, outcome)
  return outcome
}

// ─── Extraction ─────────────────────────────────────────────────

/**
 * The layer the undefined keys are extracted into.
 *
 * The findings already carry the layers the using code resolves against, so
 * that is what decides: a project — or an app — with one such layer has exactly
 * one answer and needs no flag. Where the code resolves several, nothing in the
 * evidence says which of them a key belongs in; that is a judgement about the
 * project's topology, so the run refuses rather than writing keys into a layer
 * someone then has to move them out of.
 */
function resolveExtractionLayer(
  config: I18nConfig,
  findings: UndefinedKeyFinding[],
  requested: string | undefined,
): string {
  if (requested !== undefined) {
    findWritableLayerOrThrow(config, requested)
    return requested
  }

  const candidates = new Set(findings.flatMap(finding => finding.searchedLayers))
  // A scan unit that resolves no layer at all leaves nothing to read here; the
  // project's own layers are the candidates then, which is still one answer for
  // a single-layer project.
  if (candidates.size === 0) {
    for (const localeDir of config.localeDirs.filter(d => !d.aliasOf)) candidates.add(localeDir.layer)
  }

  const [only] = candidates
  if (candidates.size === 1 && only !== undefined) {
    findWritableLayerOrThrow(config, only)
    return only
  }

  throw new ToolError(
    `The undefined keys resolve against ${candidates.size} layers (${[...candidates].join(', ')}), so `
    + 'there is no single layer to write them into. Name the one they belong in: '
    + '--layer <name> at a terminal, layer over MCP.',
    'AMBIGUOUS_LAYER',
  )
}

function buildExtractionNote(written: ExtractedUndefinedKeys, skipped: number): string {
  const note = ` ${written.keys.length} key(s) written to layer "${written.layer}" as empty `
    + `${written.locale} translations — fill them in (status --listEmpty lists them).`
  return skipped === 0
    ? note
    : `${note} ${skipped} key(s) already had a value in that layer and were left untouched.`
}

/**
 * Write the undefined keys into one layer's default-locale file and account for
 * it in the result.
 *
 * The value is the empty string rather than the key: an empty value is the kit's
 * own "scaffolded, not filled in" state, so `status --listEmpty` lists exactly
 * these keys and a translate run fills the other locales once the source text is
 * written. Mode `add` is what keeps the run non-destructive — a key that already
 * has a value in that layer is skipped and stays a finding.
 */
async function extractUndefinedKeys(
  result: CheckUndefinedKeysResult,
  ctx: { config: I18nConfig; projectDir: string; layer?: string },
): Promise<CheckUndefinedKeysResult> {
  const layer = resolveExtractionLayer(ctx.config, result.undefinedKeys, ctx.layer)
  // Resolved rather than read off the config, so a default locale nothing
  // matches says so instead of writing every key into no file at all.
  const { localeCode } = resolveReferenceLocale(ctx.config)
  const keys = [...new Set(result.undefinedKeys.map(finding => finding.key))].sort()

  const write = await writeTranslations({
    layer,
    translations: Object.fromEntries(keys.map(key => [key, { [localeCode]: '' }])),
    mode: 'add',
    projectDir: ctx.projectDir,
  })

  const written: ExtractedUndefinedKeys = {
    layer,
    locale: localeCode,
    keys: [...new Set(write.written ?? [])].sort(),
  }
  const extracted = new Set(written.keys)
  const remaining = result.undefinedKeys.filter(finding => !extracted.has(finding.key)).length

  return {
    ...result,
    written,
    summary: {
      ...result.summary,
      undefinedCount: remaining,
      writtenCount: written.keys.length,
      message: buildCheckMessage(remaining, result.summary.uncertainCount)
        + buildExtractionNote(written, keys.length - written.keys.length),
    },
  }
}

function buildCheckMessage(undefinedCount: number, uncertainCount: number): string {
  const uncertainNote = uncertainCount > 0
    ? ` ${uncertainCount} reference(s) are uncertain (see uncertainKeys).`
    : ''
  if (undefinedCount === 0) {
    return 'All statically referenced keys resolve to a definition in their app\'s consumed layers.'
      + uncertainNote
  }
  return `${undefinedCount} key(s) are referenced in code but defined in no locale file of the `
    + 'using app\'s consumed layers — they render as raw keys at runtime.'
    + uncertainNote
}

// ─── Operation ──────────────────────────────────────────────────

/**
 * Find keys referenced in source code that resolve to no definition in the
 * using app's consumed layers (reference locale, default: project default).
 *
 * Mirrors the orphan scan's per-unit structure: with no explicit scanDirs,
 * the scope-aware plan from the layer graph decides which layers each scan
 * unit's code can resolve (the inversion of the orphan scan's
 * scopeByLayer — a unit resolves exactly the layers it vouches for). The
 * graph's degenerate semantics carry over: with no app info every layer is
 * resolvable everywhere, so only keys defined in NO layer are flagged.
 *
 * With `write`, the findings are also extracted into a locale file as empty
 * translations, which is what turns a report into the first half of the fix.
 */
export async function checkUndefinedKeys(opts: {
  locale?: string
  /**
   * Explicit scan roots — manual scope control. Every layer is treated as
   * resolvable from every scanned dir (global behavior, no per-app scoping).
   */
  scanDirs?: string[]
  excludeDirs?: string[]
  /** Extract the undefined keys into a locale file. See extractUndefinedKeys. */
  write?: boolean
  /** The layer to extract into, where the findings alone do not decide. */
  layer?: string
  projectDir?: string
} = {}): Promise<CheckUndefinedKeysResult> {
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  const { localeCode, localeDef } = resolveReferenceLocale(config, opts.locale)

  const pathsByLayer = new Map<string, Set<string>>()
  for (const localeDir of config.localeDirs.filter(d => !d.aliasOf)) {
    pathsByLayer.set(localeDir.layer, await layerKeyPaths(config, localeDir.layer, localeDef))
  }

  const { units, globalScope, layersForUnit } = buildCheckScanPlan(config, dir, opts.scanDirs)

  // Memoized per searched-layers signature — sibling units often share one.
  const resolvableCache = new Map<string, Set<string>>()
  const resolvablePaths = (layers: string[]): Set<string> => {
    const signature = layers.join(' ')
    let cached = resolvableCache.get(signature)
    if (!cached) {
      cached = new Set(layers.flatMap(layer => [...(pathsByLayer.get(layer) ?? [])]))
      resolvableCache.set(signature, cached)
    }
    return cached
  }

  const patterns = getPatternSet(config.localeFileFormat)
  const undefinedKeys: UndefinedKeyFinding[] = []
  const uncertainKeys: UncertainKeyFinding[] = []
  const searchedLayersByApp: Record<string, string[]> = {}
  const checkedKeys = new Set<string>()
  let filesScanned = 0
  let filesDeclined = 0
  let ignoredCount = 0
  let declaredCount = 0
  const declaredRegexes = buildIgnorePatternRegexes(
    resolveDeclaredNamespaces(config).map(declaration => declaration.pattern),
  )

  for (const unit of units) {
    const ignores = globalScope ? [] : nestedUnitIgnores(unit, units)
    const scan = await scanSourceFiles(unit.dir, [...(opts.excludeDirs ?? []), ...ignores], patterns)
    filesScanned += scan.filesScanned
    filesDeclined += scan.declinedFiles.length

    const searchedLayers = layersForUnit(unit.name)
    searchedLayersByApp[unit.name] = searchedLayers

    const outcome = classifyUnitUsages(scan, {
      unitName: unit.name,
      searchedLayers,
      resolvable: resolvablePaths(searchedLayers),
      ignoreRegexes: buildIgnorePatternRegexes(
        searchedLayers.flatMap(layer => resolveOrphanIgnorePatterns(config, layer) ?? []),
      ),
      declaredRegexes,
      projectDir: dir,
    })
    undefinedKeys.push(...outcome.undefinedKeys)
    uncertainKeys.push(...outcome.uncertainKeys)
    ignoredCount += outcome.ignoredCount
    declaredCount += outcome.declaredCount
    for (const key of outcome.checkedKeys) checkedKeys.add(key)
  }

  undefinedKeys.sort(byAppThenKey)
  uncertainKeys.sort(byAppThenKey)

  const summary: CheckUndefinedKeysSummary = {
    usedKeysChecked: checkedKeys.size,
    undefinedCount: undefinedKeys.length,
    uncertainCount: uncertainKeys.length,
    ignoredCount,
    declaredCount,
    filesScanned,
    filesDeclined,
    locale: localeCode,
    searchedLayersByApp,
    message: buildCheckMessage(undefinedKeys.length, uncertainKeys.length),
  }

  const result: CheckUndefinedKeysResult = {
    undefinedKeys,
    uncertainKeys,
    limitation: CHECK_LIMITATION,
    summary,
  }

  // Nothing found is nothing to write: a clean scan must not fail on an
  // ambiguous layer it never had to pick, which is what a pipeline running
  // `check --write` on every merge request would hit on its good days.
  if (opts.write !== true || undefinedKeys.length === 0) return result
  return await extractUndefinedKeys(result, { config, projectDir: dir, layer: opts.layer })
}
