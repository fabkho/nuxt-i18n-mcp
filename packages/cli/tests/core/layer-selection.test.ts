import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { I18nConfig } from '../../src/config/types.js'
import { registerDetectorMock, registerFixtureConfig } from '../fixtures/mock-detector.js'

registerDetectorMock()

const {
  findEmptyTranslations,
  findOrphanKeys,
  getMissingTranslations,
  getTranslationStatus,
  listNamespaces,
  searchTranslations,
} = await import('../../src/core/operations.js')

/**
 * One project with an alias layer, so that "every layer" and "the layer named
 * `*`" can be told apart from "every locale dir".
 */
let projectDir: string

async function writeLocale(dir: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), JSON.stringify(data, null, 2))
}

function configFor(dir: string): I18nConfig {
  const shopDir = resolve(dir, 'app-shop')
  const outlookDir = resolve(dir, 'app-outlook')
  return {
    rootDir: dir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: [
      { code: 'de', language: 'de-DE', file: 'de-DE.json' },
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ],
    localeDirs: [
      { path: resolve(dir, 'i18n/locales'), layer: 'root', layerRootDir: dir },
      { path: resolve(shopDir, 'i18n/locales'), layer: 'app-shop', layerRootDir: shopDir },
      // Points at app-shop's directory: scanning both would count its keys twice.
      { path: resolve(shopDir, 'i18n/locales'), layer: 'app-outlook', layerRootDir: outlookDir, aliasOf: 'app-shop' },
    ],
    layerRootDirs: [dir, shopDir, outlookDir],
    apps: [
      { name: 'app-shop', rootDir: shopDir, layers: ['app-shop', 'root'] },
      { name: 'app-outlook', rootDir: outlookDir, layers: ['app-outlook', 'root'] },
    ],
  }
}

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'layer-selection-'))
  const rootLocales = resolve(projectDir, 'i18n/locales')
  const shopLocales = resolve(projectDir, 'app-shop/i18n/locales')

  await writeLocale(rootLocales, 'de-DE.json', { common: { save: 'Speichern', blank: '' } })
  await writeLocale(rootLocales, 'en-US.json', { common: { save: 'Save', blank: '' } })
  await writeLocale(shopLocales, 'de-DE.json', { shop: { cart: 'Warenkorb' } })
  await writeLocale(shopLocales, 'en-US.json', {})

  registerFixtureConfig(projectDir, configFor(projectDir))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('layer selection', () => {
  it('status scans every non-alias layer for "*", the same as for an omitted layer', async () => {
    const starred = await getTranslationStatus({ projectDir, layer: '*' })
    const omitted = await getTranslationStatus({ projectDir })

    expect(starred.summary.layersScanned).toEqual(['root', 'app-shop'])
    expect(starred.summary.layersScanned).toEqual(omitted.summary.layersScanned)
  })

  it('missing scans every non-alias layer for "*"', async () => {
    const starred = await getMissingTranslations({ projectDir, layer: '*' })
    const omitted = await getMissingTranslations({ projectDir })

    expect(starred.summary.layersScanned).toEqual(['root', 'app-shop'])
    expect(starred.summary.layersScanned).toEqual(omitted.summary.layersScanned)
  })

  it('search scans every non-alias layer for "*"', async () => {
    const starred = await searchTranslations({ projectDir, query: 'a', layer: '*', includeLocales: true })
    const omitted = await searchTranslations({ projectDir, query: 'a', includeLocales: true })

    expect(starred.totalMatches).toBe(omitted.totalMatches)
    const layers = new Set((starred.matches as Array<{ layer: string }>).map(m => m.layer))
    expect([...layers].sort()).toEqual(['app-shop', 'root'])
  })

  it('empty-translation and namespace listings accept "*"', async () => {
    const empty = await findEmptyTranslations({ projectDir, layer: '*' })
    expect(empty.summary.layersChecked).toEqual(['root', 'app-shop'])

    const namespaces = await listNamespaces({ projectDir, layer: '*' })
    expect(Object.keys(namespaces.layers).sort()).toEqual(['app-shop', 'root'])
  })

  it('the orphan scan accepts "*"', async () => {
    const result = await findOrphanKeys({ projectDir, layer: '*' })
    expect(result.summary.layersChecked).toEqual(['root', 'app-shop'])
  })

  it('rejects an unknown layer name with LAYER_NOT_FOUND everywhere', async () => {
    const calls = [
      () => getTranslationStatus({ projectDir, layer: 'nope' }),
      () => getMissingTranslations({ projectDir, layer: 'nope' }),
      () => searchTranslations({ projectDir, query: 'a', layer: 'nope' }),
      () => findEmptyTranslations({ projectDir, layer: 'nope' }),
      () => listNamespaces({ projectDir, layer: 'nope' }),
      () => findOrphanKeys({ projectDir, layer: 'nope' }),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'LAYER_NOT_FOUND' })
    }
  })

  it('refuses an alias layer by name rather than scanning its target twice', async () => {
    await expect(findOrphanKeys({ projectDir, layer: 'app-outlook' }))
      .rejects.toMatchObject({ code: 'LAYER_IS_ALIAS' })
  })
})
