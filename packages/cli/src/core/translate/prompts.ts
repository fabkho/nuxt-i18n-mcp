/**
 * Prompt construction for the translate operations: the provider-mode system
 * and user messages, plus the agent-mode fallback context that carries the
 * same project instructions to a host agent.
 */

import type { I18nConfig, LocaleDefinition, ProjectConfig } from '../../config/types.js'
import type { LocaleFileFormat } from '../../io/formats.js'
import { log } from '../../utils/logger.js'
import { localeMapKeys } from '../shared.js'

function placeholderInstruction(format?: LocaleFileFormat): string {
  if (format === 'php-array') {
    return 'Preserve all :placeholder parameters exactly as-is.'
  }
  return 'Preserve all {placeholder} parameters and @:linked.message references.'
}

/**
 * The tag a model reasons about a locale with. The BCP-47 language tag says
 * more than a bare code ('de-DE' over 'de'), so it wins where a locale has
 * both; the project's own name for the locale rides along when there is one.
 */
function localeLabel(locale: LocaleDefinition): string {
  const tag = locale.language || locale.code
  return locale.name ? `${tag}, ${locale.name}` : tag
}

/**
 * The `localeNotes` entry a project wrote for one locale. The map is keyed by
 * whatever the project calls its locales — a bare code ('de'), a language tag
 * ('de-DE') or a file name ('de-DE.json') — so every accepted key is tried in
 * the established precedence order. An exact-code-only lookup silently drops
 * every note in a project that keys the map any other way.
 */
export function resolveLocaleNote(
  projectConfig: ProjectConfig | undefined,
  locale: LocaleDefinition,
): string | undefined {
  const notes = projectConfig?.localeNotes
  if (!notes) return undefined
  for (const key of localeMapKeys(locale)) {
    const note = notes[key]
    if (note !== undefined) return note
  }
  return undefined
}

/**
 * Project configs already reported on. An all-layers run drives the
 * single-layer pipeline once per layer against one cached config, and a typo
 * in a project file is worth one warning, not one per layer.
 */
const reportedLocaleNotes = new WeakSet<ProjectConfig>()

/**
 * Report `localeNotes` keys that match no locale in the table. Such a key is
 * dropped silently otherwise, so a typo is indistinguishable from a note the
 * model actually received.
 */
export function warnUnmatchedLocaleNotes(config: I18nConfig): void {
  const projectConfig = config.projectConfig
  const notes = projectConfig?.localeNotes
  if (!projectConfig || !notes) return
  if (reportedLocaleNotes.has(projectConfig)) return
  reportedLocaleNotes.add(projectConfig)
  const known = new Set(config.locales.flatMap(localeMapKeys))
  for (const key of Object.keys(notes)) {
    if (known.has(key)) continue
    log.warn(
      `localeNotes entry "${key}" does not match any known locale — ignoring. `
      + `Available: ${config.locales.map(l => l.code).join(', ')}`,
    )
  }
}

export function buildTranslationSystemPrompt(
  projectConfig: ProjectConfig | undefined,
  targetLocale: LocaleDefinition,
  localeFileFormat?: LocaleFileFormat,
): string {
  const parts: string[] = [
    `You are a professional translator for software UI strings. ${placeholderInstruction(localeFileFormat)} Be concise — UI space is limited.`,
  ]

  if (projectConfig?.context) {
    parts.push(`PROJECT CONTEXT: ${projectConfig.context}`)
  }

  if (projectConfig?.translationPrompt) {
    parts.push(projectConfig.translationPrompt)
  }

  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    const glossaryLines = Object.entries(projectConfig.glossary)
      .map(([term, definition]) => `- ${term} → ${definition}`)
      .join('\n')
    parts.push(`GLOSSARY — use these terms consistently:\n${glossaryLines}`)
  }

  const localeNote = resolveLocaleNote(projectConfig, targetLocale)
  if (localeNote) {
    parts.push(`TARGET LOCALE NOTE (${localeLabel(targetLocale)}): ${localeNote}`)
  }

  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    const exampleLines = projectConfig.examples
      .map((ex) => {
        const pairs = Object.entries(ex)
          .filter(([k]) => k !== 'key' && k !== 'note')
          .map(([locale, val]) => `${locale}: "${val}"`)
          .join(', ')
        const note = ex.note ? ` (${ex.note})` : ''
        return `- ${ex.key}: ${pairs}${note}`
      })
      .join('\n')
    parts.push(`STYLE EXAMPLES:\n${exampleLines}`)
  }

  parts.push('Return ONLY a JSON object mapping keys to translated values. No markdown, no explanation, no code fences.')

  return parts.join('\n\n')
}

export function buildTranslationUserMessage(
  referenceLocaleCode: string,
  targetLocaleCode: string,
  keysAndValues: Record<string, string>,
  localeFileFormat?: LocaleFileFormat,
): string {
  return [
    `Translate the following i18n key-value pairs from ${referenceLocaleCode} to ${targetLocaleCode}.`,
    placeholderInstruction(localeFileFormat),
    '',
    JSON.stringify(keysAndValues),
  ].join('\n')
}

/**
 * The agent-mode counterpart of the prompt builders: everything a host agent
 * needs to translate the batch itself and write it back.
 *
 * translate_key hands one context to several target locales at once, so the
 * targets are a list; a locale note is per-locale guidance and only belongs
 * here when there is exactly one locale it can apply to.
 */
export function buildFallbackContext(
  projectConfig: ProjectConfig | undefined,
  referenceLocale: LocaleDefinition,
  targetLocales: LocaleDefinition[],
  keysAndValues: Record<string, string>,
): Record<string, unknown> {
  const referenceLabel = localeLabel(referenceLocale)
  const targetLabel = targetLocales.map(localeLabel).join(', ')
  const context: Record<string, unknown> = {
    instruction: `Translate these keys from ${referenceLabel} to ${targetLabel}, then call write_translations (mode: 'upsert') to write them.`,
    referenceLocale: referenceLabel,
    targetLocale: targetLabel,
    keysToTranslate: keysAndValues,
  }

  if (projectConfig?.context) {
    context.projectContext = projectConfig.context
  }
  if (projectConfig?.translationPrompt) {
    context.translationPrompt = projectConfig.translationPrompt
  }
  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    context.glossary = projectConfig.glossary
  }
  const only = targetLocales.length === 1 ? targetLocales[0] : undefined
  const localeNote = only && resolveLocaleNote(projectConfig, only)
  if (localeNote) {
    context.localeNote = localeNote
  }
  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    context.examples = projectConfig.examples
  }

  return context
}
