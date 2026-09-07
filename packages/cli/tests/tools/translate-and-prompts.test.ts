import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { resolve, join } from 'node:path'
import { cp, rm, mkdir } from 'node:fs/promises'
import { readLocaleFile } from '../../src/io/json-reader.js'
import { mutateLocaleFile } from '../../src/io/json-writer.js'
import {
  getNestedValue,
  hasNestedKey,
  setNestedValue,
} from '../../src/io/key-operations.js'
import { loadProjectConfig } from '../../src/config/project-config.js'
import { playgroundDir } from '../fixtures/mock-detector.js'
import { computeProgressTotal, buildTranslationSystemPrompt, buildTranslationUserMessage, extractJsonFromResponse } from '../../src/core/operations.js'
import { buildFallbackContext, warnUnmatchedLocaleNotes } from '../../src/core/translate/prompts.js'
import { log } from '../../src/utils/logger.js'
import type { I18nConfig, LocaleDefinition } from '../../src/config/types.js'

// Temp copy of locale dirs for mutation tests
const tmpDir = resolve(import.meta.dirname, '../../.tmp-translate')
const tmpRootLocales = resolve(tmpDir, 'root')
const tmpAdminLocales = resolve(tmpDir, 'admin')

const playgroundRootLocales = resolve(playgroundDir, 'i18n/locales')
const playgroundAdminLocales = resolve(playgroundDir, 'app-admin/i18n/locales')

const localeFiles = ['de-DE.json', 'en-US.json', 'fr-FR.json', 'es-ES.json']

async function copyLocaleFiles() {
  await mkdir(tmpRootLocales, { recursive: true })
  await mkdir(tmpAdminLocales, { recursive: true })
  await cp(playgroundRootLocales, tmpRootLocales, { recursive: true })
  await cp(playgroundAdminLocales, tmpAdminLocales, { recursive: true })
}

// ─── Prompt assembly helpers (tested via buildTranslationSystemPrompt logic) ──

describe('translation system prompt assembly', () => {
  it('project config has all fields needed for prompt construction', async () => {
    const config = await loadProjectConfig(playgroundDir)
    expect(config).not.toBeNull()
    expect(config!.translationPrompt).toBeDefined()
    expect(config!.glossary).toBeDefined()
    expect(config!.localeNotes).toBeDefined()
    expect(config!.examples).toBeDefined()
  })

  it('glossary terms are available for prompt construction', async () => {
    const config = await loadProjectConfig(playgroundDir)
    expect(config!.glossary!['Buchung']).toContain('Booking')
    expect(config!.glossary!['Ressource']).toContain('Resource')
    expect(config!.glossary!['Termin']).toContain('Appointment')
  })

  it('locale notes exist for all playground locales', async () => {
    const config = await loadProjectConfig(playgroundDir)
    expect(config!.localeNotes!['de-DE']).toBeDefined()
    expect(config!.localeNotes!['en-US']).toBeDefined()
    expect(config!.localeNotes!['fr-FR']).toBeDefined()
    expect(config!.localeNotes!['es-ES']).toBeDefined()
  })

  it('examples have key-value pairs suitable for few-shot prompting', async () => {
    const config = await loadProjectConfig(playgroundDir)
    const example = config!.examples![0]
    expect(example.key).toBe('common.actions.save')
    expect(example['de-DE']).toBe('Speichern')
    expect(example['en-US']).toBe('Save')
    expect(example.note).toBeDefined()
  })
})

// ─── translate_missing: writing translated results ───────────────

describe('translate_missing: writing translations', () => {
  beforeEach(async () => {
    await copyLocaleFiles()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes translated keys to a locale file', async () => {
    const filePath = join(tmpAdminLocales, 'es-ES.json')

    // Simulate what translate_missing does after getting translations
    const translations: Record<string, string> = {
      'admin.users.list': 'Lista de usuarios',
      'admin.users.create': 'Crear usuario',
      'admin.users.edit': 'Editar usuario',
    }

    await mutateLocaleFile(filePath, (data) => {
      for (const [key, value] of Object.entries(translations)) {
        setNestedValue(data, key, value)
      }
    })

    const updated = await readLocaleFile(filePath)
    expect(getNestedValue(updated, 'admin.users.list')).toBe('Lista de usuarios')
    expect(getNestedValue(updated, 'admin.users.create')).toBe('Crear usuario')
    expect(getNestedValue(updated, 'admin.users.edit')).toBe('Editar usuario')
    // Existing keys preserved
    expect(getNestedValue(updated, 'admin.dashboard.title')).toBe('Panel de control')
    expect(getNestedValue(updated, 'admin.dashboard.welcome')).toBe('Bienvenido, {name}!')
  })

  it('does not overwrite existing keys when writing translations', async () => {
    const filePath = join(tmpAdminLocales, 'es-ES.json')
    const before = await readLocaleFile(filePath)
    const originalTitle = getNestedValue(before, 'admin.dashboard.title')

    // Simulate translate_missing — only write keys that don't exist yet
    const translations: Record<string, string> = {
      'admin.dashboard.title': 'SHOULD NOT OVERWRITE',
      'admin.users.list': 'Lista de usuarios',
    }

    await mutateLocaleFile(filePath, (data) => {
      for (const [key, value] of Object.entries(translations)) {
        if (!hasNestedKey(data, key)) {
          setNestedValue(data, key, value)
        }
      }
    })

    const updated = await readLocaleFile(filePath)
    expect(getNestedValue(updated, 'admin.dashboard.title')).toBe(originalTitle)
    expect(getNestedValue(updated, 'admin.users.list')).toBe('Lista de usuarios')
  })

  it('handles writing to a file that previously had no keys in the namespace', async () => {
    const filePath = join(tmpAdminLocales, 'es-ES.json')

    // es-ES has no admin.users.* — verify it creates the namespace
    const before = await readLocaleFile(filePath)
    expect(hasNestedKey(before, 'admin.users')).toBe(false)

    await mutateLocaleFile(filePath, (data) => {
      setNestedValue(data, 'admin.users.list', 'Lista de usuarios')
    })

    const after = await readLocaleFile(filePath)
    expect(hasNestedKey(after, 'admin.users')).toBe(true)
    expect(getNestedValue(after, 'admin.users.list')).toBe('Lista de usuarios')
  })

  it('preserves placeholders in translations', async () => {
    const filePath = join(tmpRootLocales, 'fr-FR.json')

    await mutateLocaleFile(filePath, (data) => {
      setNestedValue(data, 'common.messages.greeting', 'Bonjour, {name}!')
    })

    const updated = await readLocaleFile(filePath)
    const value = getNestedValue(updated, 'common.messages.greeting') as string
    expect(value).toBe('Bonjour, {name}!')
    expect(value).toContain('{name}')
  })
})

// ─── translate_missing: progressTotal computation ────────────────

describe('translate_missing: progressTotal computation', () => {
  it('correctly computes total for 2 locales with different missing key counts', () => {
    const missingKeyCounts = [10, 60]
    const maxBatch = 50
    const total = computeProgressTotal(missingKeyCounts, maxBatch)
    // locale 1: ceil(10/50) + 2 = 1 + 2 = 3
    // locale 2: ceil(60/50) + 2 = 2 + 2 = 4
    // total = 7
    expect(total).toBe(7)
  })

  it('excludes locales with 0 missing keys from the total', () => {
    const missingKeyCounts = [5, 0, 3]
    const maxBatch = 50
    const total = computeProgressTotal(missingKeyCounts, maxBatch)
    // locale 1: ceil(5/50) + 2 = 1 + 2 = 3
    // locale 2: 0 missing keys — excluded
    // locale 3: ceil(3/50) + 2 = 1 + 2 = 3
    // total = 6
    expect(total).toBe(6)
  })

  it('formula matches sum(ceil(keys/batch) + 2) per locale with missing keys', () => {
    const missingKeyCounts = [50, 100, 150]
    const maxBatch = 50
    const total = computeProgressTotal(missingKeyCounts, maxBatch)
    // locale 1: ceil(50/50) + 2 = 1 + 2 = 3
    // locale 2: ceil(100/50) + 2 = 2 + 2 = 4
    // locale 3: ceil(150/50) + 2 = 3 + 2 = 5
    // total = 12
    expect(total).toBe(12)
  })

  it('single locale computes correctly', () => {
    const missingKeyCounts = [75]
    const maxBatch = 50
    const total = computeProgressTotal(missingKeyCounts, maxBatch)
    // ceil(75/50) + 2 = 2 + 2 = 4
    expect(total).toBe(4)
  })

  it('all locales with 0 missing keys results in progressTotal of 0', () => {
    const missingKeyCounts = [0, 0, 0]
    const maxBatch = 50
    const total = computeProgressTotal(missingKeyCounts, maxBatch)
    expect(total).toBe(0)
  })
})

/**
 * The target locale reaches the prompt builder as its full definition, not as
 * one of its names: `localeNotes` may be keyed by any of them, and the label
 * shown to the model is a separate decision from the lookup.
 */
function locale(overrides: Partial<LocaleDefinition> & { code: string }): LocaleDefinition {
  return { language: overrides.code, ...overrides }
}

const DE = locale({ code: 'de' })

describe('buildTranslationSystemPrompt', () => {
  it('includes role framing with no project config', () => {
    const result = buildTranslationSystemPrompt(undefined, DE)
    expect(result).toContain('You are a professional translator')
    expect(result).toContain('{placeholder}')
    expect(result).toContain('Return ONLY a JSON object')
  })

  it('includes role framing even with translationPrompt set', () => {
    const result = buildTranslationSystemPrompt({ translationPrompt: 'Be formal.' }, DE)
    expect(result).toContain('You are a professional translator')
    expect(result).toContain('Be formal.')
    expect(result).toContain('Return ONLY a JSON object')
  })

  it('includes the project context so the provider sees the same background as an agent', () => {
    const result = buildTranslationSystemPrompt({ context: 'Booking software for salons.' }, DE)
    expect(result).toContain('PROJECT CONTEXT: Booking software for salons.')
  })

  it('includes glossary when provided', () => {
    const result = buildTranslationSystemPrompt({
      glossary: { Booking: 'Buchung', Resource: 'Ressource' },
    }, DE)
    expect(result).toContain('GLOSSARY')
    expect(result).toContain('Booking → Buchung')
    expect(result).toContain('Resource → Ressource')
  })

  it('includes locale note for the target locale', () => {
    const result = buildTranslationSystemPrompt({
      localeNotes: { de: 'Informal German', fr: 'Formal French' },
    }, DE)
    expect(result).toContain('TARGET LOCALE NOTE (de): Informal German')
    expect(result).not.toContain('Formal French')
  })

  it('includes examples when provided', () => {
    const result = buildTranslationSystemPrompt({
      examples: [{ key: 'save', de: 'Speichern', note: 'imperative' }],
    }, DE)
    expect(result).toContain('STYLE EXAMPLES')
    expect(result).toContain('save')
    expect(result).toContain('Speichern')
    expect(result).toContain('imperative')
  })

  it('includes all fields in correct order when all are set', () => {
    const result = buildTranslationSystemPrompt({
      context: 'Booking software.',
      translationPrompt: 'Keep it short.',
      glossary: { Save: 'Speichern' },
      localeNotes: { de: 'Use du.' },
      examples: [{ key: 'ok', de: 'OK' }],
    }, DE)
    const roleIdx = result.indexOf('You are a professional translator')
    const contextIdx = result.indexOf('PROJECT CONTEXT')
    const promptIdx = result.indexOf('Keep it short.')
    const glossaryIdx = result.indexOf('GLOSSARY')
    const noteIdx = result.indexOf('TARGET LOCALE NOTE')
    const examplesIdx = result.indexOf('STYLE EXAMPLES')
    const formatIdx = result.indexOf('Return ONLY a JSON object')
    expect(roleIdx).toBeLessThan(contextIdx)
    expect(contextIdx).toBeLessThan(promptIdx)
    expect(promptIdx).toBeLessThan(glossaryIdx)
    expect(glossaryIdx).toBeLessThan(noteIdx)
    expect(noteIdx).toBeLessThan(examplesIdx)
    expect(examplesIdx).toBeLessThan(formatIdx)
  })

  it('uses :placeholder instruction for php-array format', () => {
    const result = buildTranslationSystemPrompt(undefined, DE, 'php-array')
    expect(result).toContain(':placeholder')
    expect(result).not.toContain('{placeholder}')
  })
})

/**
 * A project keys `localeNotes` by whatever it calls its locales. A Nuxt table
 * routinely carries all three names for one locale — `{ code: 'de', language:
 * 'de-DE', file: 'de-DE.json' }` — and an exact-code lookup drops every note in
 * a project that picked either of the other two.
 */
describe('localeNotes key resolution', () => {
  const deDE = locale({ code: 'de', language: 'de-DE', file: 'de-DE.json' })

  it('matches a note keyed by the locale code', () => {
    const result = buildTranslationSystemPrompt({ localeNotes: { de: 'Use du.' } }, deDE)
    expect(result).toContain('Use du.')
  })

  it('matches a note keyed by the language tag', () => {
    const result = buildTranslationSystemPrompt({ localeNotes: { 'de-DE': 'Use du.' } }, deDE)
    expect(result).toContain('Use du.')
  })

  it('matches a note keyed by the file name, with or without extension', () => {
    expect(buildTranslationSystemPrompt({ localeNotes: { 'de-DE.json': 'Use du.' } }, deDE))
      .toContain('Use du.')
    const noFile = locale({ code: 'de', language: 'de-DE', file: 'de.json' })
    expect(buildTranslationSystemPrompt({ localeNotes: { de: 'Use du.' } }, noFile))
      .toContain('Use du.')
  })

  it('prefers the code over another locale\'s language tag', () => {
    const result = buildTranslationSystemPrompt({
      localeNotes: { 'de': 'By code', 'de-DE': 'By tag' },
    }, deDE)
    expect(result).toContain('By code')
    expect(result).not.toContain('By tag')
  })

  it('labels the note with the language tag the model understands, not the lookup key', () => {
    const result = buildTranslationSystemPrompt({ localeNotes: { de: 'Use du.' } }, deDE)
    expect(result).toContain('TARGET LOCALE NOTE (de-DE): Use du.')
  })

  it('names the locale alongside the tag when the project gave it one', () => {
    const named = locale({ code: 'de', language: 'de-DE', name: 'Deutsch' })
    const result = buildTranslationSystemPrompt({ localeNotes: { de: 'Use du.' } }, named)
    expect(result).toContain('TARGET LOCALE NOTE (de-DE, Deutsch): Use du.')
  })

  it('adds no note section when no key matches', () => {
    const result = buildTranslationSystemPrompt({ localeNotes: { 'fr-FR': 'Formal French' } }, deDE)
    expect(result).not.toContain('TARGET LOCALE NOTE')
  })
})

describe('warnUnmatchedLocaleNotes', () => {
  function configWith(localeNotes: Record<string, string>): I18nConfig {
    return {
      rootDir: '/tmp/project',
      defaultLocale: 'de',
      locales: [
        { code: 'de', language: 'de-DE', file: 'de-DE.json' },
        { code: 'en', language: 'en-US', file: 'en-US.json' },
      ],
      localeDirs: [],
      layerRootDirs: [],
      apps: [],
      projectConfig: { localeNotes },
    }
  }

  it('reports a key that matches no locale, listing the codes that exist', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedLocaleNotes(configWith({ 'de': 'ok', 'de-formal': 'typo' }))

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('localeNotes entry "de-formal"')
    expect(warnSpy.mock.calls[0]![0]).toContain('de, en')
    warnSpy.mockRestore()
  })

  it('stays silent when every key matches one of a locale\'s names', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedLocaleNotes(configWith({ 'de': 'a', 'en-US': 'b' }))

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('reports one config once, so an all-layers run does not repeat itself', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const config = configWith({ nope: 'typo' })
    warnUnmatchedLocaleNotes(config)
    warnUnmatchedLocaleNotes(config)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

describe('buildFallbackContext', () => {
  it('carries the project context to the host agent', () => {
    const context = buildFallbackContext({ context: 'Booking software.' }, DE, [locale({ code: 'en' })], { a: 'A' })
    expect(context.projectContext).toBe('Booking software.')
  })

  it('resolves the locale note by any of the target locale\'s names', () => {
    const target = locale({ code: 'en', language: 'en-US', file: 'en-US.json' })
    const context = buildFallbackContext({ localeNotes: { en: 'Use American spelling.' } }, DE, [target], { a: 'A' })
    expect(context.localeNote).toBe('Use American spelling.')
    expect(context.targetLocale).toBe('en-US')
  })

  it('omits the note when several target locales share one context', () => {
    const targets = [locale({ code: 'en', language: 'en-US' }), locale({ code: 'fr', language: 'fr-FR' })]
    const context = buildFallbackContext({ localeNotes: { en: 'Use American spelling.' } }, DE, targets, { a: 'A' })
    expect(context.localeNote).toBeUndefined()
    expect(context.targetLocale).toBe('en-US, fr-FR')
  })
})

describe('buildTranslationUserMessage', () => {
  it('includes reference and target locale codes', () => {
    const result = buildTranslationUserMessage('en', 'de', { hello: 'Hello' })
    expect(result).toContain('from en to de')
  })

  it('uses compact JSON without indentation', () => {
    const result = buildTranslationUserMessage('en', 'de', { hello: 'Hello', bye: 'Goodbye' })
    expect(result).toContain('{"hello":"Hello","bye":"Goodbye"}')
    expect(result).not.toContain('  "hello"')
  })

  it('does not include format instruction', () => {
    const result = buildTranslationUserMessage('en', 'de', { hello: 'Hello' })
    expect(result).not.toContain('Return ONLY')
  })

  it('includes placeholder instruction', () => {
    const result = buildTranslationUserMessage('en', 'de', { hello: 'Hello' })
    expect(result).toContain('{placeholder}')
  })

  it('uses :placeholder instruction for php-array format', () => {
    const result = buildTranslationUserMessage('en', 'de', { hello: 'Hello' }, 'php-array')
    expect(result).toContain(':placeholder')
  })
})

describe('extractJsonFromResponse', () => {
  /**
   * Captured from a real Gemini response on anny-ui !2070: the correct
   * translation, complete, missing only its closing brace. The whole response
   * was thrown away and the key reported as failed — five keys never got
   * translated across repeated runs because of two absent characters.
   */
  const truncatedResponse = '{\n  "pages.organizations.locations.chooseYourLocation": "Roghnaigh do shu\u00edomh"'

  it('recovers a response that ends mid-object', () => {
    const result = extractJsonFromResponse(truncatedResponse)

    expect(result).toEqual({
      'pages.organizations.locations.chooseYourLocation': 'Roghnaigh do shuíomh',
    })
  })

  it('keeps the pairs that did arrive when the last one is cut mid-value', () => {
    const result = extractJsonFromResponse('{"a": "first", "b": "second", "c": "thir')

    expect(result).toEqual({ a: 'first', b: 'second' })
  })

  it('keeps the pairs that did arrive when the cut lands mid-key', () => {
    const result = extractJsonFromResponse('{"a": "first", "b": "second", "c')

    expect(result).toEqual({ a: 'first', b: 'second' })
  })

  // Nothing usable arrived: still an error, because inventing an empty object
  // would report every key as silently omitted rather than as failed.
  it('still throws when the object was cut before any pair completed', () => {
    expect(() => extractJsonFromResponse('{"a": "fir')).toThrow(/ended mid-object/)
  })

  it('parses clean JSON directly', () => {
    const result = extractJsonFromResponse('{"key":"value"}')
    expect(result).toEqual({ key: 'value' })
  })

  it('strips markdown code fences', () => {
    const result = extractJsonFromResponse('```json\n{"key":"value"}\n```')
    expect(result).toEqual({ key: 'value' })
  })

  it('strips bare code fences without language tag', () => {
    const result = extractJsonFromResponse('```\n{"key":"value"}\n```')
    expect(result).toEqual({ key: 'value' })
  })

  it('extracts JSON from prose-prefixed response', () => {
    const result = extractJsonFromResponse('Here are your translations:\n{"key":"value"}')
    expect(result).toEqual({ key: 'value' })
  })

  it('handles nested objects in values', () => {
    const input = 'Some text {"a":"1","b":"val with } brace"} trailing'
    const result = extractJsonFromResponse(input)
    expect(result).toEqual({ a: '1', b: 'val with } brace' })
  })

  it('extracts first JSON object when multiple exist', () => {
    const result = extractJsonFromResponse('{"first":"1"}\n{"second":"2"}')
    expect(result).toEqual({ first: '1' })
  })

  it('throws when no JSON is present', () => {
    expect(() => extractJsonFromResponse('No JSON here at all')).toThrow('No valid JSON object')
  })

  it('handles whitespace around JSON', () => {
    const result = extractJsonFromResponse('  \n  {"key":"value"}  \n  ')
    expect(result).toEqual({ key: 'value' })
  })
})
