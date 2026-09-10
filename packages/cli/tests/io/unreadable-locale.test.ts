import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { I18nConfig } from '../../src/config/types.js'
import { log } from '../../src/utils/logger.js'
import { registerDetectorMock, registerFixtureConfig } from '../fixtures/mock-detector.js'

registerDetectorMock()

const {
  getTranslationStatus,
  moveTranslationKey,
  removeOrphanKeys,
  removeTranslations,
} = await import('../../src/core/operations.js')

/**
 * A locale file that exists and cannot be parsed. Portable in a way a chmod
 * fixture is not: a permissions error and a corrupt file reach the reader as
 * the same thing — a file that is there and yields no keys.
 */
const CORRUPT = '{ "common": { "save": "Save" '

let projectDir: string
let corruptFile: string

function configFor(dir: string): I18nConfig {
  const shopDir = resolve(dir, 'app-shop')
  return {
    rootDir: dir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    // The unreadable locale comes first, so a mutation that ignored the read
    // failure would have written nothing yet when it is reached.
    locales: [
      { code: 'en', language: 'en-US', file: 'en-US.json' },
      { code: 'de', language: 'de-DE', file: 'de-DE.json' },
    ],
    localeDirs: [
      { path: resolve(dir, 'i18n/locales'), layer: 'root', layerRootDir: dir },
      { path: resolve(shopDir, 'i18n/locales'), layer: 'app-shop', layerRootDir: shopDir },
    ],
    layerRootDirs: [dir, shopDir],
    apps: [{ name: 'app-shop', rootDir: shopDir, layers: ['app-shop', 'root'] }],
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'unreadable-locale-'))
  const rootLocales = resolve(projectDir, 'i18n/locales')
  const shopLocales = resolve(projectDir, 'app-shop/i18n/locales')
  await mkdir(rootLocales, { recursive: true })
  await mkdir(shopLocales, { recursive: true })

  corruptFile = join(rootLocales, 'en-US.json')
  await writeFile(corruptFile, CORRUPT)
  await writeFile(join(rootLocales, 'de-DE.json'), JSON.stringify({ common: { save: 'Speichern' } }))
  await writeFile(join(shopLocales, 'de-DE.json'), JSON.stringify({ shop: { cart: 'Warenkorb' } }))
  await writeFile(join(shopLocales, 'en-US.json'), JSON.stringify({ shop: { cart: 'Cart' } }))

  registerFixtureConfig(projectDir, configFor(projectDir))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(projectDir, { recursive: true, force: true })
})

describe('an unreadable locale file', () => {
  it('fails remove with FILE_IO_ERROR naming the file', async () => {
    await expect(removeTranslations({
      layer: 'root',
      keys: ['common.save'],
      dryRun: false,
      projectDir,
    })).rejects.toMatchObject({ code: 'FILE_IO_ERROR', filePath: corruptFile })
  })

  it('fails orphans --remove rather than deleting keys nothing was seen to protect', async () => {
    await expect(removeOrphanKeys({ dryRun: false, projectDir }))
      .rejects.toMatchObject({ code: 'FILE_IO_ERROR', filePath: corruptFile })
  })

  it('fails move', async () => {
    await expect(moveTranslationKey({
      layer: 'root',
      key: 'common.save',
      toLayer: 'app-shop',
      dryRun: false,
      projectDir,
    })).rejects.toMatchObject({ code: 'FILE_IO_ERROR', filePath: corruptFile })
  })

  it('lets status warn and carry on, naming the file', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const result = await getTranslationStatus({ projectDir })

    expect(result.summary.totalKeys).toBeGreaterThan(0)
    expect(warn.mock.calls.flat().join('\n')).toContain(corruptFile)
  })
})
