/**
 * GitLab Code Quality (CodeClimate) mapping — pure result-shape → issue-array
 * transforms, no I/O.
 *
 * Format contract (https://docs.gitlab.com/ci/testing/code_quality/):
 * every issue needs description, check_name, fingerprint, severity, and
 * location.path + location.lines.begin, where path is project-root-relative
 * (no leading `./`) and lines.begin is an integer ≥ 1.
 *
 * Fingerprints deliberately exclude line numbers so unrelated edits that
 * shift a usage do not churn findings as new/resolved in the MR widget.
 */

import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

import type { I18nConfig, LocaleDefinition } from '../config/types.js'

import type { UndefinedKeyFinding } from './ops-check.js'
import type { FindDuplicateKeysResult } from './ops-duplicates.js'
import type { MissingTranslationsResult } from './ops-read.js'
import type { TranslationStatusResult } from './ops-status.js'
import { findLocaleImpl, resolveReferenceLocale } from './shared.js'

export interface CodeQualityIssue {
  description: string
  check_name: string
  fingerprint: string
  severity: 'info' | 'minor' | 'major' | 'critical' | 'blocker'
  location: {
    path: string
    lines: { begin: number }
  }
}

const UNDEFINED_KEY_CHECK = 'i18n.undefined-key'
const ORPHAN_KEY_CHECK = 'i18n.orphan-key'
const MISSING_TRANSLATION_CHECK = 'i18n.missing-translation'
const INCOMPLETE_LOCALE_CHECK = 'i18n.incomplete-locale'
const UNCONSUMED_LAYER_CHECK = 'i18n.unconsumed-layer'
const DUPLICATE_KEY_CHECK = 'i18n.duplicate-key'

/** NUL-joined so no part can bleed into its neighbor (keys/paths never contain NUL). */
function fingerprintOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

/** Normalize to the report's path shape: forward slashes, no leading `./`. */
function toReportPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

/** GitLab rejects non-positive or fractional line numbers. */
function toLineBegin(line: number): number {
  return Math.max(1, Math.trunc(line))
}

/**
 * `check` findings → one issue per usage location. Uncertain findings are
 * not mapped: the widget has no "maybe" state, and a hard-looking finding
 * for an unverifiable key would train consumers to ignore the report.
 */
export function undefinedKeysToCodeQuality(undefinedKeys: UndefinedKeyFinding[]): CodeQualityIssue[] {
  const issues: CodeQualityIssue[] = []
  for (const finding of undefinedKeys) {
    for (const usage of finding.usages) {
      const path = toReportPath(usage.file)
      issues.push({
        description: `i18n key "${finding.key}" is referenced here but defined in no locale file of the consuming app's layers — it renders as the raw key at runtime.`,
        check_name: UNDEFINED_KEY_CHECK,
        fingerprint: fingerprintOf(UNDEFINED_KEY_CHECK, finding.key, path),
        severity: 'major',
        location: { path, lines: { begin: toLineBegin(usage.line) } },
      })
    }
  }
  return issues
}

/**
 * Orphan findings → one issue per key, anchored at the layer's
 * reference-locale file (line 1): orphans live in locale files, not code.
 * The fingerprint is anchor-independent (layer + key), so locale-file
 * renames or layout changes do not churn findings. Uncertain,
 * dynamic-matched, and misplaced keys are not part of `orphansByLayer`
 * and therefore never mapped.
 */
export function orphanKeysToCodeQuality(
  orphansByLayer: Record<string, string[]>,
  anchorFileByLayer: Record<string, string>,
): CodeQualityIssue[] {
  const issues: CodeQualityIssue[] = []
  for (const [layer, keys] of Object.entries(orphansByLayer)) {
    // A missing anchor (layer absent from config) degrades to the layer name
    // as path — the fingerprint is path-independent, so findings stay stable.
    const path = toReportPath(anchorFileByLayer[layer] ?? layer)
    for (const key of keys) {
      issues.push({
        description: `Orphan i18n key "${key}" in layer "${layer}" has no source-code reference — it may be consumed dynamically; verify before deleting.`,
        check_name: ORPHAN_KEY_CHECK,
        fingerprint: fingerprintOf(ORPHAN_KEY_CHECK, layer, key),
        severity: 'minor',
        location: { path, lines: { begin: 1 } },
      })
    }
  }
  return issues
}

/**
 * The orphan findings of a result — whatever the run was asked to do with
 * them — mapped and anchored in one call.
 *
 * Takes the result rather than the scan internals, which is what lets the
 * mapping run where the result is handed over instead of inside the operation.
 * A removal run reports what it deleted; either way the keys are the same set
 * the scan found, and nothing else in the result is a finding.
 */
export function orphanResultToCodeQuality(
  result: { orphanKeys?: Record<string, string[]>; removed?: Record<string, string[]> },
  ctx: { config: I18nConfig; projectDir: string; locale?: string },
): CodeQualityIssue[] {
  const orphansByLayer = result.orphanKeys ?? result.removed ?? {}
  const { localeDef } = resolveReferenceLocale(ctx.config, ctx.locale)
  return orphanKeysToCodeQuality(
    orphansByLayer,
    referenceLocaleAnchorPaths(ctx.config, Object.keys(orphansByLayer), localeDef, ctx.projectDir),
  )
}

/**
 * The locale file of one layer, or the layer name when the config has no path
 * for it. Every issue below anchors at a locale file rather than a call site:
 * these findings are about what a file holds, so there is no line to point at
 * and `lines.begin` is 1 throughout.
 */
function anchorPathOf(
  ctx: { config: I18nConfig; projectDir: string },
  layer: string,
  localeRef: string,
): string {
  const locale = findLocaleImpl(ctx.config, localeRef)
  const anchors = locale === undefined
    ? {}
    : referenceLocaleAnchorPaths(ctx.config, [layer], locale, ctx.projectDir)
  return toReportPath(anchors[layer] ?? layer)
}

/**
 * `missing` findings → one issue per key per locale, anchored at the locale file
 * of the layer that is short of it.
 *
 * Minor rather than major: a missing key falls back to another locale and
 * renders text, where an undefined key renders its own name at the user.
 */
export function missingTranslationsToCodeQuality(
  result: MissingTranslationsResult,
  ctx: { config: I18nConfig; projectDir: string },
): CodeQualityIssue[] {
  const issues: CodeQualityIssue[] = []
  for (const [localeCode, byLayer] of Object.entries(result.missing)) {
    const locale = findLocaleImpl(ctx.config, localeCode)
    // Resolved once per locale rather than per key: a locale short of a
    // thousand keys would otherwise walk the config a thousand times.
    const anchors = locale === undefined
      ? {}
      : referenceLocaleAnchorPaths(ctx.config, Object.keys(byLayer), locale, ctx.projectDir)

    for (const [layer, keys] of Object.entries(byLayer)) {
      const path = toReportPath(anchors[layer] ?? layer)
      for (const key of keys) {
        issues.push({
          description: `Missing translation for "${key}" in ${localeCode} — the reference locale defines it, layer "${layer}" does not carry it in this locale.`,
          check_name: MISSING_TRANSLATION_CHECK,
          fingerprint: fingerprintOf(MISSING_TRANSLATION_CHECK, layer, localeCode, key),
          severity: 'minor',
          location: { path, lines: { begin: 1 } },
        })
      }
    }
  }
  return issues
}

/**
 * `status` findings → one issue per locale under the bar, plus one per layer no
 * app consumes.
 *
 * The bar is `failUnder` when the caller named one and 100% otherwise, so the
 * report says what the gate says. A locale is `info`: coverage is a figure that
 * moves with every merge request and is not a defect. An unconsumed layer is
 * `minor` — keys nothing can render, which is a fact about the project rather
 * than about today's translation work.
 *
 * Protected locales are skipped. Their gaps are deliberate and already excluded
 * from the overall figure; reporting them would be reporting a decision.
 */
export function statusToCodeQuality(
  result: TranslationStatusResult,
  ctx: { config: I18nConfig; projectDir: string; failUnder?: number },
): CodeQualityIssue[] {
  const threshold = ctx.failUnder ?? 100
  // A locale's coverage spans every scanned layer, so no single file is behind
  // it; the first scanned layer is where the report stands to say so.
  const primaryLayer = result.summary.layersScanned[0] ?? ''
  const issues: CodeQualityIssue[] = []

  for (const locale of result.locales) {
    if (locale.protected === true || locale.completion >= threshold) continue
    issues.push({
      description: `Locale "${locale.code}" is ${locale.completion}% translated, below the ${threshold}% expected — ${locale.missing} key(s) missing, ${locale.empty} empty.`,
      check_name: INCOMPLETE_LOCALE_CHECK,
      // Neither the percentage nor the counts are part of this: a locale gaining
      // one key would otherwise resolve its finding and open a new one.
      fingerprint: fingerprintOf(INCOMPLETE_LOCALE_CHECK, locale.code),
      severity: 'info',
      location: {
        path: anchorPathOf(ctx, primaryLayer, locale.code) || locale.code,
        lines: { begin: 1 },
      },
    })
  }

  const referenceCode = result.summary.referenceLocale.code
  for (const layer of result.summary.unconsumedLayers) {
    issues.push({
      description: `Layer "${layer}" is consumed by no app — the keys it defines cannot render anywhere. Fold it into a consumed layer or declare the app that uses it.`,
      check_name: UNCONSUMED_LAYER_CHECK,
      fingerprint: fingerprintOf(UNCONSUMED_LAYER_CHECK, layer),
      severity: 'minor',
      location: { path: anchorPathOf(ctx, layer, referenceCode), lines: { begin: 1 } },
    })
  }

  return issues
}

/**
 * `find-duplicates` collisions → one issue per key defined in both a shared and
 * a consuming layer, anchored at the shadowing layer's file: that is the copy
 * whose value wins at runtime and the one a reader has to look at.
 *
 * Value duplicates (`byValue`) are not mapped. Two keys carrying the same text
 * are a consolidation opportunity, not a defect in the file, and the group has
 * no single key or layer to anchor a stable fingerprint on.
 */
export function duplicateKeysToCodeQuality(
  result: FindDuplicateKeysResult,
  ctx: { config: I18nConfig; projectDir: string; locale?: string },
): CodeQualityIssue[] {
  const { localeDef } = resolveReferenceLocale(ctx.config, ctx.locale)
  const anchors = referenceLocaleAnchorPaths(
    ctx.config,
    [...new Set(result.collisions.map(collision => collision.childLayer))],
    localeDef,
    ctx.projectDir,
  )

  return result.collisions.map(collision => ({
    description: `i18n key "${collision.key}" is defined in both "${collision.sharedLayer}" and "${collision.childLayer}"`
      + (collision.divergent
        ? ', with different values — the shared value never shows. Delete one side; never move the key.'
        : ', with the same value — the shared definition never shows. Delete one side; never move the key.'),
    check_name: DUPLICATE_KEY_CHECK,
    // Values are left out on purpose: rewording one side is not a new finding.
    fingerprint: fingerprintOf(DUPLICATE_KEY_CHECK, collision.sharedLayer, collision.childLayer, collision.key),
    severity: 'minor' as const,
    location: {
      path: toReportPath(anchors[collision.childLayer] ?? collision.childLayer),
      lines: { begin: 1 },
    },
  }))
}

/**
 * Project-root-relative reference-locale file path per layer, the anchor for
 * orphan issues. Aliases resolve to their target layer's directory. Flat
 * layouts anchor at the locale file; namespaced layouts (per-locale
 * directories) have no single file and anchor at the locale's directory.
 */
export function referenceLocaleAnchorPaths(
  config: I18nConfig,
  layers: string[],
  locale: LocaleDefinition,
  projectDir: string,
): Record<string, string> {
  const anchors: Record<string, string> = {}
  for (const layer of layers) {
    const localeDir = config.localeDirs.find(d => d.layer === layer)
    const resolved = localeDir?.aliasOf
      ? config.localeDirs.find(d => d.layer === localeDir.aliasOf) ?? localeDir
      : localeDir
    if (!resolved) continue
    const absPath = locale.file
      ? join(resolved.path, locale.file)
      : join(resolved.path, locale.code)
    anchors[layer] = toReportPath(relative(projectDir, absPath))
  }
  return anchors
}
