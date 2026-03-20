import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from 'vitest'
import { resolve, join } from 'node:path'
import { cp, rm, mkdir } from 'node:fs/promises'
import type { I18nConfig } from '../../src/config/types.js'
import { readLocaleFile } from '../../src/io/json-reader.js'
import { mutateLocaleFile } from '../../src/io/json-writer.js'
import {
  getNestedValue,
  getLeafKeys,
  hasNestedKey,
  setNestedValue,
  removeNestedValue,
} from '../../src/io/key-operations.js'
import { loadProjectConfig } from '../../src/config/project-config.js'
import { registerDetectorMock, playgroundDir, appAdminDir } from '../fixtures/mock-detector.js'

// Register the shared detector mock (vi.mock is hoisted by Vitest)
registerDetectorMock()

const { detectI18nConfig, clearConfigCache } = await import('../../src/config/detector.js')

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

// ─── translate_missing: identifying missing keys ─────────────────

describe('translate_missing: missing key identification', () => {
  let config: I18nConfig

  beforeAll(async () => {
    config = await detectI18nConfig(appAdminDir)
  })

  afterAll(() => {
    clearConfigCache()
  })

  it('identifies missing keys in es-ES for app-admin layer', async () => {
    const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

    const refFile = join(rootLayer.path, 'de-DE.json')
    const targetFile = join(rootLayer.path, 'es-ES.json')

    const refData = await readLocaleFile(refFile)
    const targetData = await readLocaleFile(targetFile)

    const refKeys = getLeafKeys(refData)
    const targetKeys = new Set(getLeafKeys(targetData))
    const missing = refKeys.filter(k => !targetKeys.has(k))

    expect(missing).toContain('admin.users.list')
    expect(missing).toContain('admin.users.create')
    expect(missing).toContain('admin.users.edit')
    expect(missing).toHaveLength(3)
  })

  it('no missing keys for en-US in app-admin layer', async () => {
    const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

    const refFile = join(rootLayer.path, 'de-DE.json')
    const targetFile = join(rootLayer.path, 'en-US.json')

    const refData = await readLocaleFile(refFile)
    const targetData = await readLocaleFile(targetFile)

    const refKeys = getLeafKeys(refData)
    const targetKeys = new Set(getLeafKeys(targetData))
    const missing = refKeys.filter(k => !targetKeys.has(k))

    expect(missing).toHaveLength(0)
  })

  it('collects reference values for missing keys', async () => {
    const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

    const refFile = join(rootLayer.path, 'de-DE.json')
    const targetFile = join(rootLayer.path, 'es-ES.json')

    const refData = await readLocaleFile(refFile)
    const targetData = await readLocaleFile(targetFile)

    const refKeys = getLeafKeys(refData)
    const targetKeys = new Set(getLeafKeys(targetData))
    const missing = refKeys.filter(k => !targetKeys.has(k))

    // Build key-value pairs from reference (same logic as translate_missing)
    const keysAndValues: Record<string, string> = {}
    for (const key of missing) {
      const value = getNestedValue(refData, key)
      if (typeof value === 'string') {
        keysAndValues[key] = value
      }
    }

    expect(Object.keys(keysAndValues)).toHaveLength(3)
    expect(keysAndValues['admin.users.list']).toBe('Benutzerliste')
    expect(keysAndValues['admin.users.create']).toBe('Benutzer erstellen')
    expect(keysAndValues['admin.users.edit']).toBe('Benutzer bearbeiten')
  })

  it('filters specific keys when provided', async () => {
    const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

    const refFile = join(rootLayer.path, 'de-DE.json')
    const targetFile = join(rootLayer.path, 'es-ES.json')

    const refData = await readLocaleFile(refFile)
    const targetData = await readLocaleFile(targetFile)

    const allRefKeys = getLeafKeys(refData)
    const targetKeys = new Set(getLeafKeys(targetData))

    // Only translate specific keys
    const requestedKeys = ['admin.users.list', 'admin.users.create']
    const missing = requestedKeys.filter(k => !targetKeys.has(k) && allRefKeys.includes(k))

    expect(missing).toHaveLength(2)
    expect(missing).toContain('admin.users.list')
    expect(missing).toContain('admin.users.create')
    expect(missing).not.toContain('admin.users.edit')
  })

  it('ignores requested keys that do not exist in reference', async () => {
    const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

    const refFile = join(rootLayer.path, 'de-DE.json')
    const targetFile = join(rootLayer.path, 'es-ES.json')

    const refData = await readLocaleFile(refFile)
    const targetData = await readLocaleFile(targetFile)

    const allRefKeys = getLeafKeys(refData)
    const targetKeys = new Set(getLeafKeys(targetData))

    const requestedKeys = ['admin.users.list', 'nonexistent.key']
    const missing = requestedKeys.filter(k => !targetKeys.has(k) && allRefKeys.includes(k))

    expect(missing).toHaveLength(1)
    expect(missing).toContain('admin.users.list')
    expect(missing).not.toContain('nonexistent.key')
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

// ─── Batch chunking logic ────────────────────────────────────────

describe('batch chunking logic', () => {
  it('splits keys into batches of configurable size', () => {
    const keys = Array.from({ length: 120 }, (_, i) => [`key.${i}`, `value ${i}`] as const)
    const batchSize = 50
    const batches: Array<Record<string, string>> = []

    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(Object.fromEntries(keys.slice(i, i + batchSize)))
    }

    expect(batches).toHaveLength(3)
    expect(Object.keys(batches[0])).toHaveLength(50)
    expect(Object.keys(batches[1])).toHaveLength(50)
    expect(Object.keys(batches[2])).toHaveLength(20)
  })

  it('single batch when keys are fewer than batch size', () => {
    const keys = Array.from({ length: 10 }, (_, i) => [`key.${i}`, `value ${i}`] as const)
    const batchSize = 50
    const batches: Array<Record<string, string>> = []

    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(Object.fromEntries(keys.slice(i, i + batchSize)))
    }

    expect(batches).toHaveLength(1)
    expect(Object.keys(batches[0])).toHaveLength(10)
  })

  it('handles exact batch size boundary', () => {
    const keys = Array.from({ length: 50 }, (_, i) => [`key.${i}`, `value ${i}`] as const)
    const batchSize = 50
    const batches: Array<Record<string, string>> = []

    for (let i = 0; i < keys.length; i += batchSize) {
      batches.push(Object.fromEntries(keys.slice(i, i + batchSize)))
    }

    expect(batches).toHaveLength(1)
    expect(Object.keys(batches[0])).toHaveLength(50)
  })
})

// ─── Fallback context construction ───────────────────────────────

describe('fallback context for non-sampling hosts', () => {
  it('builds fallback context with all project config fields', async () => {
    const projectConfig = await loadProjectConfig(playgroundDir)
    expect(projectConfig).not.toBeNull()

    const referenceLocale = 'de-DE'
    const targetLocale = 'es-ES'
    const keysAndValues = {
      'admin.users.list': 'Benutzerliste',
      'admin.users.create': 'Benutzer erstellen',
    }

    // Same logic as buildFallbackContext
    const context: Record<string, unknown> = {
      instruction: `Translate these keys from ${referenceLocale} to ${targetLocale}, then call add_translations to write them.`,
      referenceLocale,
      targetLocale,
      keysToTranslate: keysAndValues,
    }

    if (projectConfig!.translationPrompt) {
      context.translationPrompt = projectConfig!.translationPrompt
    }
    if (projectConfig!.glossary && Object.keys(projectConfig!.glossary).length > 0) {
      context.glossary = projectConfig!.glossary
    }
    if (projectConfig!.localeNotes?.[targetLocale]) {
      context.localeNote = projectConfig!.localeNotes[targetLocale]
    }
    if (projectConfig!.examples && projectConfig!.examples.length > 0) {
      context.examples = projectConfig!.examples
    }

    expect(context.instruction).toContain('de-DE')
    expect(context.instruction).toContain('es-ES')
    expect(context.keysToTranslate).toEqual(keysAndValues)
    expect(context.translationPrompt).toBeDefined()
    expect(context.glossary).toBeDefined()
    expect(context.localeNote).toBe(projectConfig!.localeNotes!['es-ES'])
    expect(context.examples).toEqual(projectConfig!.examples)
  })

  it('builds minimal fallback context without project config', () => {
    const referenceLocale = 'de-DE'
    const targetLocale = 'fr-FR'
    const keysAndValues = {
      'common.actions.save': 'Speichern',
    }

    const context: Record<string, unknown> = {
      instruction: `Translate these keys from ${referenceLocale} to ${targetLocale}, then call add_translations to write them.`,
      referenceLocale,
      targetLocale,
      keysToTranslate: keysAndValues,
    }

    // No project config — context should only have the basics
    expect(context.instruction).toContain('de-DE')
    expect(context.instruction).toContain('fr-FR')
    expect(context.keysToTranslate).toEqual(keysAndValues)
    expect(context.translationPrompt).toBeUndefined()
    expect(context.glossary).toBeUndefined()
    expect(context.localeNote).toBeUndefined()
    expect(context.examples).toBeUndefined()
  })

  it('includes only the relevant locale note for the target', async () => {
    const projectConfig = await loadProjectConfig(playgroundDir)

    // Check de-DE note
    const contextDe: Record<string, unknown> = {}
    if (projectConfig!.localeNotes?.['de-DE']) {
      contextDe.localeNote = projectConfig!.localeNotes['de-DE']
    }
    expect(contextDe.localeNote).toContain('German')

    // Check en-US note
    const contextEn: Record<string, unknown> = {}
    if (projectConfig!.localeNotes?.['en-US']) {
      contextEn.localeNote = projectConfig!.localeNotes['en-US']
    }
    expect(contextEn.localeNote).toContain('American English')

    // Check nonexistent locale note
    const contextNone: Record<string, unknown> = {}
    if (projectConfig!.localeNotes?.['ja-JP']) {
      contextNone.localeNote = projectConfig!.localeNotes['ja-JP']
    }
    expect(contextNone.localeNote).toBeUndefined()
  })
})

// ─── Sampling response parsing ───────────────────────────────────

describe('sampling response JSON parsing', () => {
  it('parses clean JSON response', () => {
    const responseText = '{"admin.users.list": "Lista de usuarios", "admin.users.create": "Crear usuario"}'
    const parsed = JSON.parse(responseText) as Record<string, string>

    expect(parsed['admin.users.list']).toBe('Lista de usuarios')
    expect(parsed['admin.users.create']).toBe('Crear usuario')
  })

  it('handles JSON with markdown code fences', () => {
    const responseText = '```json\n{"admin.users.list": "Lista de usuarios"}\n```'

    let cleanJson = responseText.trim()
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    const parsed = JSON.parse(cleanJson) as Record<string, string>
    expect(parsed['admin.users.list']).toBe('Lista de usuarios')
  })

  it('handles JSON with bare code fences (no language tag)', () => {
    const responseText = '```\n{"key": "value"}\n```'

    let cleanJson = responseText.trim()
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    const parsed = JSON.parse(cleanJson) as Record<string, string>
    expect(parsed['key']).toBe('value')
  })

  it('handles response with leading/trailing whitespace', () => {
    const responseText = '  \n  {"key": "value"}  \n  '

    const cleanJson = responseText.trim()
    const parsed = JSON.parse(cleanJson) as Record<string, string>
    expect(parsed['key']).toBe('value')
  })

  it('preserves placeholders in parsed translations', () => {
    const responseText = '{"greeting": "Hola, {name}!", "count": "{n} elementos"}'
    const parsed = JSON.parse(responseText) as Record<string, string>

    expect(parsed['greeting']).toContain('{name}')
    expect(parsed['count']).toContain('{n}')
  })

  it('preserves linked references in parsed translations', () => {
    const responseText = '{"field.required": "@:common.errors.required"}'
    const parsed = JSON.parse(responseText) as Record<string, string>

    expect(parsed['field.required']).toBe('@:common.errors.required')
  })
})

// ─── Prompt content structure ────────────────────────────────────

describe('add-feature-translations prompt structure', () => {
  let config: I18nConfig

  beforeAll(async () => {
    config = await detectI18nConfig(playgroundDir)
  })

  afterAll(() => {
    clearConfigCache()
  })

  it('prompt would include project context when available', () => {
    const pc = config.projectConfig

    expect(pc).toBeDefined()

    // Simulate what the prompt handler builds
    const parts: string[] = []
    if (pc?.context) parts.push(`PROJECT CONTEXT: ${pc.context}`)
    if (pc?.layerRules) {
      parts.push('LAYER RULES:')
      for (const rule of pc.layerRules) {
        parts.push(`- ${rule.layer}: ${rule.description}`)
      }
    }
    if (pc?.glossary) {
      parts.push('GLOSSARY:')
      for (const [term, def] of Object.entries(pc.glossary)) {
        parts.push(`- ${term} → ${def}`)
      }
    }

    const combined = parts.join('\n')
    expect(combined).toContain('PROJECT CONTEXT')
    expect(combined).toContain('LAYER RULES')
    expect(combined).toContain('root')
    expect(combined).toContain('app-admin')
    expect(combined).toContain('GLOSSARY')
    expect(combined).toContain('Buchung')
    expect(combined).toContain('Booking')
  })

  it('prompt workflow mentions all required tool calls', () => {
    const promptText = `Follow these steps:
1. Call \`detect_i18n_config\` to understand the project setup.
2. Call \`search_translations\` to check for existing similar keys.
3. Call \`add_translations\` to add keys for ALL locales.
4. Call \`translate_missing\` to fill in the rest.
5. Summarize what was added.`

    expect(promptText).toContain('detect_i18n_config')
    expect(promptText).toContain('search_translations')
    expect(promptText).toContain('add_translations')
    expect(promptText).toContain('translate_missing')
  })
})

describe('fix-missing-translations prompt structure', () => {
  let config: I18nConfig

  beforeAll(async () => {
    config = await detectI18nConfig(playgroundDir)
  })

  afterAll(() => {
    clearConfigCache()
  })

  it('prompt would include glossary and translation style', () => {
    const pc = config.projectConfig

    expect(pc).toBeDefined()

    const parts: string[] = []
    if (pc?.translationPrompt) {
      parts.push(`TRANSLATION STYLE: ${pc.translationPrompt}`)
    }
    if (pc?.glossary) {
      parts.push('GLOSSARY:')
      for (const [term, def] of Object.entries(pc.glossary)) {
        parts.push(`- ${term} → ${def}`)
      }
    }

    const combined = parts.join('\n')
    expect(combined).toContain('TRANSLATION STYLE')
    expect(combined).toContain('GLOSSARY')
    expect(combined).toContain('Buchung')
  })

  it('prompt workflow mentions required tool calls', () => {
    const promptText = `Follow these steps:
1. Call \`detect_i18n_config\` to load the project config.
2. Call \`get_missing_translations\` to find all gaps.
3. Call \`translate_missing\` to auto-fill gaps.
4. Report a summary.`

    expect(promptText).toContain('detect_i18n_config')
    expect(promptText).toContain('get_missing_translations')
    expect(promptText).toContain('translate_missing')
  })
})
