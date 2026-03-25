import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve } from 'node:path'
import { detectI18nConfig, clearConfigCache, discoverNuxtApps } from '../../src/config/detector.js'
import type { I18nConfig } from '../../src/config/types.js'

const projectRootDir = resolve(import.meta.dirname, '../..')
const playgroundDir = resolve(projectRootDir, 'playground')
const appAdminDir = resolve(playgroundDir, 'app-admin')

describe('detectI18nConfig real monorepo merge (no mock)', () => {
  let config: I18nConfig

  beforeAll(async () => {
    clearConfigCache()
    config = await detectI18nConfig(projectRootDir)
  }, 60_000)

  afterAll(() => {
    clearConfigCache()
  })

  it('sets rootDir to the monorepo discovery root', () => {
    expect(config.rootDir).toBe(projectRootDir)
  })

  it('discovers playground as a Nuxt app via real loadNuxt', () => {
    const layers = config.localeDirs.map(d => d.layer)
    expect(layers).toContain('playground')
  })

  it('merges locale directories from discovered apps', () => {
    expect(config.localeDirs.length).toBeGreaterThanOrEqual(1)
    const playgroundLocaleDir = config.localeDirs.find(d => d.layer === 'playground')
    expect(playgroundLocaleDir).toBeDefined()
    expect(playgroundLocaleDir!.path).toBe(resolve(playgroundDir, 'i18n/locales'))
  })

  it('extracts locales from real Nuxt config', () => {
    expect(config.locales.length).toBeGreaterThanOrEqual(1)
    const codes = config.locales.map(l => l.code)
    expect(codes).toContain('de')
    expect(codes).toContain('en')
  })

  it('extracts default locale from first discovered app', () => {
    expect(config.defaultLocale).toBe('de')
  })

  it('includes layerRootDirs from merged apps', () => {
    expect(config.layerRootDirs).toContain(playgroundDir)
  })

  it('layer names are unique across merged locale dirs', () => {
    const nonAliasLayers = config.localeDirs
      .filter(d => !d.aliasOf)
      .map(d => d.layer)
    const uniqueLayers = new Set(nonAliasLayers)
    expect(uniqueLayers.size).toBe(nonAliasLayers.length)
  })
})

describe('discoverNuxtApps returns deterministic order', () => {
  it('returns sorted app paths on repeated calls', async () => {
    const first = await discoverNuxtApps(projectRootDir)
    const second = await discoverNuxtApps(projectRootDir)
    expect(first).toEqual(second)

    const sorted = [...first].sort((a, b) =>
      resolve(a).localeCompare(resolve(b)),
    )
    expect(first).toEqual(sorted)
  })
})
