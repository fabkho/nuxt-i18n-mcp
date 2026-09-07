/**
 * Orphan-key operations: find/remove translation keys that are not
 * referenced in source code, plus code-usage scanning.
 */

import { isAbsolute, relative } from 'node:path'

import { detectI18nConfig } from '../config/detector.js'
import { buildLayerGraph } from '../config/layer-graph.js'
import type { I18nConfig, LocaleDefinition, LocaleDir } from '../config/types.js'
import { readLocaleData, mutateLocaleData } from '../io/locale-data.js'
import { getLeafKeys, removeNestedValue } from '../io/key-operations.js'
import { scanSourceFiles, toRelativePath, findOrphanKeysForConfig, buildIgnorePatternRegexes } from '../scanner/code-scanner.js'
import type { OrphanScanPlan, OrphanScanProgress, OrphanScanResult } from '../scanner/code-scanner.js'
import { collectLinkedTargets } from '../scanner/linked-messages.js'
import { getPatternSet } from '../scanner/patterns.js'
import type { DeclaredNamespaceRef, FindOrphanKeysResult, RemoveOrphanKeysResult, CodeUsageResult, ProgressFn } from './types.js'
import { ToolError } from '../utils/errors.js'

import { log } from '../utils/logger.js'

import { findLayerOrThrow, resolveReferenceLocale } from './shared.js'

const MISPLACED_USAGE_NOTE
  = 'Keys referenced only from apps that do not consume their layer. '
  + 'Either the key belongs in a broader (shared) layer, or the usage is a bug. '
  + 'These keys are not counted as orphans and are never removed.'

const DECLARED_NAMESPACE_NOTE
  = 'Keys covered by a declaredNamespaces entry. They exist by contract rather than by a call site, '
  + 'so they are never reported as orphans and never removed. A declaration with no matchedKeys covers '
  + 'nothing in this catalog — either the namespace is gone or the pattern is wrong.'

const LINKED_NOTE
  = 'Keys referenced by `@:` from another message\'s value (a vue-i18n linked message). '
  + 'The reference resolves inside the app\'s merged message table, so it protects the key in every layer, '
  + 'whichever layer and whichever locale the linking value lives in. These keys are never reported as orphans and never removed.'

const CANDIDATE_ONLY_NOTE = 'These keys are protected only by the bare-candidate net: either a dotted string somewhere merely shares their name (often a comment or a data structure), or a call too ambiguous to commit to references them (a bare t(...) that could be anything). They are not offered for removal, but dead references hide here - verify before pruning.'

/** True when `child` equals `parent` or lies inside it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Build the scope-aware scan plan for orphan detection from the layer graph.
 *
 * Units are the distinct app root dirs plus canonical layer root dirs (each
 * scanned exactly once — nested unit dirs are carved out of ancestor scans).
 * Layer L's scope is its own layer root dir plus the root dirs of all apps
 * in `appsUsingLayer(L)`.
 *
 * Degenerate cases (no app info, or a layer consumed by no app) fall back to
 * ALL units — the whole-project behavior of the pre-scope-aware scan. Code
 * outside every unit (e.g. scripts/ in a monorepo scanned from its root) is
 * claimed by a synthetic project-root unit that counts for every layer, so
 * scoping never produces orphans the old global scan would not have.
 */
export function buildOrphanScanPlan(config: I18nConfig, projectDir: string): OrphanScanPlan {
  const graph = buildLayerGraph(config)
  const apps = config.apps ?? []

  const nameByDir = new Map<string, string>()
  const usedNames = new Set<string>()
  const claim = (dir: string, name: string): void => {
    if (nameByDir.has(dir)) return
    let unique = name
    let n = 2
    while (usedNames.has(unique)) unique = `${name}#${n++}`
    nameByDir.set(dir, unique)
    usedNames.add(unique)
  }

  // Apps claim first so a dir shared by an app and its layer reports the app name.
  for (const app of apps) claim(app.rootDir, app.name)
  for (const layer of graph.canonicalLayers) claim(layer.layerRootDir, layer.layer)

  let projectUnitName: string | undefined
  if (![...nameByDir.keys()].some(unitDir => isWithin(projectDir, unitDir))) {
    claim(projectDir, 'project-root')
    projectUnitName = nameByDir.get(projectDir)
  }

  const units = [...nameByDir].map(([dir, name]) => ({ name, dir }))
  const allNames = units.map(u => u.name)

  const scopeByLayer = new Map<string, string[]>()
  for (const layer of graph.canonicalLayers) {
    const consumers = graph.appsUsingLayer(layer.layer)
    if (apps.length === 0 || consumers.length === 0) {
      scopeByLayer.set(layer.layer, allNames)
      continue
    }
    const scope = new Set<string>()
    if (projectUnitName) scope.add(projectUnitName)
    scope.add(nameByDir.get(layer.layerRootDir)!)
    for (const appName of consumers) {
      const app = apps.find(a => a.name === appName)
      if (app) scope.add(nameByDir.get(app.rootDir)!)
    }
    scopeByLayer.set(layer.layer, [...scope])
  }

  return { units, scopeByLayer }
}

/**
 * Report shape for a dynamic-key entry. Bare candidates are synthesized
 * without a source location (file: '', line: 0) — relativizing '' would
 * resolve against the process cwd and make reports cwd-dependent, so
 * file/line are omitted entirely for them.
 */
function toDynamicKeyEntries(
  dynamicKeys: OrphanScanResult['allDynamicKeys'],
  projectDir: string,
): Array<{ expression: string; file?: string; line?: number }> {
  return dynamicKeys.map(dk => dk.file
    ? { expression: dk.expression, file: toRelativePath(dk.file, projectDir), line: dk.line }
    : { expression: dk.expression })
}

/** Relativize each layer's scan-scope dirs against the project dir for reporting. */
function relativeScanScope(result: OrphanScanResult, projectDir: string): Record<string, string[]> {
  const scanScope: Record<string, string[]> = {}
  for (const [layerName, dirs] of Object.entries(result.scanScopeByLayer)) {
    scanScope[layerName] = dirs.map(d => toRelativePath(d, projectDir) || '.')
  }
  return scanScope
}

/** What a surface passes in to watch a scan. Only MCP does; the CLI reports nothing. */
interface ScanProgressOptions {
  progressFn?: ProgressFn
  /** Called once with the number of progress steps, before the first `progressFn` call. */
  onProgressTotal?: (total: number) => void
}

/**
 * Most progress notifications one scan sends, whatever the project size.
 * A monorepo with 12k source files reporting each one would put more traffic
 * on the wire than the scan it describes, so files are reported in strides of
 * `ceil(total / MAX_PROGRESS_STEPS)`.
 */
const MAX_PROGRESS_STEPS = 100

/**
 * Adapt the scanner's per-file hooks to a surface's progress callbacks.
 *
 * The reporter on the other end counts calls rather than files, so the total
 * is announced in that same unit — one step per stride — and the last file
 * always reports, which is what makes the final step equal the total.
 *
 * `ProgressFn` is async while the scanner's hooks are not, so calls are
 * chained onto one promise: notifications keep the order the files completed
 * in, a failing notification cannot fail a scan, and `drain` waits for the
 * queue so no notification arrives after the result it describes.
 */
function scanProgress(opts: ScanProgressOptions): { progress?: OrphanScanProgress; drain: () => Promise<void> } {
  const { progressFn, onProgressTotal } = opts
  if (!progressFn && !onProgressTotal) return { drain: async () => {} }

  let queue: Promise<void> = Promise.resolve()
  let stride = 1

  return {
    progress: {
      onTotal: (total) => {
        stride = Math.max(1, Math.ceil(total / MAX_PROGRESS_STEPS))
        onProgressTotal?.(Math.ceil(total / stride))
      },
      onFile: (done, total, unit, file) => {
        if (!progressFn) return
        if (done % stride !== 0 && done !== total) return
        const message = `Scanning ${unit}: ${done}/${total} files (${file})`
        queue = queue.then(() => progressFn(message)).catch(() => {})
      },
    },
    drain: async () => { await queue },
  }
}

/**
 * Shared scan entry for findOrphanKeys/removeOrphanKeys: explicit scanDirs
 * keep the global combined-scan behavior; otherwise a scope-aware plan is
 * built from the layer graph.
 */
async function runOrphanScan(
  config: I18nConfig,
  keysByLayer: Map<string, { keys: string[]; localeDir: LocaleDir }>,
  opts: { scanDirs?: string[]; excludeDirs?: string[]; dir: string; linkedTargets: Set<string> } & ScanProgressOptions,
): Promise<OrphanScanResult> {
  const { progress, drain } = scanProgress(opts)
  const result = await findOrphanKeysForConfig({
    keysByLayer,
    linkedTargets: opts.linkedTargets,
    // an empty scanDirs array means "not provided" (matches excludeDirs)
    ...(opts.scanDirs?.length ? { scanDirs: opts.scanDirs } : { scanPlan: buildOrphanScanPlan(config, opts.dir) }),
    excludeDirs: opts.excludeDirs || undefined,
    resolveIgnorePatterns: layerName => resolveOrphanIgnorePatterns(config, layerName),
    declaredNamespaces: resolveDeclaredNamespaces(config).map(d => d.pattern),
    patterns: getPatternSet(config.localeFileFormat),
    progress,
  })
  await drain()
  return result
}

/**
 * `orphanScan` keys are matched against detected layer names — an unknown key
 * (e.g. keyed "lang" when the adapter names the layer "root") silently drops
 * its ignorePatterns, so warn on stderr listing the valid names (#265).
 */
function warnUnknownOrphanScanLayers(config: I18nConfig): void {
  const orphanScan = config.projectConfig?.orphanScan
  if (!orphanScan) return
  const layerNames = config.localeDirs.map(d => d.layer)
  const known = new Set(layerNames)
  for (const key of Object.keys(orphanScan)) {
    if (known.has(key)) continue
    log.warn(`orphanScan config key "${key}" matches no detected layer — its ignorePatterns are not applied. Detected layers: ${layerNames.join(', ')}`)
  }
}

export function resolveOrphanIgnorePatterns(
  config: I18nConfig,
  layer: string | undefined,
): string[] | undefined {
  if (!layer || !config.projectConfig?.orphanScan) return undefined
  const layerConfig = config.projectConfig.orphanScan[layer]
  if (!layerConfig?.ignorePatterns?.length) return undefined
  return layerConfig.ignorePatterns
}

/**
 * The declared namespaces of a project: key patterns that exist by contract
 * rather than by a call site. They are not keyed by layer — the contract
 * defines the key set, whichever layer happens to hold it.
 */
export function resolveDeclaredNamespaces(
  config: I18nConfig,
): Array<{ pattern: string; reason: string }> {
  return config.projectConfig?.declaredNamespaces ?? []
}

/**
 * Each declaration with the catalog keys it covers, so the report says which
 * keys a declaration protects and why — and, with an empty `matchedKeys`,
 * which declaration protects nothing at all.
 *
 * Coverage is read off the catalog rather than off the orphan list: a
 * namespace whose keys are also referenced in code still exists, and only a
 * declaration that matches no key anywhere is stale.
 */
function buildDeclaredNamespaceRefs(
  config: I18nConfig,
  keysByLayer: Map<string, { keys: string[]; localeDir: LocaleDir }>,
): DeclaredNamespaceRef[] | undefined {
  const declarations = resolveDeclaredNamespaces(config)
  if (declarations.length === 0) return undefined

  const allKeys = new Set<string>()
  for (const { keys } of keysByLayer.values()) {
    for (const key of keys) allKeys.add(key)
  }
  const sortedKeys = [...allKeys].sort(byCodePoint)

  return declarations.map(({ pattern, reason }) => {
    const [regex] = buildIgnorePatternRegexes([pattern])
    return {
      pattern,
      reason,
      matchedKeys: regex ? sortedKeys.filter(key => regex.test(key)) : [],
    }
  })
}

/**
 * Keys named by a linked message in the checked layers.
 *
 * Every locale is read, not just the reference one: a link is a property of
 * one translation's text, and a translator who wrote `@:a.b` in en-GB alone
 * still made `a.b` live for every app that renders that message. An
 * unreadable locale is skipped, the same as in the catalog read.
 */
async function collectLinkedMessageTargets(
  config: I18nConfig,
  layers: Iterable<string>,
): Promise<Set<string>> {
  const targets = new Set<string>()
  for (const layer of layers) {
    for (const localeDef of config.locales) {
      let data: Record<string, unknown>
      try {
        data = await readLocaleData(config, layer, localeDef)
      } catch {
        continue
      }
      collectLinkedTargets(data, targets)
    }
  }
  return targets
}

/**
 * Shared helper for findOrphanKeys and removeOrphanKeys.
 * Resolves the locale, filters layers, validates aliases, and builds the
 * keysByLayer Map. Returns the resolved context — or throws on invalid input.
 * The caller handles the empty-report case (totalKeys === 0).
 */
async function resolveOrphanScanContext(
  config: I18nConfig,
  opts: { layer?: string; locale?: string; dir: string },
): Promise<{
  layersToCheck: LocaleDir[]
  keysByLayer: Map<string, { keys: string[]; localeDir: LocaleDir }>
  linkedTargets: Set<string>
  totalKeys: number
  localeCode: string
  localeDef: LocaleDefinition
}> {
  const { localeCode, localeDef } = resolveReferenceLocale(config, opts.locale)

  const layersToCheck = opts.layer
    ? config.localeDirs.filter(d => d.layer === opts.layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layersToCheck.length === 0) {
    if (opts.layer) {
      findLayerOrThrow(config, opts.layer)
    }
    throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
  }

  if (opts.layer && layersToCheck[0]?.aliasOf) {
    throw new ToolError(
      `Layer "${opts.layer}" is an alias of "${layersToCheck[0].aliasOf}". Use the target layer instead.`,
      'LAYER_IS_ALIAS',
    )
  }

  const keysByLayer = new Map<string, { keys: string[]; localeDir: LocaleDir }>()
  for (const ld of layersToCheck) {
    let data: Record<string, unknown>
    try {
      data = await readLocaleData(config, ld.layer, localeDef)
    } catch {
      continue
    }
    if (Object.keys(data).length === 0) continue
    keysByLayer.set(ld.layer, { keys: getLeafKeys(data), localeDir: ld })
  }

  const totalKeys = [...keysByLayer.values()].reduce((sum, v) => sum + v.keys.length, 0)
  const linkedTargets = await collectLinkedMessageTargets(config, keysByLayer.keys())

  return { layersToCheck, keysByLayer, linkedTargets, totalKeys, localeCode, localeDef }
}

/**
 * Find translation keys that exist in locale files but are not referenced in source code.
 */
export async function findOrphanKeys(opts: {
  layer?: string
  locale?: string
  /**
   * Explicit scan roots — manual scope control. When set, all layers are
   * checked against one combined usage set from these dirs (no per-layer
   * scoping, no misplaced-usage detection). When absent, a scope-aware plan
   * from the layer graph is used: each layer is checked against the apps
   * that consume it.
   */
  scanDirs?: string[]
  excludeDirs?: string[]
  projectDir?: string
  /** Scanning every source file of every app takes seconds — a caller that asked for progress hears about each stride of files. */
  progressFn?: ProgressFn
  /** Called once with the number of progress steps, before the first `progressFn` call. */
  onProgressTotal?: (total: number) => void
}): Promise<FindOrphanKeysResult> {
  const { layer, locale, scanDirs, excludeDirs, progressFn, onProgressTotal } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  warnUnknownOrphanScanLayers(config)

  const { layersToCheck, keysByLayer, linkedTargets, totalKeys, localeCode } = await resolveOrphanScanContext(config, {
    layer,
    locale,
    dir,
  })

  if (totalKeys === 0) {
    return { orphanKeys: {}, summary: { totalKeys: 0, orphanCount: 0, filesScanned: 0, message: 'No translation keys found in locale files.' } }
  }

  const orphanResult = await runOrphanScan(config, keysByLayer, { scanDirs, excludeDirs, dir, linkedTargets, progressFn, onProgressTotal })

  const byLayer = orphanResult.orphansByLayer
  const allOrphanKeys: Array<{ key: string; layer: string }> = []
  for (const [layerName, keys] of Object.entries(byLayer)) {
    for (const key of keys) allOrphanKeys.push({ key, layer: layerName })
  }
  // Code-point order, not localeCompare: the report is diffed in CI, and ICU
  // collation differs between machines and treats "." as ignorable.
  allOrphanKeys.sort((a, b) => byCodePoint(a.layer, b.layer) || byCodePoint(a.key, b.key))
  const sortedByLayer: Record<string, string[]> = {}
  for (const { key, layer: keyLayer } of allOrphanKeys) {
    if (!sortedByLayer[keyLayer]) sortedByLayer[keyLayer] = []
    sortedByLayer[keyLayer].push(key)
  }

  const misplacedCount = orphanResult.misplacedUsages.length
  const declaredNamespaces = buildDeclaredNamespaceRefs(config, keysByLayer)
  const output: FindOrphanKeysResult = {
    orphanKeys: sortedByLayer,
    uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
    candidateOnlyKeys: orphanResult.candidateOnlyCount > 0 ? orphanResult.candidateOnlyByLayer : undefined,
    candidateOnlyNote: orphanResult.candidateOnlyCount > 0 ? CANDIDATE_ONLY_NOTE : undefined,
    linkedNote: orphanResult.linkedCount > 0 ? LINKED_NOTE : undefined,
    misplacedUsages: misplacedCount > 0 ? orphanResult.misplacedUsages : undefined,
    misplacedUsageNote: misplacedCount > 0 ? MISPLACED_USAGE_NOTE : undefined,
    declaredNamespaces,
    declaredNamespaceNote: declaredNamespaces ? DECLARED_NAMESPACE_NOTE : undefined,
    summary: {
      totalKeys,
      orphanCount: orphanResult.orphanCount,
      uncertainCount: orphanResult.uncertainCount,
      candidateOnlyCount: orphanResult.candidateOnlyCount,
      misplacedCount,
      dynamicMatchedCount: orphanResult.dynamicMatchedCount,
      ignoredCount: orphanResult.ignoredCount,
      declaredCount: orphanResult.declaredCount,
      linkedCount: orphanResult.linkedCount,
      usedCount: totalKeys - orphanResult.orphanCount - orphanResult.uncertainCount - misplacedCount,
      filesScanned: orphanResult.totalFilesScanned,
      filesDeclined: orphanResult.totalFilesDeclined,
      layersChecked: layersToCheck.map(d => d.layer),
      dirsScanned: orphanResult.dirsScanned,
      scanScope: relativeScanScope(orphanResult, dir),
      locale: localeCode,
    },
    dynamicKeyWarning: orphanResult.allDynamicKeys.length > 0
      ? `${orphanResult.allDynamicKeys.length} dynamic key reference(s) found (template literals with interpolation). Some "orphan" keys may actually be used via dynamic keys. Review before removing. Note: string concatenation patterns (e.g. 'prefix.' + var) are not detected — use template literals for full coverage.`
      : undefined,
    dynamicKeys: orphanResult.allDynamicKeys.length > 0
      ? toDynamicKeyEntries(orphanResult.allDynamicKeys, dir)
      : undefined,
    unresolvedKeyWarnings: orphanResult.unresolvedKeyWarnings.length > 0
      ? orphanResult.unresolvedKeyWarnings.map(w => ({
          expression: w.expression,
          file: toRelativePath(w.file, dir),
          line: w.line,
          callee: w.callee,
          suggestedIgnorePattern: w.suggestedIgnorePattern,
        }))
      : undefined,
  }

  return output
}

/**
 * Scan Vue/TS source files to find where translation keys are referenced.
 */
export async function scanCodeUsage(opts: {
  keys?: string[]
  scanDirs?: string[]
  excludeDirs?: string[]
  projectDir?: string
}): Promise<CodeUsageResult> {
  const { keys, scanDirs, excludeDirs } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)

  const dirsToScan = scanDirs ?? config.layerRootDirs

  const allUsages: Array<{ key: string; file: string; line: number; callee: string }> = []
  const allDynamicKeys: Array<{ expression: string; file: string; line: number; callee: string }> = []
  let totalFilesScanned = 0
  let totalFilesDeclined = 0

  for (const scanDir of dirsToScan) {
    const result = await scanSourceFiles(scanDir, excludeDirs, getPatternSet(config.localeFileFormat))
    totalFilesScanned += result.filesScanned
    totalFilesDeclined += result.declinedFiles.length
    allUsages.push(...result.usages)
    allDynamicKeys.push(...result.dynamicKeys)
  }

  const filteredUsages = keys
    ? allUsages.filter(u => keys.includes(u.key))
    : allUsages

  const byKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
  for (const usage of filteredUsages) {
    (byKey[usage.key] ??= []).push({
      file: toRelativePath(usage.file, dir),
      line: usage.line,
      callee: usage.callee,
    })
  }

  const sortedByKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
  for (const [key, locations] of Object.entries(byKey).sort(([a], [b]) => byCodePoint(a, b))) {
    sortedByKey[key] = locations
  }

  const notFound = keys
    ? keys.filter(k => !byKey[k])
    : []

  const output: CodeUsageResult = {
    usages: sortedByKey,
    summary: {
      uniqueKeysFound: Object.keys(sortedByKey).length,
      totalReferences: filteredUsages.length,
      filesScanned: totalFilesScanned,
      filesDeclined: totalFilesDeclined,
      dirsScanned: dirsToScan,
    },
  }

  if (notFound.length > 0) {
    output.notFoundInCode = notFound
  }

  if (allDynamicKeys.length > 0) {
    output.dynamicKeys = allDynamicKeys.map(dk => ({
      expression: dk.expression,
      file: toRelativePath(dk.file, dir),
      line: dk.line,
    }))
  }

  return output
}

/**
 * Find translation keys not referenced in source code and remove them.
 */
export async function removeOrphanKeys(opts: {
  layer?: string
  locale?: string
  /** Explicit scan roots — manual scope control, same semantics as {@link findOrphanKeys}. */
  scanDirs?: string[]
  excludeDirs?: string[]
  dryRun?: boolean
  projectDir?: string
  /** Same scan as {@link findOrphanKeys}, same reporting. */
  progressFn?: ProgressFn
  /** Called once with the number of progress steps, before the first `progressFn` call. */
  onProgressTotal?: (total: number) => void
}): Promise<RemoveOrphanKeysResult> {
  const { layer, locale, scanDirs, excludeDirs, progressFn, onProgressTotal } = opts
  const dir = opts.projectDir ?? process.cwd()
  const config = await detectI18nConfig(dir)
  warnUnknownOrphanScanLayers(config)
  const isDryRun = opts.dryRun ?? true

  const { keysByLayer, linkedTargets, totalKeys } = await resolveOrphanScanContext(config, {
    layer,
    locale,
    dir,
  })

  if (totalKeys === 0) {
    return { orphanKeys: {}, removed: {}, summary: { totalKeys: 0, orphanCount: 0, message: 'No translation keys found.' } }
  }

  const orphanResult = await runOrphanScan(config, keysByLayer, { scanDirs, excludeDirs, dir, linkedTargets, progressFn, onProgressTotal })
  const orphansByLayer = orphanResult.orphansByLayer
  const orphanCount = orphanResult.orphanCount
  const totalFilesScanned = orphanResult.totalFilesScanned
  const dynamicMatchedCount = orphanResult.dynamicMatchedCount
  const ignoredCount = orphanResult.ignoredCount
  const declaredCount = orphanResult.declaredCount
  const linkedCount = orphanResult.linkedCount
  const misplacedCount = orphanResult.misplacedUsages.length
  const misplacedUsages = misplacedCount > 0 ? orphanResult.misplacedUsages : undefined
  const misplacedUsageNote = misplacedCount > 0 ? MISPLACED_USAGE_NOTE : undefined
  const declaredNamespaces = buildDeclaredNamespaceRefs(config, keysByLayer)
  const declaredNamespaceNote = declaredNamespaces ? DECLARED_NAMESPACE_NOTE : undefined
  const scanScope = relativeScanScope(orphanResult, dir)
  const allDynamicKeys = toDynamicKeyEntries(orphanResult.allDynamicKeys, dir)

  if (orphanCount === 0) {
    const messageParts: string[] = ['No orphan keys found.']
    if (dynamicMatchedCount > 0) messageParts.push(`${dynamicMatchedCount} key(s) were excluded by dynamic pattern matching.`)
    if (ignoredCount > 0) messageParts.push(`${ignoredCount} key(s) were excluded by ignore patterns.`)
    if (declaredCount > 0) messageParts.push(`${declaredCount} key(s) were excluded by declared namespaces (see declaredNamespaces).`)
    if (linkedCount > 0) messageParts.push(`${linkedCount} key(s) were excluded because another message's value links to them with @:.`)
    if (orphanResult.uncertainCount > 0) messageParts.push(`${orphanResult.uncertainCount} uncertain key(s) were excluded because they overlap with dynamic translation patterns.`)
    if (misplacedCount > 0) messageParts.push(`${misplacedCount} key(s) are referenced only outside their layer's scope (see misplacedUsages).`)
    if (dynamicMatchedCount === 0 && ignoredCount === 0 && declaredCount === 0 && linkedCount === 0 && orphanResult.uncertainCount === 0 && misplacedCount === 0) messageParts.push('All translation keys are referenced in code.')
    const zeroOutput: RemoveOrphanKeysResult = {
      orphanKeys: {},
      uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
      misplacedUsages,
      misplacedUsageNote,
      declaredNamespaces,
      declaredNamespaceNote,
      summary: { totalKeys, orphanCount: 0, uncertainCount: orphanResult.uncertainCount, misplacedCount, dynamicMatchedCount, ignoredCount, declaredCount, linkedCount, filesScanned: totalFilesScanned, scanScope, message: messageParts.join(' ') },
    }
    return zeroOutput
  }

  // Dry run — just report
  if (isDryRun) {
    const output: RemoveOrphanKeysResult = {
      orphanKeys: orphansByLayer,
      uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
      misplacedUsages,
      misplacedUsageNote,
      declaredNamespaces,
      declaredNamespaceNote,
      summary: {
        dryRun: true,
        totalKeys,
        orphanCount,
        uncertainCount: orphanResult.uncertainCount,
        misplacedCount,
        dynamicMatchedCount,
        ignoredCount,
        declaredCount,
        linkedCount,
        usedCount: totalKeys - orphanCount - orphanResult.uncertainCount - misplacedCount,
        filesScanned: totalFilesScanned,
        scanScope,
        message: `Found ${orphanCount} orphan key(s) safe to remove.${orphanResult.uncertainCount > 0 ? ` ${orphanResult.uncertainCount} uncertain key(s) excluded (overlap with dynamic translation patterns).` : ''}${misplacedCount > 0 ? ` ${misplacedCount} key(s) referenced only outside their layer's scope were excluded (see misplacedUsages).` : ''} ${dynamicMatchedCount > 0 ? `${dynamicMatchedCount} key(s) matched dynamic patterns and were excluded. ` : ''}${ignoredCount > 0 ? `${ignoredCount} key(s) matched ignore patterns and were excluded. ` : ''}${declaredCount > 0 ? `${declaredCount} key(s) are covered by declared namespaces and were excluded. ` : ''}${linkedCount > 0 ? `${linkedCount} key(s) are linked from another message's value with @: and were excluded. ` : ''}Call again with dryRun: false to remove them.`,
      },
    }
    if (allDynamicKeys.length > 0) {
      output.dynamicKeyWarning = `${allDynamicKeys.length} dynamic key reference(s) found. Some "orphan" keys may be used via dynamic keys. Review before removing. Note: string concatenation patterns (e.g. 'prefix.' + var) are not detected — use template literals for full coverage.`
      output.dynamicKeys = allDynamicKeys
    }
    if (orphanResult.unresolvedKeyWarnings.length > 0) {
      output.unresolvedKeyWarnings = orphanResult.unresolvedKeyWarnings.map(w => ({
        expression: w.expression,
        file: toRelativePath(w.file, dir),
        line: w.line,
        callee: w.callee,
        suggestedIgnorePattern: w.suggestedIgnorePattern,
      }))
    }
    return output
  }

  // Actual removal
  const removedByLayer: Record<string, string[]> = {}
  let totalFilesWritten = 0

  for (const [layerName, orphans] of Object.entries(orphansByLayer)) {
    const ld = config.localeDirs.find(d => d.layer === layerName)!
    if (ld.aliasOf) continue

    for (const localeDef2 of config.locales) {
      try {
        const written = await mutateLocaleData(config, layerName, localeDef2, (fileData) => {
          for (const key of orphans) {
            removeNestedValue(fileData, key)
          }
        })
        totalFilesWritten += written.size
      } catch {
        continue
      }
    }

    removedByLayer[layerName] = orphans
  }

  const removalOutput: RemoveOrphanKeysResult = {
    removed: removedByLayer,
    uncertainKeys: orphanResult.uncertainCount > 0 ? orphanResult.uncertainByLayer : undefined,
    misplacedUsages,
    misplacedUsageNote,
    declaredNamespaces,
    declaredNamespaceNote,
    summary: {
      dryRun: false,
      totalKeys,
      removedCount: orphanCount,
      uncertainCount: orphanResult.uncertainCount,
      misplacedCount,
      dynamicMatchedCount,
      ignoredCount,
      declaredCount,
      linkedCount,
      remainingCount: totalKeys - orphanCount,
      filesWritten: totalFilesWritten,
      filesScanned: totalFilesScanned,
      scanScope,
    },
  }

  return removalOutput
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
