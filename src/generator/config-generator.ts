import { join } from 'node:path'
import type { I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig } from '../config/types.js'
import { readLocaleFile } from '../io/json-reader.js'
import { getLeafKeys, getNestedValue } from '../io/key-operations.js'
import { log } from '../utils/logger.js'

// ─── BCP-47 primary subtag → human-readable language name ────────

const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali',
  ca: 'Catalan', cs: 'Czech', da: 'Danish', de: 'German',
  el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian',
  fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew',
  hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', lt: 'Lithuanian',
  lv: 'Latvian', ms: 'Malay', nb: 'Norwegian Bokmål', nl: 'Dutch',
  nn: 'Norwegian Nynorsk', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak',
  sl: 'Slovenian', sr: 'Serbian', sv: 'Swedish', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese',
}

const REGION_NAMES: Record<string, string> = {
  US: 'American', GB: 'British', AU: 'Australian', CA: 'Canadian',
  BR: 'Brazilian', PT: 'European Portuguese', MX: 'Mexican',
  AR: 'Argentine', CL: 'Chilean', CO: 'Colombian',
  AT: 'Austrian', CH: 'Swiss', DE: 'German',
  BE: 'Belgian', FR: 'French',
  CN: 'Simplified Chinese', TW: 'Traditional Chinese', HK: 'Hong Kong',
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Optional user-provided context collected via MCP elicitation.
 */
export interface ElicitedProjectInfo {
  /** Free-form project description (e.g. "B2B SaaS booking platform") */
  description?: string
  /** Desired translation tone */
  tone?: 'formal' | 'informal' | 'mixed'
}

/**
 * Reads locale files and generates a complete ProjectConfig.
 * Only function with I/O — all others are pure.
 */
export async function generateProjectConfig(
  config: I18nConfig,
  elicited?: ElicitedProjectInfo,
): Promise<ProjectConfig> {
  const { localeDirs, locales, defaultLocale, fallbackLocale } = config
  const nonAliasLayers = localeDirs.filter(d => !d.aliasOf)

  const defaultLocaleDef = locales.find(l => l.code === defaultLocale)
  if (!defaultLocaleDef) {
    throw new Error(`Default locale '${defaultLocale}' not found in locale definitions`)
  }

  const defaultLocaleDataByLayer = new Map<string, Record<string, unknown>>()
  const keysByLayer = new Map<string, string[]>()

  for (const dir of nonAliasLayers) {
    const filePath = join(dir.path, defaultLocaleDef.file)
    try {
      const data = await readLocaleFile(filePath)
      defaultLocaleDataByLayer.set(dir.layer, data)
      keysByLayer.set(dir.layer, getLeafKeys(data))
    } catch {
      log.warn(`Could not read default locale for layer '${dir.layer}': ${filePath}`)
      defaultLocaleDataByLayer.set(dir.layer, {})
      keysByLayer.set(dir.layer, [])
    }
  }

  const secondLocaleDef = locales.find(l => l.code !== defaultLocale)
  let secondLocaleDataByLayer: Map<string, Record<string, unknown>> | undefined

  if (secondLocaleDef) {
    secondLocaleDataByLayer = new Map()
    for (const layer of nonAliasLayers) {
      const filePath = join(layer.path, secondLocaleDef.file)
      try {
        const data = await readLocaleFile(filePath)
        secondLocaleDataByLayer.set(layer.layer, data)
      } catch {
        log.warn(`Could not read second locale for examples: ${filePath}`)
      }
    }
  }

  const context = generateContext(localeDirs, locales, elicited?.description)
  const layerRules = generateLayerRules(localeDirs, keysByLayer)
  const glossary = generateGlossary()
  const translationPrompt = generateTranslationPrompt(elicited?.tone)
  const localeNotes = generateLocaleNotes(locales, fallbackLocale)

  let examples: Array<Record<string, string>> = []
  if (secondLocaleDef && secondLocaleDataByLayer) {
    examples = generateExamples(
      defaultLocaleDataByLayer,
      secondLocaleDataByLayer,
      defaultLocaleDef.code,
      secondLocaleDef.code,
    )
  }

  return {
    context,
    layerRules,
    glossary,
    translationPrompt,
    localeNotes,
    examples,
  }
}

// ─── Pure generator functions ────────────────────────────────────

export function generateLayerRules(
  localeDirs: LocaleDir[],
  keysByLayer: Map<string, string[]>,
): Array<{ layer: string; description: string; when: string }> {
  const rules: Array<{ layer: string; description: string; when: string }> = []

  const hasExplicitRoot = localeDirs.some(d => !d.aliasOf && d.layer === 'root')
  let rootLayer = ''
  if (hasExplicitRoot) {
    rootLayer = 'root'
  } else {
    let maxKeys = 0
    for (const [layer, keys] of keysByLayer) {
      if (keys.length > maxKeys) {
        maxKeys = keys.length
        rootLayer = layer
      }
    }
  }

  for (const dir of localeDirs) {
    if (dir.aliasOf) {
      rules.push({
        layer: dir.layer,
        description: `Alias of ${dir.aliasOf} — shares its translations.`,
        when: `Same as ${dir.aliasOf}. Do not add keys here directly.`,
      })
      continue
    }

    const keys = keysByLayer.get(dir.layer) ?? []
    const topLevelNamespaces = extractTopLevelNamespaces(keys)
    const nsDisplay = topLevelNamespaces.length > 0
      ? topLevelNamespaces.map(ns => `${ns}.*`).join(', ')
      : '(empty)'

    if (dir.layer === rootLayer || dir.layer === 'root') {
      rules.push({
        layer: dir.layer,
        description: `Shared translations used across the project: ${nsDisplay}`,
        when: 'The key is generic enough to be used in multiple apps or features (e.g., common actions, messages, navigation).',
      })
    } else {
      const layerLabel = dir.layer.replace(/^app-/, '')
      rules.push({
        layer: dir.layer,
        description: `Translations for ${dir.layer}: ${nsDisplay}`,
        when: `The key is specific to ${layerLabel} functionality.`,
      })
    }
  }

  return rules
}

/**
 * Returns an empty glossary — glossary entries require domain knowledge
 * that only a human or an AI agent with project context can provide.
 * The generated config leaves this empty for manual or agent-assisted refinement.
 */
export function generateGlossary(): Record<string, string> {
  return {}
}

export function generateLocaleNotes(
  locales: LocaleDefinition[],
  fallbackLocale: Record<string, string[]>,
): Record<string, string> {
  const notes: Record<string, string> = {}

  for (const locale of locales) {
    const parts: string[] = []
    // Use locale.language (BCP-47 tag like "de-DE", "en-US") for region detection,
    // falling back to locale.code for projects where both are identical.
    const bcp47 = locale.language || locale.code
    const segments = bcp47.split('-')
    const primaryLang = segments[0].toLowerCase()
    const langName = LANGUAGE_NAMES[primaryLang] ?? primaryLang

    const isFormal = locale.code.toLowerCase().includes('formal')
      || locale.name?.toLowerCase().includes('formal')

    if (isFormal) {
      const baseLang = segments[0].toLowerCase()
      if (baseLang === 'de') {
        parts.push(`Formal German. Uses 'Sie' instead of 'du'.`)
      } else {
        parts.push(`Formal register variant of ${langName}.`)
      }
    } else {
      const region = segments.find(s => s.length === 2 && s === s.toUpperCase())
      const regionLabel = region ? REGION_NAMES[region] : undefined

      if (regionLabel && regionLabel !== langName) {
        parts.push(`${regionLabel} ${langName}.`)
      } else {
        parts.push(`${langName}.`)
      }
    }

    const fallbacks = fallbackLocale[locale.code]
    if (fallbacks && fallbacks.length > 0) {
      parts.push(`Falls back to ${fallbacks.join(', ')}.`)
    }

    notes[locale.code] = parts.join(' ')
  }

  return notes
}

export function generateExamples(
  defaultLocaleDataByLayer: Map<string, Record<string, unknown>>,
  secondLocaleDataByLayer: Map<string, Record<string, unknown>>,
  defaultLocaleCode: string,
  secondLocaleCode: string,
): Array<Record<string, string>> {
  const examples: Array<Record<string, string>> = []

  let layerData: Record<string, unknown> | undefined
  let secondLayerData: Record<string, unknown> | undefined
  let usedLayer: string | undefined

  for (const [layer, data] of defaultLocaleDataByLayer) {
    const secondData = secondLocaleDataByLayer.get(layer)
    if (secondData && Object.keys(data).length > 0 && Object.keys(secondData).length > 0) {
      layerData = data
      secondLayerData = secondData
      usedLayer = layer
      break
    }
  }

  if (!layerData || !secondLayerData || !usedLayer) return examples

  const allKeys = getLeafKeys(layerData)
  const commonKeys = allKeys.filter(k => k.startsWith('common.'))
  const candidateKeys = commonKeys.length > 0 ? commonKeys : allKeys

  let picked = 0
  for (const key of candidateKeys) {
    if (picked >= 3) break

    const defaultValue = getNestedValue(layerData, key)
    const secondValue = getNestedValue(secondLayerData, key)

    if (
      typeof defaultValue !== 'string' || defaultValue.length === 0 || defaultValue.length > 50
      || typeof secondValue !== 'string' || secondValue.length === 0
    ) continue

    const example: Record<string, string> = {
      key,
      [defaultLocaleCode]: defaultValue,
      [secondLocaleCode]: secondValue,
    }

    if (defaultValue.split(' ').length <= 2) {
      example.note = 'Concise, single word/phrase'
    } else if (defaultValue.endsWith('...') || defaultValue.endsWith('…')) {
      example.note = 'Loading/progress indicator'
    } else if (defaultValue.includes('{')) {
      example.note = 'Contains placeholder — preserve {variable} names'
    } else {
      example.note = 'Natural, professional tone'
    }

    examples.push(example)
    picked++
  }

  return examples
}

export function generateContext(
  localeDirs: LocaleDir[],
  locales: LocaleDefinition[],
  projectDescription?: string,
): string {
  const parts: string[] = []

  if (projectDescription) {
    parts.push(projectDescription)
  }

  const nonAliasLayers = localeDirs.filter(d => !d.aliasOf)
  const aliasLayers = localeDirs.filter(d => d.aliasOf)
  const layerNames = nonAliasLayers.map(d => d.layer)

  parts.push(`This project uses ${locales.length} locale${locales.length === 1 ? '' : 's'} across ${nonAliasLayers.length} layer${nonAliasLayers.length === 1 ? '' : 's'}. Layers: ${layerNames.join(', ')}.`)

  if (aliasLayers.length > 0) {
    const aliasList = aliasLayers.map(d => `${d.layer} → ${d.aliasOf}`).join(', ')
    parts[parts.length - 1] += ` Aliases: ${aliasList}.`
  }

  return parts.join(' ')
}

export function generateTranslationPrompt(tone?: 'formal' | 'informal' | 'mixed'): string {
  const base = 'Preserve all {placeholders} and @:linked.message references. Keep translations concise — UI space is limited.'

  if (!tone || tone === 'mixed') return base

  const toneInstruction = tone === 'formal'
    ? 'Use a formal, professional tone.'
    : 'Use a friendly, informal tone.'

  return `${toneInstruction} ${base}`
}

// ─── Internal helpers ────────────────────────────────────────────

function extractTopLevelNamespaces(keys: string[]): string[] {
  const namespaces = new Set<string>()
  for (const key of keys) {
    const firstDot = key.indexOf('.')
    if (firstDot > 0) {
      namespaces.add(key.substring(0, firstDot))
    } else {
      namespaces.add(key)
    }
  }
  return [...namespaces].sort()
}
