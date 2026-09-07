import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, join } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readLocaleFile } from '../../src/io/json-reader.js'
import { getLeafKeys, getNestedValue } from '../../src/io/key-operations.js'
import type { I18nConfig } from '../../src/config/types.js'
import type { SearchKeyMatch, SearchMatch } from '../../src/core/types.js'
import { registerDetectorMock, registerFixtureConfig, playgroundDir, appAdminDir } from '../fixtures/mock-detector.js'

// Register the shared detector mock (vi.mock is hoisted by Vitest)
registerDetectorMock()

const { detectI18nConfig, clearConfigCache } = await import('../../src/config/detector.js')
const { searchTranslations, getMissingTranslations } = await import('../../src/core/operations.js')

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

/**
 * Two layers that both define common.actions.save, in two locales: the smallest
 * project in which grouping the matches by key has something to collapse.
 */
async function makeSearchProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-search-'))
  const rootLocales = join(dir, 'i18n', 'locales')
  const shopLocales = join(dir, 'app-shop', 'i18n', 'locales')
  await mkdir(rootLocales, { recursive: true })
  await mkdir(shopLocales, { recursive: true })

  await writeFile(join(rootLocales, 'en.json'), JSON.stringify({
    common: { actions: { save: 'Save changes', cancel: 'Cancel' } },
    messages: { welcome: 'Welcome, {name}!' },
  }))
  await writeFile(join(rootLocales, 'de.json'), JSON.stringify({
    common: { actions: { save: 'Änderungen speichern', cancel: 'Abbrechen' } },
    messages: { welcome: 'Willkommen, {name}!' },
  }))
  // app-shop duplicates the root key, which is what `layers` is there to show.
  await writeFile(join(shopLocales, 'en.json'), JSON.stringify({
    common: { actions: { save: 'Save changes' } },
    shop: { checkout: 'Checkout' },
  }))
  await writeFile(join(shopLocales, 'de.json'), JSON.stringify({
    common: { actions: { save: 'Änderungen speichern' } },
    shop: { checkout: 'Zur Kasse' },
  }))

  registerFixtureConfig(dir, {
    rootDir: dir,
    defaultLocale: 'en',
    fallbackLocale: { default: ['en'] },
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json' },
      { code: 'de', language: 'de-DE', file: 'de.json' },
    ],
    localeDirs: [
      { path: rootLocales, layer: 'root', layerRootDir: dir },
      { path: shopLocales, layer: 'app-shop', layerRootDir: join(dir, 'app-shop') },
    ],
    layerRootDirs: [dir, join(dir, 'app-shop')],
    apps: [{ name: 'app-shop', rootDir: join(dir, 'app-shop'), layers: ['app-shop', 'root'] }],
  })
  return dir
}

/**
 * The result shape, driven through the operation rather than replicated: how
 * many rows a caller pays for is the contract these assert.
 */
describe('searchTranslations result shape', () => {
  const SAVED_KEY: SearchKeyMatch = {
    key: 'common.actions.save',
    layers: ['root', 'app-shop'],
    value: 'Save changes',
    locale: 'en',
    localeCount: 2,
  }

  let searchDir: string

  beforeAll(async () => {
    searchDir = await makeSearchProject()
  })

  afterAll(async () => {
    await rm(searchDir, { recursive: true, force: true })
    clearConfigCache()
  })

  it('returns one row per key, however many locales and layers define it', async () => {
    const result = await searchTranslations({
      projectDir: searchDir,
      query: 'save',
      searchIn: 'values',
    })

    expect(result.matches).toEqual([SAVED_KEY])
    expect(result.totalMatches).toBe(1)
  })

  it('returns one row per key and locale when includeLocales asks for them', async () => {
    const result = await searchTranslations({
      projectDir: searchDir,
      query: 'save',
      searchIn: 'values',
      includeLocales: true,
    })

    const detail: SearchMatch[] = [
      { layer: 'root', locale: 'en', key: 'common.actions.save', value: 'Save changes' },
      { layer: 'app-shop', locale: 'en', key: 'common.actions.save', value: 'Save changes' },
    ]
    expect(result.matches).toEqual(detail)
    expect(result.totalMatches).toBe(2)
  })

  it('lists every layer that defines the key, not only the ones that matched', async () => {
    // Matches the German value in both layers, and answers with the reference
    // locale's value and both layers.
    const shared = await searchTranslations({
      projectDir: searchDir,
      query: 'speichern',
      searchIn: 'values',
    })

    expect(shared.matches).toEqual([SAVED_KEY])

    const appOnly = await searchTranslations({
      projectDir: searchDir,
      query: 'checkout',
      searchIn: 'both',
    })

    expect(appOnly.matches).toEqual([{
      key: 'shop.checkout',
      layers: ['app-shop'],
      value: 'Checkout',
      locale: 'en',
      localeCount: 2,
    }])
  })

  it('finds a value whose case, punctuation and spacing differ, in fuzzy mode', async () => {
    const args = { projectDir: searchDir, query: '  SAVE,  CHANGES! ', searchIn: 'values' } as const

    // The default is still a substring match, so the same query finds nothing.
    expect((await searchTranslations(args)).totalMatches).toBe(0)

    const fuzzy = await searchTranslations({ ...args, matchMode: 'fuzzy' })
    expect(fuzzy.matches).toEqual([SAVED_KEY])
  })

  it('leaves unrelated values alone in fuzzy mode', async () => {
    const result = await searchTranslations({
      projectDir: searchDir,
      query: 'delete the whole account',
      searchIn: 'values',
      matchMode: 'fuzzy',
    })

    expect(result.matches).toEqual([])
    expect(result.totalMatches).toBe(0)
  })

  it('compares a normalized query against the reference locale unless a locale is named', async () => {
    const args = { projectDir: searchDir, query: 'anderungen speichern', searchIn: 'values', matchMode: 'exact' } as const

    // English is the reference locale here, and no English value says this.
    expect((await searchTranslations(args)).totalMatches).toBe(0)

    const german = await searchTranslations({ ...args, locale: 'de' })
    expect(german.matches).toEqual([{
      key: 'common.actions.save',
      layers: ['root', 'app-shop'],
      value: 'Änderungen speichern',
      locale: 'de',
      localeCount: 1,
    }])
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

/**
 * Two layers whose German file lags behind the English one, in a project with
 * enough missing keys to cap: what a caller reads a window of.
 */
async function makePagingProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-paging-'))
  const rootLocales = join(dir, 'i18n', 'locales')
  const shopLocales = join(dir, 'app-shop', 'i18n', 'locales')
  await mkdir(rootLocales, { recursive: true })
  await mkdir(shopLocales, { recursive: true })

  await writeFile(join(rootLocales, 'en.json'), JSON.stringify({
    common: { actions: { save: 'Save', cancel: 'Cancel', close: 'Close' } },
  }))
  await writeFile(join(rootLocales, 'de.json'), JSON.stringify({
    common: { actions: { save: 'Speichern' } },
  }))
  await writeFile(join(shopLocales, 'en.json'), JSON.stringify({
    shop: { checkout: 'Checkout', basket: 'Basket' },
  }))
  await writeFile(join(shopLocales, 'de.json'), '{}')

  registerFixtureConfig(dir, {
    rootDir: dir,
    defaultLocale: 'en',
    fallbackLocale: { default: ['en'] },
    locales: [
      { code: 'en', language: 'en-US', file: 'en.json' },
      { code: 'de', language: 'de-DE', file: 'de.json' },
    ],
    localeDirs: [
      { path: rootLocales, layer: 'root', layerRootDir: dir },
      { path: shopLocales, layer: 'app-shop', layerRootDir: join(dir, 'app-shop') },
    ],
    layerRootDirs: [dir, join(dir, 'app-shop')],
    apps: [{ name: 'app-shop', rootDir: join(dir, 'app-shop'), layers: ['app-shop', 'root'] }],
  })
  return dir
}

/**
 * The cap both reads gained. An agent used to pay for every row a query
 * matched — 289 KB for one substring — with nothing to ask for less.
 */
describe('limit and offset on the unbounded reads', () => {
  let pagingDir: string

  beforeAll(async () => {
    pagingDir = await makePagingProject()
  })

  afterAll(async () => {
    await rm(pagingDir, { recursive: true, force: true })
    clearConfigCache()
  })

  it('returns the whole answer when no limit is given', async () => {
    const result = await searchTranslations({ projectDir: pagingDir, query: 'common', searchIn: 'keys' })

    expect(result.matches).toHaveLength(3)
    expect(result.truncated).toBe(false)
    expect(result).not.toHaveProperty('nextOffset')
  })

  it('caps search rows and says where the next page starts', async () => {
    const result = await searchTranslations({
      projectDir: pagingDir,
      query: 'common',
      searchIn: 'keys',
      limit: 2,
    })

    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBe(2)
  })

  it('counts every match in totalMatches, whatever the limit let through', async () => {
    const full = await searchTranslations({ projectDir: pagingDir, query: 'common', searchIn: 'keys' })
    const capped = await searchTranslations({
      projectDir: pagingDir,
      query: 'common',
      searchIn: 'keys',
      limit: 1,
    })

    expect(capped.totalMatches).toBe(full.totalMatches)
    expect(capped.matches).toHaveLength(1)
  })

  it('continues a truncated search from nextOffset without repeating a row', async () => {
    const first = await searchTranslations({
      projectDir: pagingDir,
      query: 'common',
      searchIn: 'keys',
      limit: 2,
    })
    const second = await searchTranslations({
      projectDir: pagingDir,
      query: 'common',
      searchIn: 'keys',
      limit: 2,
      offset: first.nextOffset,
    })

    expect(second.matches).toHaveLength(1)
    expect(second.truncated).toBe(false)

    const keys = [...first.matches, ...second.matches].map(match => match.key)
    expect(new Set(keys).size).toBe(3)
  })

  it('caps the per-locale rows too, when includeLocales asks for them', async () => {
    const result = await searchTranslations({
      projectDir: pagingDir,
      query: 'common',
      searchIn: 'keys',
      includeLocales: true,
      limit: 2,
    })

    expect(result.matches).toHaveLength(2)
    expect(result.totalMatches).toBe(4)
    expect(result.nextOffset).toBe(2)
  })

  it('caps missing keys over the flattened locale/layer/key list', async () => {
    const full = await getMissingTranslations({ projectDir: pagingDir })
    expect(full.summary.totalMissingKeys).toBe(4)
    expect(full.truncated).toBe(false)

    const capped = await getMissingTranslations({ projectDir: pagingDir, limit: 2 })
    const listed = Object.values(capped.missing)
      .flatMap(byLayer => Object.values(byLayer))
      .flat()

    expect(listed).toHaveLength(2)
    expect(capped.truncated).toBe(true)
    expect(capped.nextOffset).toBe(2)
  })

  it('leaves totalMissingKeys the count for the whole project', async () => {
    const capped = await getMissingTranslations({ projectDir: pagingDir, limit: 1 })

    expect(capped.summary.totalMissingKeys).toBe(4)
    expect(capped.summary.layersScanned).toEqual(['root', 'app-shop'])
  })

  it('continues a truncated missing read from nextOffset', async () => {
    const first = await getMissingTranslations({ projectDir: pagingDir, limit: 3 })
    const second = await getMissingTranslations({ projectDir: pagingDir, offset: first.nextOffset })

    const keysOf = (result: Awaited<ReturnType<typeof getMissingTranslations>>) =>
      Object.entries(result.missing).flatMap(([locale, byLayer]) =>
        Object.entries(byLayer).flatMap(([layer, keys]) => keys.map(key => `${locale}/${layer}/${key}`)))

    expect(keysOf(second)).toHaveLength(1)
    expect(second.truncated).toBe(false)
    expect(new Set([...keysOf(first), ...keysOf(second)]).size).toBe(4)
  })
})
