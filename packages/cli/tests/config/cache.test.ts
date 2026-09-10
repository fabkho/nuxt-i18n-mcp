import { describe, it, expect, afterAll } from 'vitest'
import { resolve } from 'node:path'
import { detectI18nConfig } from '../../src/config/detector.js'
import { clearConfigCache, clearConfigCacheFor, getCachedConfig } from '../../src/config/cache.js'
import { tmpProject } from './tmp-project.js'

const project = tmpProject('config-cache')

async function writeConfig(config: Record<string, unknown>, into?: string) {
  await project.write('.i18n-mcp.json', JSON.stringify(config), into)
}

async function writeGenericProject(into: string, defaultLocale: string) {
  await project.write('locales/en.json', '{}', into)
  await project.write('locales/de.json', '{}', into)
  await writeConfig({ localeDirs: ['locales'], defaultLocale }, into)
}

describe('clearConfigCache', () => {
  afterAll(() => {
    clearConfigCache()
  })

  // The MCP server runs for as long as the editor does and clears the cache
  // before re-detecting. Anything still holding the old project — an adapter
  // remembering what it read, say — answers with a config the user has already
  // changed.
  it('makes the next detection read an edited .i18n-mcp.json', async () => {
    await project.write('locales/en.json', '{}')
    await project.write('locales/de.json', '{}')
    await writeConfig({ localeDirs: ['locales'], defaultLocale: 'en' })

    const before = await detectI18nConfig(project.dir)
    expect(before.defaultLocale).toBe('en')
    expect(before.locales.map(l => l.code)).toEqual(['de', 'en'])

    await writeConfig({ localeDirs: ['locales'], defaultLocale: 'de', locales: ['de'] })
    clearConfigCache()

    const after = await detectI18nConfig(project.dir)
    expect(after.defaultLocale).toBe('de')
    expect(after.locales.map(l => l.code)).toEqual(['de'])
  })

  it('keeps serving the cached config until it is cleared', async () => {
    await project.write('locales/en.json', '{}')
    await writeConfig({ localeDirs: ['locales'], defaultLocale: 'en' })

    const first = await detectI18nConfig(project.dir)
    await writeConfig({ localeDirs: ['locales'], defaultLocale: 'xx' })

    expect(await detectI18nConfig(project.dir)).toBe(first)
  })
})

describe('clearConfigCacheFor', () => {
  afterAll(() => {
    clearConfigCache()
  })

  it('forgets one project and leaves the others cached', async () => {
    const other = resolve(project.dir, '../other')
    await writeGenericProject(project.dir, 'en')
    await writeGenericProject(other, 'de')

    const first = await detectI18nConfig(project.dir)
    const second = await detectI18nConfig(other)

    clearConfigCacheFor(project.dir)

    expect(await detectI18nConfig(project.dir)).not.toBe(first)
    expect(await detectI18nConfig(other)).toBe(second)
  })

  it('leaves getCachedConfig pointing at something still cached', async () => {
    await writeGenericProject(project.dir, 'en')

    const config = await detectI18nConfig(project.dir)
    expect(getCachedConfig()).toBe(config)

    clearConfigCacheFor(project.dir)

    expect(getCachedConfig()).toBeNull()
  })
})
