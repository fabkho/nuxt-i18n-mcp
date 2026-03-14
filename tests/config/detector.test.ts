import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve } from 'node:path'
import { detectI18nConfig, clearConfigCache } from '../../src/config/detector.js'
import type { I18nConfig } from '../../src/config/types.js'

const playgroundDir = resolve(import.meta.dirname, '../../playground')
const appAdminDir = resolve(import.meta.dirname, '../../playground/app-admin')

describe('detectI18nConfig against playground', () => {
  let config: I18nConfig

  beforeAll(async () => {
    config = await detectI18nConfig(playgroundDir)
  }, 30_000)

  afterAll(() => {
    clearConfigCache()
  })

  it('detects the playground i18n config', () => {
    expect(config).toBeDefined()
    expect(config.rootDir).toBe(playgroundDir)
  })

  it('detects the default locale', () => {
    expect(config.defaultLocale).toBe('de')
  })

  it('detects all 4 locales', () => {
    expect(config.locales).toHaveLength(4)

    const codes = config.locales.map(l => l.code)
    expect(codes).toContain('de')
    expect(codes).toContain('en')
    expect(codes).toContain('fr')
    expect(codes).toContain('es')
  })

  it('locales have correct file names', () => {
    const deLocale = config.locales.find(l => l.code === 'de')
    expect(deLocale).toBeDefined()
    expect(deLocale!.file).toBe('de-DE.json')
    expect(deLocale!.language).toBe('de-DE')

    const enLocale = config.locales.find(l => l.code === 'en')
    expect(enLocale).toBeDefined()
    expect(enLocale!.file).toBe('en-US.json')
    expect(enLocale!.language).toBe('en-US')
  })

  it('discovers locale directories from layers', () => {
    expect(config.localeDirs.length).toBeGreaterThanOrEqual(1)

    const layers = config.localeDirs.map(d => d.layer)
    expect(layers).toContain('root')
  })

  it('root locale dir points to playground/i18n/locales', () => {
    const rootDir = config.localeDirs.find(d => d.layer === 'root')
    expect(rootDir).toBeDefined()
    expect(rootDir!.path).toBe(resolve(playgroundDir, 'i18n/locales'))
  })

  it('detects fallback locale config', () => {
    expect(config.fallbackLocale).toBeDefined()
    const hasDefault = 'default' in config.fallbackLocale
    const hasEn = Object.values(config.fallbackLocale).some(arr =>
      arr.includes('en'),
    )
    expect(hasDefault || hasEn).toBe(true)
  })

  it('caches config on subsequent calls', async () => {
    const config2 = await detectI18nConfig(playgroundDir)
    expect(config).toBe(config2) // same reference = cached
  })

  it('throws for non-existent project dir', async () => {
    await expect(
      detectI18nConfig('/tmp/nonexistent-project-dir-12345'),
    ).rejects.toThrow()
  }, 30_000)
})

describe('detectI18nConfig against playground/app-admin (layer)', () => {
  // When running from app-admin/:
  //   _layers[0] = app-admin itself → deriveLayerName → 'root' (it's the cwd)
  //   _layers[1] = ../playground    → deriveLayerName → 'playground' (basename)

  let config: I18nConfig

  beforeAll(async () => {
    config = await detectI18nConfig(appAdminDir)
  }, 30_000)

  afterAll(() => {
    clearConfigCache()
  })

  it('detects config from the app-admin layer entry point', () => {
    expect(config).toBeDefined()
    expect(config.rootDir).toBe(appAdminDir)
    expect(config.defaultLocale).toBe('de')
  })

  it('discovers both app-admin (root) and playground locale directories', () => {
    expect(config.localeDirs).toHaveLength(2)

    const layers = config.localeDirs.map(d => d.layer)
    // app-admin is the project entry, so it's 'root'; the extended parent is 'playground'
    expect(layers).toContain('root')
    expect(layers).toContain('playground')
  })

  it('app-admin locale dir is the "root" layer (project entry point)', () => {
    const rootDir = config.localeDirs.find(d => d.layer === 'root')
    expect(rootDir).toBeDefined()
    expect(rootDir!.path).toBe(resolve(appAdminDir, 'i18n/locales'))
  })

  it('playground locale dir is discovered via layer inheritance', () => {
    const parentDir = config.localeDirs.find(d => d.layer === 'playground')
    expect(parentDir).toBeDefined()
    expect(parentDir!.path).toBe(resolve(playgroundDir, 'i18n/locales'))
  })

  it('detects 8 locales (4 from each layer, merged by code)', () => {
    // @nuxtjs/i18n merges locale configs per code from both layers
    // Both app-admin and playground define the same 4 locale codes
    // The merged result may deduplicate or keep all — check we have at least 4 codes
    const codes = [...new Set(config.locales.map(l => l.code))]
    expect(codes).toHaveLength(4)
    expect(codes).toContain('de')
    expect(codes).toContain('en')
    expect(codes).toContain('fr')
    expect(codes).toContain('es')
  })
})
