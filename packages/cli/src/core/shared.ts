/**
 * Shared locale/layer lookup helpers used across the core operation modules.
 */

import type { I18nConfig, LocaleDefinition, LocaleDir } from '../config/types.js'
import { ToolError } from '../utils/errors.js'

import type { LocaleRefInfo } from './types.js'

/**
 * Look up a locale directory by layer name and throw LAYER_NOT_FOUND with fuzzy
 * matching hints if the name is not found.
 */
export function findLayerOrThrow(config: I18nConfig, layer: string): LocaleDir {
  const localeDir = config.localeDirs.find(d => d.layer === layer)
  if (!localeDir) {
    const available = config.localeDirs.map(d => d.layer).join(', ')
    const layerRule = config.projectConfig?.layerRules?.find(r => r.layer === layer)
    const fuzzyHint = layerRule
      ? ` Note: "${layer}" matches a layerRules entry in .i18n-mcp.json but is not an internal layer name.`
      : ''
    throw new ToolError(
      `Layer not found: "${layer}". Available: ${available}.${fuzzyHint} Use discover to see all layers.`,
      'LAYER_NOT_FOUND',
    )
  }
  return localeDir
}

/**
 * Look up a layer that will be written to: same as findLayerOrThrow, but also
 * rejects alias layers (writes must target the source layer).
 */
export function findWritableLayerOrThrow(config: I18nConfig, layer: string): LocaleDir {
  const localeDir = findLayerOrThrow(config, layer)
  if (localeDir.aliasOf) {
    throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
  }
  return localeDir
}

/**
 * Resolve the reference locale (requested or project default) and throw
 * REFERENCE_LOCALE_NOT_FOUND when it does not exist.
 */
export function findReferenceLocaleOrThrow(config: I18nConfig, requested?: string): LocaleDefinition {
  const refCode = requested ?? config.defaultLocale
  const refLocale = findLocaleImpl(config, refCode)
  if (!refLocale) {
    throw new ToolError(`Reference locale not found: "${refCode}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass a valid locale code as referenceLocale, or omit it to use the project default.`, 'REFERENCE_LOCALE_NOT_FOUND')
  }
  return refLocale
}

/**
 * The locale directories an operation should scan: one named layer, or every
 * non-alias layer. Alias layers are skipped because they point at another
 * layer's files, so scanning both would count the same keys twice.
 *
 * Throws rather than returning empty: an operation with nothing to scan has no
 * meaningful result, and a mistyped layer name should say so.
 */
export function resolveLayersToScan(config: I18nConfig, layer?: string): LocaleDir[] {
  const layers = layer
    ? config.localeDirs.filter(d => d.layer === layer)
    : config.localeDirs.filter(d => !d.aliasOf)

  if (layers.length === 0) {
    // Surfaces the better "layer not found, here are the valid ones" error.
    if (layer) findLayerOrThrow(config, layer)
    throw new ToolError(
      'No locale directories found. Run discover to verify the project setup.',
      'LAYER_NOT_FOUND',
    )
  }
  return layers
}

export function localeRefInfo(locale: LocaleDefinition): LocaleRefInfo {
  return {
    code: locale.code,
    ...(locale.language ? { language: locale.language } : {}),
    ...(locale.file ? { file: locale.file } : {}),
    ...(locale.name ? { name: locale.name } : {}),
  }
}

function localeAcceptedRefs(locale: LocaleDefinition): string[] {
  // Deduped: code and language are frequently the same string (a generic
  // adapter derives both from the filename), and "de" or "de" or "de.json"
  // reads like a bug in the suggestion rather than one locale's three refs.
  return [...new Set([locale.code, locale.language, locale.file].filter(Boolean) as string[])]
}

function formatLocaleChoices(locales: LocaleDefinition[]): string {
  return locales
    .map(locale => `- code: ${locale.code}${locale.language ? `, language: ${locale.language}` : ''}${locale.file ? `, file: ${locale.file}` : ''}${locale.name ? `, name: ${locale.name}` : ''}`)
    .join('\n')
}

const stripJson = (ref: string) => (ref.endsWith('.json') ? ref.slice(0, -5) : ref)

/**
 * How well one of a locale's refs matches the requested one. Higher wins.
 * Ranking matters rather than first-match: for "de-DE-formal", the informal
 * `de` locale matches by containment (its language is `de-DE`) while the
 * formal one matches exactly once `.json` is stripped from its file name.
 * First-match order returned `de`, pointing the caller at the wrong locale —
 * following that hint would write formal German into the informal file (#301).
 */
function suggestionScore(locale: LocaleDefinition, normalized: string): number {
  let best = 0
  for (const ref of localeAcceptedRefs(locale)) {
    const candidate = stripJson(ref)
    if (candidate === normalized) return 3
    if (candidate.toLowerCase() === normalized.toLowerCase()) best = Math.max(best, 2)
    else if (candidate.includes(normalized) || normalized.includes(candidate)) best = Math.max(best, 1)
  }
  return best
}

export function findLocaleSuggestion(config: I18nConfig, localeRef: string): string {
  const normalized = stripJson(localeRef)

  let suggestion: LocaleDefinition | undefined
  let bestScore = 0
  for (const locale of config.locales) {
    const score = suggestionScore(locale, normalized)
    if (score > bestScore) {
      bestScore = score
      suggestion = locale
    }
  }
  if (!suggestion) return ''

  const refs = localeAcceptedRefs(suggestion).map(ref => `"${ref}"`).join(' or ')
  return ` Did you mean ${refs}?`
}

/** Fields a locale ref may match, in resolution precedence order. */
const LOCALE_MATCH_FIELDS = ['code', 'language', 'file'] as const
export type LocaleMatchField = (typeof LOCALE_MATCH_FIELDS)[number]

/**
 * Every key a config map keyed by locale may use for one locale, in
 * resolveLocaleRef's precedence order. A file name counts with and without its
 * extension: a project writing such a map picks whichever of its locales'
 * identifiers it thinks in, and none of them is more correct than the others.
 */
export function localeMapKeys(locale: LocaleDefinition): string[] {
  return [...new Set(LOCALE_MATCH_FIELDS.flatMap((field) => {
    const ref = locale[field]
    return ref ? [ref, stripJson(ref)] : []
  }))]
}

export interface LocaleRefAmbiguity {
  ref: string
  /** The field that matched more than one locale. */
  matchedBy: LocaleMatchField
  /** Codes of every locale the ref matched, in config order. */
  candidates: string[]
  /** The one that was used — the first candidate. */
  resolvedTo: string
}

export interface LocaleRefResolution {
  locale?: LocaleDefinition
  ambiguity?: LocaleRefAmbiguity
}

/**
 * Resolve a locale ref with deliberate precedence: an exact `code` outranks a
 * `language` tag, which outranks a `file` name.
 *
 * Codes are unique by construction; language tags are not — two locales can
 * both declare `de-DE` (an informal and a formal German, say). Without
 * precedence, a locale's unique code could be shadowed by a different locale's
 * language tag purely through config ordering. Within one field a ref that
 * still matches several locales is reported as ambiguous rather than silently
 * resolved to whichever came first, because that choice depends on array order
 * and can change under the caller without warning (#301).
 */
export function resolveLocaleRef(config: I18nConfig, localeRef: string): LocaleRefResolution {
  for (const field of LOCALE_MATCH_FIELDS) {
    const matches = config.locales.filter(locale => locale[field] === localeRef)
    const [first] = matches
    if (!first) continue
    if (matches.length === 1) return { locale: first }
    return {
      locale: first,
      ambiguity: {
        ref: localeRef,
        matchedBy: field,
        candidates: matches.map(m => m.code),
        resolvedTo: first.code,
      },
    }
  }
  return {}
}

export function findLocaleImpl(config: I18nConfig, localeRef: string) {
  return resolveLocaleRef(config, localeRef).locale
}

/**
 * Resolve the reference locale for scan operations: the requested ref or the
 * project default. Throws LOCALE_NOT_FOUND listing the available codes.
 */
export function resolveReferenceLocale(
  config: I18nConfig,
  requested?: string,
): { localeCode: string; localeDef: LocaleDefinition } {
  const localeCode = requested ?? config.defaultLocale
  const localeDef = findLocaleImpl(config, localeCode)
  if (!localeDef) {
    throw new ToolError(
      `Locale not found: "${localeCode}". Available: ${config.locales.map(l => l.code).join(', ')}`,
      'LOCALE_NOT_FOUND',
    )
  }
  return { localeCode, localeDef }
}

export function findLocaleOrThrow(config: I18nConfig, localeRef: string): LocaleDefinition {
  const locale = findLocaleImpl(config, localeRef)
  if (!locale) {
    throw new ToolError(
      `Locale not found: "${localeRef}".${findLocaleSuggestion(config, localeRef)}\nAvailable locales:\n${formatLocaleChoices(config.locales)}`,
      'LOCALE_NOT_FOUND',
    )
  }
  return locale
}
