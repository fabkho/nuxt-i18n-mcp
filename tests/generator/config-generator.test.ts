import { describe, it, expect, vi } from 'vitest'
import type { LocaleDefinition, LocaleDir, I18nConfig } from '../../src/config/types.js'
import {
  generateLayerRules,
  generateGlossary,
  generateLocaleNotes,
  generateExamples,
  generateContext,
  generateTranslationPrompt,
  generateProjectConfig,
} from '../../src/generator/config-generator.js'
import type { ElicitedProjectInfo } from '../../src/generator/config-generator.js'

vi.mock('../../src/io/json-reader.js', () => ({
  readLocaleFile: vi.fn(),
}))

vi.mock('../../src/utils/logger.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const mockReadLocaleFile = vi.mocked(
  (await import('../../src/io/json-reader.js')).readLocaleFile,
)

describe('generateLayerRules', () => {
  const baseDirs: LocaleDir[] = [
    { path: '/project/i18n', layer: 'root', layerRootDir: '/project' },
    { path: '/project/app-admin/i18n', layer: 'app-admin', layerRootDir: '/project/app-admin' },
    { path: '/project/app-outlook/i18n', layer: 'app-outlook', layerRootDir: '/project/app-outlook', aliasOf: 'app-shop' },
  ]

  it('marks root/shared layer with generic description', () => {
    const keysByLayer = new Map([
      ['root', ['common.actions.save', 'common.messages.ok']],
      ['app-admin', ['admin.users.title']],
    ])
    const rules = generateLayerRules(baseDirs, keysByLayer)

    const rootRule = rules.find(r => r.layer === 'root')!
    expect(rootRule.description).toContain('Shared translations')
    expect(rootRule.description).toContain('common.*')
    expect(rootRule.when).toContain('generic')
  })

  it('generates named layer rules with namespace info', () => {
    const keysByLayer = new Map([
      ['root', ['common.actions.save', 'common.actions.cancel', 'common.messages.ok']],
      ['app-admin', ['admin.users.title', 'admin.settings.name']],
    ])
    const rules = generateLayerRules(baseDirs, keysByLayer)

    const adminRule = rules.find(r => r.layer === 'app-admin')!
    expect(adminRule.description).toContain('admin.*')
    expect(adminRule.when).toContain('admin')
  })

  it('annotates alias layers', () => {
    const keysByLayer = new Map([
      ['root', ['common.save']],
      ['app-admin', ['admin.title']],
    ])
    const rules = generateLayerRules(baseDirs, keysByLayer)

    const aliasRule = rules.find(r => r.layer === 'app-outlook')!
    expect(aliasRule.description).toContain('Alias of app-shop')
    expect(aliasRule.when).toContain('Do not add keys here')
  })

  it('uses layer with most keys as root when none is named "root"', () => {
    const dirs: LocaleDir[] = [
      { path: '/p/shared/i18n', layer: 'shared', layerRootDir: '/p/shared' },
      { path: '/p/admin/i18n', layer: 'app-admin', layerRootDir: '/p/admin' },
    ]
    const keysByLayer = new Map([
      ['shared', ['a', 'b', 'c', 'd', 'e']],
      ['app-admin', ['x']],
    ])
    const rules = generateLayerRules(dirs, keysByLayer)

    const sharedRule = rules.find(r => r.layer === 'shared')!
    expect(sharedRule.description).toContain('Shared translations')
  })
})

describe('generateGlossary', () => {
  it('returns empty glossary for manual refinement', () => {
    const glossary = generateGlossary()
    expect(Object.keys(glossary)).toHaveLength(0)
  })
})

describe('generateLocaleNotes', () => {
  const locales: LocaleDefinition[] = [
    { code: 'de', language: 'de-DE', file: 'de-DE.json' },
    { code: 'de-formal', language: 'de-DE-formal', file: 'de-DE-formal.json' },
    { code: 'en', language: 'en-US', file: 'en-US.json' },
    { code: 'uk', language: 'uk-UA', file: 'uk-UA.json' },
  ]

  const fallbacks: Record<string, string[]> = {
    'de-formal': ['de'],
    'uk': ['ru'],
    'default': ['en'],
  }

  it('detects formal German variant', () => {
    const notes = generateLocaleNotes(locales, fallbacks)
    expect(notes['de-formal']).toContain('Formal German')
    expect(notes['de-formal']).toContain('Sie')
  })

  it('adds fallback chain info', () => {
    const notes = generateLocaleNotes(locales, fallbacks)
    expect(notes['de-formal']).toContain('Falls back to de')
    expect(notes['uk']).toContain('Falls back to ru')
  })

  it('generates basic language note for simple locales', () => {
    const notes = generateLocaleNotes(locales, fallbacks)
    expect(notes['de']).toContain('German')
    expect(notes['en']).toContain('English')
  })

  it('detects region from BCP-47 tag', () => {
    const localeDefs: LocaleDefinition[] = [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
      { code: 'en-GB', language: 'en-GB', file: 'en-GB.json' },
    ]
    const notes = generateLocaleNotes(localeDefs, {})
    expect(notes['en']).toContain('American')
    expect(notes['en-GB']).toContain('British')
  })

  it('handles formal variant of non-German language', () => {
    const localeDefs: LocaleDefinition[] = [
      { code: 'fr-formal', language: 'fr-FR', file: 'fr-FR-formal.json' },
    ]
    const notes = generateLocaleNotes(localeDefs, {})
    expect(notes['fr-formal']).toContain('Formal register variant')
    expect(notes['fr-formal']).toContain('French')
  })

  it('suppresses redundant region label when it matches language name', () => {
    const localeDefs: LocaleDefinition[] = [
      { code: 'fr', language: 'fr-FR', file: 'fr-FR.json' },
    ]
    const notes = generateLocaleNotes(localeDefs, {})
    expect(notes['fr']).toBe('French.')
    expect(notes['fr']).not.toContain('French French')
  })
})

describe('generateExamples', () => {
  it('picks examples from common.* namespace when available', () => {
    const defaultData = new Map([
      ['root', {
        common: { actions: { save: 'Save', cancel: 'Cancel', delete: 'Delete' } },
        admin: { title: 'Admin Panel' },
      }],
    ])
    const secondData = new Map([
      ['root', {
        common: { actions: { save: 'Speichern', cancel: 'Abbrechen', delete: 'Löschen' } },
        admin: { title: 'Admin-Bereich' },
      }],
    ])

    const examples = generateExamples(defaultData, secondData, 'en', 'de')

    expect(examples.length).toBeGreaterThanOrEqual(1)
    expect(examples.length).toBeLessThanOrEqual(3)
    expect(examples[0].key).toMatch(/^common\./)
    expect(examples[0].en).toBeDefined()
    expect(examples[0].de).toBeDefined()
    expect(examples[0].note).toBeDefined()
  })

  it('falls back to any namespace when no common.* exists', () => {
    const defaultData = new Map([
      ['root', { admin: { title: 'Dashboard' } }],
    ])
    const secondData = new Map([
      ['root', { admin: { title: 'Übersicht' } }],
    ])

    const examples = generateExamples(defaultData, secondData, 'en', 'de')
    expect(examples.length).toBe(1)
    expect(examples[0].key).toBe('admin.title')
  })

  it('skips values longer than 50 chars', () => {
    const longValue = 'A'.repeat(51)
    const defaultData = new Map([
      ['root', { a: longValue, b: 'Short' }],
    ])
    const secondData = new Map([
      ['root', { a: 'Lang', b: 'Kurz' }],
    ])

    const examples = generateExamples(defaultData, secondData, 'en', 'de')
    expect(examples).toHaveLength(1)
    expect(examples[0].key).toBe('b')
  })

  it('skips keys missing in second locale', () => {
    const defaultData = new Map([
      ['root', { a: 'Hello', b: 'World' }],
    ])
    const secondData = new Map([
      ['root', { a: 'Hallo' }],
    ])

    const examples = generateExamples(defaultData, secondData, 'en', 'de')
    expect(examples).toHaveLength(1)
    expect(examples[0].key).toBe('a')
  })

  it('returns empty when no matching layer data exists', () => {
    const defaultData = new Map([['root', { a: 'Hello' }]])
    const secondData = new Map<string, Record<string, unknown>>()

    const examples = generateExamples(defaultData, secondData, 'en', 'de')
    expect(examples).toHaveLength(0)
  })
})

describe('generateContext', () => {
  it('summarizes locales and layers', () => {
    const dirs: LocaleDir[] = [
      { path: '/p/i18n', layer: 'root', layerRootDir: '/p' },
      { path: '/p/admin/i18n', layer: 'app-admin', layerRootDir: '/p/admin' },
    ]
    const locales: LocaleDefinition[] = [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
      { code: 'de', language: 'de-DE', file: 'de-DE.json' },
    ]

    const context = generateContext(dirs, locales)
    expect(context).toContain('2 locales')
    expect(context).toContain('2 layers')
    expect(context).toContain('root')
    expect(context).toContain('app-admin')
  })

  it('includes alias info', () => {
    const dirs: LocaleDir[] = [
      { path: '/p/i18n', layer: 'root', layerRootDir: '/p' },
      { path: '/p/outlook/i18n', layer: 'app-outlook', layerRootDir: '/p/outlook', aliasOf: 'app-shop' },
    ]
    const locales: LocaleDefinition[] = [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ]

    const context = generateContext(dirs, locales)
    expect(context).toContain('1 layer')
    expect(context).toContain('Aliases: app-outlook → app-shop')
  })

  it('uses singular for 1 locale/layer', () => {
    const dirs: LocaleDir[] = [
      { path: '/p/i18n', layer: 'root', layerRootDir: '/p' },
    ]
    const locales: LocaleDefinition[] = [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ]
    const context = generateContext(dirs, locales)
    expect(context).toContain('1 locale ')
    expect(context).toContain('1 layer.')
  })

  it('prepends project description when provided', () => {
    const dirs: LocaleDir[] = [
      { path: '/p/i18n', layer: 'root', layerRootDir: '/p' },
    ]
    const locales: LocaleDefinition[] = [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ]
    const context = generateContext(dirs, locales, 'B2B SaaS booking platform')
    expect(context).toMatch(/^B2B SaaS booking platform/)
    expect(context).toContain('1 locale')
  })
})

describe('generateTranslationPrompt', () => {
  it('returns a prompt mentioning placeholders and linked messages', () => {
    const prompt = generateTranslationPrompt()
    expect(prompt).toContain('{placeholders}')
    expect(prompt).toContain('@:linked')
  })

  it('prepends formal tone instruction', () => {
    const prompt = generateTranslationPrompt('formal')
    expect(prompt).toMatch(/^Use a formal/)
    expect(prompt).toContain('{placeholders}')
  })

  it('prepends informal tone instruction', () => {
    const prompt = generateTranslationPrompt('informal')
    expect(prompt).toMatch(/^Use a friendly/)
    expect(prompt).toContain('{placeholders}')
  })

  it('returns base prompt for mixed tone', () => {
    const prompt = generateTranslationPrompt('mixed')
    expect(prompt).not.toContain('formal')
    expect(prompt).not.toContain('friendly')
    expect(prompt).toContain('{placeholders}')
  })
})

describe('generateProjectConfig', () => {
  it('generates a complete config from mock data', async () => {
    mockReadLocaleFile.mockImplementation(async (filePath: string) => {
      if (filePath.includes('en-US.json') && filePath.includes('root')) {
        return {
          common: {
            actions: { save: 'Save', cancel: 'Cancel', delete: 'Delete' },
            messages: { success: 'Operation successful', error: 'An error occurred' },
          },
        }
      }
      if (filePath.includes('de-DE.json') && filePath.includes('root')) {
        return {
          common: {
            actions: { save: 'Speichern', cancel: 'Abbrechen', delete: 'Löschen' },
            messages: { success: 'Vorgang erfolgreich', error: 'Ein Fehler ist aufgetreten' },
          },
        }
      }
      if (filePath.includes('en-US.json') && filePath.includes('admin')) {
        return {
          admin: { users: { title: 'Users' }, settings: { title: 'Settings' } },
        }
      }
      return {}
    })

    const config: I18nConfig = {
      rootDir: '/project',
      defaultLocale: 'en',
      fallbackLocale: { 'de-formal': ['de'], default: ['en'] },
      locales: [
        { code: 'en', language: 'en-US', file: 'en-US.json' },
        { code: 'de', language: 'de-DE', file: 'de-DE.json' },
        { code: 'de-formal', language: 'de-DE-formal', file: 'de-DE-formal.json' },
      ],
      localeDirs: [
        { path: '/project/root/i18n', layer: 'root', layerRootDir: '/project/root' },
        { path: '/project/admin/i18n', layer: 'app-admin', layerRootDir: '/project/admin' },
      ],
    }

    const result = await generateProjectConfig(config)

    expect(result.context).toContain('3 locales')
    expect(result.context).toContain('2 layers')
    expect(result.layerRules).toBeDefined()
    expect(result.layerRules!.length).toBe(2)
    expect(result.glossary).toEqual({})
    expect(result.translationPrompt).toBeDefined()
    expect(result.localeNotes).toBeDefined()
    expect(result.localeNotes!['de-formal']).toContain('Formal German')
    expect(result.examples).toBeDefined()
  })

  it('throws when default locale is not found', async () => {
    const config: I18nConfig = {
      rootDir: '/project',
      defaultLocale: 'xx',
      fallbackLocale: {},
      locales: [{ code: 'en', language: 'en-US', file: 'en-US.json' }],
      localeDirs: [],
    }

    await expect(generateProjectConfig(config)).rejects.toThrow('Default locale')
  })

  it('handles unreadable locale files gracefully', async () => {
    mockReadLocaleFile.mockRejectedValue(new Error('File not found'))

    const config: I18nConfig = {
      rootDir: '/project',
      defaultLocale: 'en',
      fallbackLocale: {},
      locales: [{ code: 'en', language: 'en-US', file: 'en-US.json' }],
      localeDirs: [
        { path: '/project/i18n', layer: 'root', layerRootDir: '/project' },
      ],
    }

    const result = await generateProjectConfig(config)
    expect(result.context).toBeDefined()
    expect(result.layerRules).toBeDefined()
    expect(result.glossary).toEqual({})
    expect(result.examples).toEqual([])
  })

  it('merges elicited project info into context and translationPrompt', async () => {
    mockReadLocaleFile.mockResolvedValue({
      common: { save: 'Save' },
    })

    const config: I18nConfig = {
      rootDir: '/project',
      defaultLocale: 'en',
      fallbackLocale: {},
      locales: [{ code: 'en', language: 'en-US', file: 'en-US.json' }],
      localeDirs: [
        { path: '/project/i18n', layer: 'root', layerRootDir: '/project' },
      ],
    }

    const elicited: ElicitedProjectInfo = {
      description: 'B2B SaaS booking platform',
      tone: 'formal',
    }

    const result = await generateProjectConfig(config, elicited)
    expect(result.context).toContain('B2B SaaS booking platform')
    expect(result.translationPrompt).toContain('formal')
  })
})
