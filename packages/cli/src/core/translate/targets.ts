/**
 * Target-locale resolution for the translate operations: which locales a run
 * writes to, and which are withheld because they are protected.
 */

import type { I18nConfig, LocaleDefinition } from '../../config/types.js'
import { readLocaleData } from '../../io/locale-data.js'
import { log } from '../../utils/logger.js'
import { ToolError } from '../../utils/errors.js'

import type {
  TranslateMode,
  TranslateSkipReason,
  TranslateMissingLocaleResult,
} from './run.js'
import { findLocaleImpl } from '../shared.js'

/**
 * Resolve the config's `protectedLocales` entries (any locale ref: code,
 * language tag, or file name) against the known locales. Entries that do not
 * match a known locale are ignored with a warning. Returns the resolved
 * definitions, deduplicated by canonical code.
 */
export function resolveProtectedLocales(config: I18nConfig): LocaleDefinition[] {
  const refs = config.projectConfig?.protectedLocales ?? []
  const resolved = new Map<string, LocaleDefinition>()
  for (const ref of refs) {
    const locale = findLocaleImpl(config, ref)
    if (!locale) {
      log.warn(
        `protectedLocales entry "${ref}" does not match any known locale — ignoring. `
        + `Available: ${config.locales.map(l => l.code).join(', ')}`,
      )
      continue
    }
    if (!resolved.has(locale.code)) {
      resolved.set(locale.code, locale)
    }
  }
  return [...resolved.values()]
}

function warnProtectedOverride(code: string): void {
  log.warn(`Locale "${code}" is protected (protectedLocales) — translating anyway because it was explicitly requested via targetLocales.`)
}

/**
 * Resolve translate_missing target locales. Protected locales are excluded
 * from the DEFAULT target set (returned separately so the caller can report
 * them as skipped); naming one explicitly in targetLocales overrides the
 * protection with a warning.
 */
export function resolveTranslateTargets(
  config: I18nConfig,
  refLocale: LocaleDefinition,
  requested: string[] | undefined,
): { targets: LocaleDefinition[], protectedDefaults: LocaleDefinition[] } {
  const protectedCodes = new Set(resolveProtectedLocales(config).map(l => l.code))
  if (requested) {
    const targets = requested.map((code) => {
      const loc = findLocaleImpl(config, code)
      if (!loc) {
        throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
      }
      if (protectedCodes.has(loc.code)) {
        warnProtectedOverride(loc.code)
      }
      return loc
    })
    return { targets, protectedDefaults: [] }
  }
  const defaults = config.locales.filter(l => l.code !== refLocale.code)
  return {
    targets: defaults.filter(l => !protectedCodes.has(l.code)),
    protectedDefaults: defaults.filter(l => protectedCodes.has(l.code)),
  }
}

/**
 * Build result entries for protected locales withheld from the default
 * target set of translate_missing — callers see what was NOT translated
 * and the totals stay meaningful.
 */
export async function collectProtectedLocaleResults(
  config: I18nConfig,
  layer: string,
  mode: TranslateMode,
  protectedDefaults: LocaleDefinition[],
  missingKeysIn: (data: Record<string, unknown>) => string[],
): Promise<Record<string, TranslateMissingLocaleResult>> {
  const results: Record<string, TranslateMissingLocaleResult> = {}
  for (const locale of protectedDefaults) {
    let data: Record<string, unknown> = {}
    try {
      data = await readLocaleData(config, layer, locale)
    } catch {}
    const missingKeys = missingKeysIn(data)
    if (missingKeys.length === 0) continue
    results[locale.code] = {
      mode,
      missing: missingKeys.length,
      translated: [],
      failed: [],
      skipped: missingKeys.map(key => ({ key, reason: 'protected-locale' as const })),
    }
  }
  return results
}

/**
 * Build the translate_key target list (deduplicated, source locale removed).
 * Protected locales are excluded from the default 'all' target set and
 * returned as skipped entries; naming one explicitly overrides the
 * protection with a warning.
 */
export function partitionTranslateKeyTargets(
  config: I18nConfig,
  resolved: LocaleDefinition[],
  sourceCode: string,
  usesDefaultTargets: boolean,
): { targetLocales: LocaleDefinition[], protectedSkipped: Array<{ locale: string, reason: TranslateSkipReason }> } {
  const protectedCodes = new Set(resolveProtectedLocales(config).map(l => l.code))
  const byCode = new Map<string, LocaleDefinition>()
  const protectedSkipped: Array<{ locale: string, reason: TranslateSkipReason }> = []
  for (const locale of resolved) {
    if (locale.code === sourceCode || byCode.has(locale.code)) continue
    if (protectedCodes.has(locale.code)) {
      if (usesDefaultTargets) {
        protectedSkipped.push({ locale: locale.code, reason: 'protected-locale' })
        continue
      }
      warnProtectedOverride(locale.code)
    }
    byCode.set(locale.code, locale)
  }
  return { targetLocales: [...byCode.values()], protectedSkipped }
}
