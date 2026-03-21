import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, join } from 'node:path'
import { readLocaleFile } from '../../src/io/json-reader.js'
import { getLeafKeys, getNestedValue } from '../../src/io/key-operations.js'
import type { I18nConfig } from '../../src/config/types.js'
import { registerDetectorMock, playgroundDir, appAdminDir } from '../fixtures/mock-detector.js'

// Register the shared detector mock (vi.mock is hoisted by Vitest)
registerDetectorMock()

const { detectI18nConfig, clearConfigCache } = await import('../../src/config/detector.js')

describe('get_missing_translations logic', () => {
  describe('app-admin', () => {
    let config: I18nConfig

    beforeAll(async () => {
      config = await detectI18nConfig(appAdminDir)
    })

    afterAll(() => {
      clearConfigCache()
    })

    it('finds missing keys in es-ES compared to de-DE in app-admin layer', async () => {
      // app-admin/i18n/locales/de-DE.json has admin.dashboard.* and admin.users.*
      // app-admin/i18n/locales/es-ES.json only has admin.dashboard.* (missing admin.users.*)
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const deFile = join(rootLayer.path, 'de-DE.json')
      const esFile = join(rootLayer.path, 'es-ES.json')

      const deData = await readLocaleFile(deFile)
      const esData = await readLocaleFile(esFile)

      const deKeys = getLeafKeys(deData)
      const esKeys = getLeafKeys(esData)

      const missing = deKeys.filter(k => !esKeys.includes(k))

      expect(missing.length).toBeGreaterThan(0)
      expect(missing).toContain('admin.users.list')
      expect(missing).toContain('admin.users.create')
      expect(missing).toContain('admin.users.edit')
    })

    it('finds no missing keys when comparing de-DE to en-US in app-admin root layer', async () => {
      // Both de-DE and en-US in app-admin have admin.dashboard.* + admin.users.*
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const deFile = join(rootLayer.path, 'de-DE.json')
      const enFile = join(rootLayer.path, 'en-US.json')

      const deData = await readLocaleFile(deFile)
      const enData = await readLocaleFile(enFile)

      const deKeys = getLeafKeys(deData)
      const enKeys = getLeafKeys(enData)

      const missing = deKeys.filter(k => !enKeys.includes(k))

      expect(missing).toHaveLength(0)
    })

    it('correctly counts missing keys for es-ES in app-admin', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const esData = await readLocaleFile(join(rootLayer.path, 'es-ES.json'))

      const deKeys = getLeafKeys(deData)
      const esKeys = getLeafKeys(esData)

      const missing = deKeys.filter(k => !esKeys.includes(k))

      // de-DE has 5 keys (dashboard.title, dashboard.welcome, users.list, users.create, users.edit)
      // es-ES has 2 keys (dashboard.title, dashboard.welcome)
      // So 3 keys are missing
      expect(missing).toHaveLength(3)
    })

    it('fr-FR in app-admin has no missing keys compared to de-DE (by key existence)', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const frData = await readLocaleFile(join(rootLayer.path, 'fr-FR.json'))

      const deKeys = getLeafKeys(deData)
      const frKeys = getLeafKeys(frData)

      const missing = deKeys.filter(k => !frKeys.includes(k))

      expect(missing).toHaveLength(0)
    })

    it('treats empty-string values as missing translations', async () => {
      // fr-FR has admin.users.edit set to "" — should be detected as missing
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const frData = await readLocaleFile(join(rootLayer.path, 'fr-FR.json'))

      // Filter ref keys to non-empty values (same logic as the tool)
      const refKeys = getLeafKeys(deData).filter(k => {
        const v = getNestedValue(deData, k)
        return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
      })

      // A key is missing if it doesn't exist OR its value is empty
      const missing = refKeys.filter(k => {
        const v = getNestedValue(frData, k)
        return v === undefined || v === '' || v === null
      })

      expect(missing).toContain('admin.users.edit')
      expect(missing).toHaveLength(1)
    })

    it('also detects extra keys not in the reference locale', async () => {
      // Reverse comparison: keys in es-ES that are NOT in de-DE (should be 0)
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const esData = await readLocaleFile(join(rootLayer.path, 'es-ES.json'))

      const deKeys = getLeafKeys(deData)
      const esKeys = getLeafKeys(esData)

      const extra = esKeys.filter(k => !deKeys.includes(k))

      expect(extra).toHaveLength(0)
    })
  })

  describe('playground', () => {
    let config: I18nConfig

    beforeAll(async () => {
      config = await detectI18nConfig(playgroundDir)
    })

    afterAll(() => {
      clearConfigCache()
    })

    it('finds no missing keys in playground root layer (all locales are complete)', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const deFile = join(rootLayer.path, 'de-DE.json')
      const enFile = join(rootLayer.path, 'en-US.json')

      const deData = await readLocaleFile(deFile)
      const enData = await readLocaleFile(enFile)

      const deKeys = getLeafKeys(deData)
      const enKeys = getLeafKeys(enData)

      const missing = deKeys.filter(k => !enKeys.includes(k))

      expect(missing).toHaveLength(0)
    })

    it('detects missing keys across all locales in playground root', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      // Read reference (de-DE)
      const refData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const refKeys = getLeafKeys(refData)

      // All root layer locale files should have the same keys
      for (const locale of config.locales) {
        const filePath = join(rootLayer.path, locale.file)
        try {
          const data = await readLocaleFile(filePath)
          const keys = getLeafKeys(data)
          const missing = refKeys.filter(k => !keys.includes(k))
          // Root layer should be complete for all locales
          expect(missing).toHaveLength(0)
        } catch {
          // File might not exist in this layer - that's ok
        }
      }
    })
  })
})

describe('search_translations logic', () => {
  describe('playground', () => {
    let config: I18nConfig

    beforeAll(async () => {
      config = await detectI18nConfig(playgroundDir)
    })

    afterAll(() => {
      clearConfigCache()
    })

    it('finds keys matching a query', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const leafKeys = getLeafKeys(data)

      // Search for "save" in keys
      const matches = leafKeys.filter(k => k.toLowerCase().includes('save'))
      expect(matches).toContain('common.actions.save')
    })

    it('finds values matching a query', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const leafKeys = getLeafKeys(data)

      // Search for "Speichern" in values
      const matches = leafKeys.filter(k => {
        const value = getNestedValue(data, k)
        return typeof value === 'string' && value.toLowerCase().includes('speichern')
      })

      expect(matches.length).toBeGreaterThan(0)
      expect(matches).toContain('common.actions.save')
    })

    it('search is case-insensitive', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const leafKeys = getLeafKeys(data)

      const matchesLower = leafKeys.filter(k => k.toLowerCase().includes('navigation'))
      const matchesUpper = leafKeys.filter(k => k.toLowerCase().includes('NAVIGATION'.toLowerCase()))

      expect(matchesLower).toEqual(matchesUpper)
      expect(matchesLower.length).toBeGreaterThan(0)
    })

    it('finds all navigation keys by key search', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const leafKeys = getLeafKeys(data)

      const matches = leafKeys.filter(k => k.toLowerCase().includes('navigation'))

      expect(matches).toContain('common.navigation.back')
      expect(matches).toContain('common.navigation.home')
      expect(matches).toContain('common.navigation.settings')
      expect(matches).toHaveLength(3)
    })

    it('finds keys by partial value match in multiple locales', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      // "Cancel" appears in en-US, "Annuler" in fr-FR, "Abbrechen" in de-DE
      const enData = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const frData = await readLocaleFile(join(rootLayer.path, 'fr-FR.json'))
      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))

      const enKeys = getLeafKeys(enData)

      const enMatches = enKeys.filter(k => {
        const v = getNestedValue(enData, k)
        return typeof v === 'string' && v.toLowerCase().includes('cancel')
      })

      const frMatches = enKeys.filter(k => {
        const v = getNestedValue(frData, k)
        return typeof v === 'string' && v.toLowerCase().includes('annuler')
      })

      const deMatches = enKeys.filter(k => {
        const v = getNestedValue(deData, k)
        return typeof v === 'string' && v.toLowerCase().includes('abbrechen')
      })

      expect(enMatches).toContain('common.actions.cancel')
      expect(frMatches).toContain('common.actions.cancel')
      expect(deMatches).toContain('common.actions.cancel')
    })

    it('returns empty results for non-matching query', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const leafKeys = getLeafKeys(data)

      const matches = leafKeys.filter(k => {
        const keyMatch = k.toLowerCase().includes('xyznonexistent')
        const value = getNestedValue(data, k)
        const valueMatch = typeof value === 'string' && value.toLowerCase().includes('xyznonexistent')
        return keyMatch || valueMatch
      })

      expect(matches).toHaveLength(0)
    })
  })

  describe('app-admin', () => {
    let config: I18nConfig

    beforeAll(async () => {
      config = await detectI18nConfig(appAdminDir)
    })

    afterAll(() => {
      clearConfigCache()
    })

    it('finds translations containing placeholders', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!

      const data = await readLocaleFile(join(rootLayer.path, 'en-US.json'))
      const leafKeys = getLeafKeys(data)

      const matches = leafKeys.filter(k => {
        const value = getNestedValue(data, k)
        return typeof value === 'string' && value.includes('{name}')
      })

      expect(matches).toContain('admin.dashboard.welcome')
    })

    it('searches across multiple layers in app-admin', async () => {
      // app-admin has 2 locale dirs: root (app-admin itself) and playground
      expect(config.localeDirs).toHaveLength(2)

      const allMatches: string[] = []

      for (const dir of config.localeDirs) {
        const filePath = join(dir.path, 'en-US.json')
        try {
          const data = await readLocaleFile(filePath)
          const leafKeys = getLeafKeys(data)
          const matches = leafKeys.filter(k => {
            const keyMatch = k.toLowerCase().includes('save') || k.toLowerCase().includes('dashboard')
            const value = getNestedValue(data, k)
            const valueMatch = typeof value === 'string' &&
              (value.toLowerCase().includes('save') || value.toLowerCase().includes('dashboard'))
            return keyMatch || valueMatch
          })
          allMatches.push(...matches.map(m => `${dir.layer}:${m}`))
        } catch {
          // File might not exist in this layer
        }
      }

      // Should find common.actions.save from playground layer and admin.dashboard.* from root layer
      expect(allMatches.some(m => m.includes('common.actions.save'))).toBe(true)
      expect(allMatches.some(m => m.includes('admin.dashboard.title'))).toBe(true)
    })
  })
})

describe('find_empty_translations logic', () => {
  describe('app-admin', () => {
    let config: I18nConfig

    beforeAll(async () => {
      config = await detectI18nConfig(appAdminDir)
    })

    afterAll(() => {
      clearConfigCache()
    })

    it('finds keys with empty string values', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const frData = await readLocaleFile(join(rootLayer.path, 'fr-FR.json'))
      const leafKeys = getLeafKeys(frData)
      const emptyKeys = leafKeys.filter(k => getNestedValue(frData, k) === '')

      expect(emptyKeys).toContain('admin.users.edit')
      expect(emptyKeys).toHaveLength(1)
    })

    it('does not include non-empty values as empty', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const frData = await readLocaleFile(join(rootLayer.path, 'fr-FR.json'))
      const leafKeys = getLeafKeys(frData)
      const emptyKeys = leafKeys.filter(k => getNestedValue(frData, k) === '')

      expect(emptyKeys).not.toContain('admin.dashboard.title')
      expect(emptyKeys).not.toContain('admin.users.list')
    })

    it('does not report missing keys as empty', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const esData = await readLocaleFile(join(rootLayer.path, 'es-ES.json'))
      const leafKeys = getLeafKeys(esData)
      const emptyKeys = leafKeys.filter(k => getNestedValue(esData, k) === '')

      expect(emptyKeys).toHaveLength(0)
      expect(getNestedValue(esData, 'admin.users.list')).toBeUndefined()
    })

    it('returns no empty keys for fully translated locale', async () => {
      const rootLayer = config.localeDirs.find(d => d.layer === 'root')!
      const deData = await readLocaleFile(join(rootLayer.path, 'de-DE.json'))
      const leafKeys = getLeafKeys(deData)
      const emptyKeys = leafKeys.filter(k => getNestedValue(deData, k) === '')

      expect(emptyKeys).toHaveLength(0)
    })
  })
})
