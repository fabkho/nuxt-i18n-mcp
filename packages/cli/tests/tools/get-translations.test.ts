import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { registerDetectorMock, registerFixtureConfig } from '../fixtures/mock-detector.js'

/**
 * What `get` answers, and in which of its two shapes.
 *
 * The named-layer shape is the contract every existing caller reads, so the
 * first test here is that it did not move; everything after it is the shape a
 * layer-less read added, and the cap both of them take.
 */

registerDetectorMock()

const { clearConfigCache } = await import('../../src/config/detector.js')
const { getTranslations } = await import('../../src/core/operations.js')

/** Three layers: two define auth keys, one defines none of them. */
async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-get-'))
  const rootLocales = join(dir, 'i18n', 'locales')
  const shopLocales = join(dir, 'app-shop', 'i18n', 'locales')
  const blogLocales = join(dir, 'app-blog', 'i18n', 'locales')
  for (const path of [rootLocales, shopLocales, blogLocales]) {
    await mkdir(path, { recursive: true })
  }

  await writeFile(join(rootLocales, 'en.json'), JSON.stringify({
    auth: { login: { title: 'Sign in', subtitle: 'Welcome back' }, logout: 'Sign out' },
    common: { save: 'Save' },
  }))
  await writeFile(join(rootLocales, 'de.json'), JSON.stringify({
    auth: { login: { title: 'Anmelden', subtitle: 'Willkommen zurück' }, logout: 'Abmelden' },
    common: { save: 'Speichern' },
  }))
  await writeFile(join(shopLocales, 'en.json'), JSON.stringify({
    auth: { login: { title: 'Shop sign in' } },
    shop: { checkout: 'Checkout' },
  }))
  await writeFile(join(shopLocales, 'de.json'), JSON.stringify({
    auth: { login: { title: 'Shop-Anmeldung' } },
    shop: { checkout: 'Zur Kasse' },
  }))
  await writeFile(join(blogLocales, 'en.json'), JSON.stringify({ blog: { post: 'Post' } }))
  await writeFile(join(blogLocales, 'de.json'), JSON.stringify({ blog: { post: 'Beitrag' } }))

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
      { path: blogLocales, layer: 'app-blog', layerRootDir: join(dir, 'app-blog') },
    ],
    layerRootDirs: [dir, join(dir, 'app-shop'), join(dir, 'app-blog')],
    apps: [
      { name: 'app-shop', rootDir: join(dir, 'app-shop'), layers: ['app-shop', 'root'] },
      { name: 'app-blog', rootDir: join(dir, 'app-blog'), layers: ['app-blog', 'root'] },
    ],
  })
  return dir
}

let projectDir: string

beforeAll(async () => {
  projectDir = await makeProject()
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  clearConfigCache()
})

describe('getTranslations with a layer', () => {
  it('answers with the locale map it always answered with', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keys: ['auth.login.title', 'auth.nope'],
    })

    expect(result).toEqual({ en: { 'auth.login.title': 'Sign in', 'auth.nope': null } })
  })

  it('reads every locale for "*", and adds no paging field to an uncapped read', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: '*',
      keys: ['common.save'],
    })

    expect(result).toEqual({ en: { 'common.save': 'Save' }, de: { 'common.save': 'Speichern' } })
    expect(result).not.toHaveProperty('truncated')
  })
})

describe('getTranslations by key prefix', () => {
  it('returns every leaf key under the prefix', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keyPrefix: 'auth.login',
    })

    expect(result).toEqual({
      en: { 'auth.login.subtitle': 'Welcome back', 'auth.login.title': 'Sign in' },
    })
  })

  it('treats an exact leaf key as its own prefix', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keyPrefix: 'auth.logout',
    })

    expect(result).toEqual({ en: { 'auth.logout': 'Sign out' } })
  })

  it('reads the union when both keys and keyPrefix are given', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keys: ['common.save'],
      keyPrefix: 'auth.logout',
    })

    expect(result).toEqual({ en: { 'auth.logout': 'Sign out', 'common.save': 'Save' } })
  })

  it('fails with EARG when neither keys nor keyPrefix is given', async () => {
    await expect(getTranslations({ projectDir, layer: 'root', locale: 'en' }))
      .rejects.toMatchObject({ code: 'EARG' })

    // An empty list is the same request as none: a read with no subject.
    await expect(getTranslations({ projectDir, layer: 'root', locale: 'en', keys: [] }))
      .rejects.toMatchObject({ code: 'EARG' })
  })
})

describe('getTranslations without a layer', () => {
  it('lists only the layers that define one of the keys', async () => {
    const result = await getTranslations({ projectDir, locale: 'en', keyPrefix: 'auth' })

    expect('byLayer' in result).toBe(true)
    const byLayer = result as { byLayer: Record<string, unknown>, layersSearched: string[] }
    expect(Object.keys(byLayer.byLayer)).toEqual(['root', 'app-shop'])
    // Every layer was read; app-blog simply defines none of these keys.
    expect(byLayer.layersSearched).toEqual(['root', 'app-shop', 'app-blog'])
  })

  it('gives each layer exactly the shape a read of that layer alone returns', async () => {
    const result = await getTranslations({
      projectDir,
      locale: 'en',
      keys: ['auth.login.title'],
    }) as { byLayer: Record<string, unknown> }
    const alone = await getTranslations({
      projectDir,
      layer: 'app-shop',
      locale: 'en',
      keys: ['auth.login.title'],
    })

    expect(result.byLayer['app-shop']).toEqual(alone)
    expect(result.byLayer.root).toEqual({ en: { 'auth.login.title': 'Sign in' } })
  })
})

describe('getTranslations under a limit', () => {
  it('caps the keys returned and says where to continue', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keyPrefix: 'auth',
      limit: 2,
    })

    // The flat shape has no room for a flag beside the locale codes, so a
    // capped single-layer read answers in the layered shape.
    expect(result).toEqual({
      byLayer: { root: { en: { 'auth.login.subtitle': 'Welcome back', 'auth.login.title': 'Sign in' } } },
      layersSearched: ['root'],
      truncated: true,
      nextOffset: 2,
    })
  })

  it('continues from nextOffset', async () => {
    const result = await getTranslations({
      projectDir,
      layer: 'root',
      locale: 'en',
      keyPrefix: 'auth',
      offset: 2,
    })

    expect(result).toEqual({ en: { 'auth.logout': 'Sign out' } })
  })

  it('counts one (layer, key) pair per unit when no layer was named', async () => {
    const result = await getTranslations({
      projectDir,
      locale: 'en',
      keyPrefix: 'auth',
      limit: 3,
    }) as { byLayer: Record<string, Record<string, unknown>>, truncated: boolean, nextOffset?: number }

    // root defines three auth keys, app-shop one: the cap falls inside root.
    expect(Object.keys(result.byLayer)).toEqual(['root'])
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBe(3)

    const rest = await getTranslations({
      projectDir,
      locale: 'en',
      keyPrefix: 'auth',
      offset: 3,
    }) as { byLayer: Record<string, unknown>, truncated: boolean }
    expect(Object.keys(rest.byLayer)).toEqual(['app-shop'])
    expect(rest.truncated).toBe(false)
  })
})
