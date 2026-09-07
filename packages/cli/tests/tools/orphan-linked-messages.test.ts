/**
 * vue-i18n linked messages end-to-end: a locale value naming another key with
 * `@:` is a reference no source scan can see, and the target used to be
 * reported as an orphan and deleted by `orphans --remove`.
 *
 * The links here live in a locale OTHER than the reference one, because that
 * is where they were found in the wild: the catalog of keys is read from the
 * reference locale, so a scan that only looked there saw none of them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { I18nConfig } from '../../src/config/types.js'

const holder = vi.hoisted(() => ({ config: undefined as unknown }))
vi.mock('../../src/config/detector.js', async importOriginal =>
  (await import('../fixtures/holder-detector.js')).holderDetectorMock(holder, importOriginal))

const { findOrphanKeys, removeOrphanKeys } = await import('../../src/core/operations.js')

type Catalog = Record<string, unknown>

/** One layer of a fixture project: its two locale files and the code that uses them. */
interface Layer {
  de: Catalog
  en?: Catalog
  code?: string
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A temp project with a root layer, an optional nested `app-admin` layer, and
 * `de` as the reference locale. Each call gets its own directory, so no test
 * reads another's locale files out of the read cache.
 */
async function writeProject(project: { root: Layer; admin?: Layer }): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'i18n-linked-'))
  tempDirs.push(projectDir)
  const adminDir = join(projectDir, 'app-admin')

  await writeLayer(projectDir, project.root)
  if (project.admin) await writeLayer(adminDir, project.admin)

  const config: I18nConfig = {
    rootDir: projectDir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: [
      { code: 'de', language: 'de-DE', file: 'de-DE.json' },
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ],
    localeDirs: [
      { path: join(projectDir, 'i18n/locales'), layer: 'root', layerRootDir: projectDir },
      ...(project.admin
        ? [{ path: join(adminDir, 'i18n/locales'), layer: 'app-admin', layerRootDir: adminDir }]
        : []),
    ],
    layerRootDirs: project.admin ? [projectDir, adminDir] : [projectDir],
    apps: project.admin
      ? [{ name: 'app-admin', rootDir: adminDir, layers: ['app-admin', 'root'] }]
      : [{ name: 'root', rootDir: projectDir, layers: ['root'] }],
  }
  holder.config = config

  return projectDir
}

async function writeLayer(dir: string, layer: Layer): Promise<void> {
  await mkdir(join(dir, 'i18n/locales'), { recursive: true })
  await writeFile(join(dir, 'i18n/locales/de-DE.json'), JSON.stringify(layer.de))
  if (layer.en) await writeFile(join(dir, 'i18n/locales/en-US.json'), JSON.stringify(layer.en))
  if (layer.code) {
    await mkdir(join(dir, 'pages'), { recursive: true })
    await writeFile(join(dir, 'pages/index.vue'), layer.code)
  }
}

/** `b.source` is used in code; `a.target` exists only in the reference locale. */
async function projectLinking(value: string): Promise<string> {
  return writeProject({
    root: {
      de: { a: { target: 'Ziel' }, b: { source: 'Quelle' } },
      en: { b: { source: value } },
      code: `<template><p>{{ $t('b.source') }}</p></template>`,
    },
  })
}

describe('keys linked with @: from another message', () => {
  it('protects a target linked from a locale other than the reference one', async () => {
    const projectDir = await projectLinking('@:a.target')

    const result = await findOrphanKeys({ projectDir })

    expect(result.orphanKeys).toEqual({})
    expect(result.summary.linkedCount).toBe(1)
    expect(result.linkedNote).toContain('@:')
  })

  /**
   * Every spelling vue-i18n accepts, because a form the scanner cannot read is
   * a live key offered for deletion — the failure mode this whole path exists
   * to prevent.
   */
  const forms: Array<[name: string, value: string]> = [
    ['a modifier', '@.upper:a.target'],
    ['the parenthesised form', '@:(a.target)'],
    ['the list form with single quotes', `@:{'a.target'}`],
    ['the list form with double quotes', `@:{"a.target"}`],
    ['a link ending a sentence', 'Siehe @:a.target.'],
    ['a link inside a longer message', 'Bitte @:a.target lesen und bestätigen'],
  ]

  for (const [name, value] of forms) {
    it(`reads ${name}`, async () => {
      const projectDir = await projectLinking(value)

      const result = await findOrphanKeys({ projectDir })

      expect(result.orphanKeys).toEqual({})
      expect(result.summary.linkedCount).toBe(1)
    })
  }

  it('still reports a key nothing links to or uses', async () => {
    const projectDir = await writeProject({
      root: {
        de: { a: { target: 'Ziel' }, b: { source: 'Quelle' }, c: { dead: 'Tot' } },
        en: { b: { source: '@:a.target' } },
        code: `<template><p>{{ $t('b.source') }}</p></template>`,
      },
    })

    const result = await findOrphanKeys({ projectDir })

    expect(result.orphanKeys).toEqual({ root: ['c.dead'] })
    expect(result.summary.linkedCount).toBe(1)
  })

  /**
   * A link resolves inside the app's merged message table, so which layer's
   * value carries it decides nothing — including when the layer holding the
   * target is not in the scan scope of the layer holding the link.
   */
  it('protects a target in another layer than the value that links it', async () => {
    const projectDir = await writeProject({
      root: {
        de: { shared: { linkedFromApp: 'x', source: 'y' } },
        en: { shared: { source: '@:admin.linkedFromRoot' } },
        code: `<template><p>{{ $t('shared.source') }}</p></template>`,
      },
      admin: {
        de: { admin: { linkedFromRoot: 'x', source: 'y' } },
        en: { admin: { source: '@:shared.linkedFromApp' } },
        code: `<template><p>{{ $t('admin.source') }}</p></template>`,
      },
    })

    const result = await findOrphanKeys({ projectDir })

    expect(result.orphanKeys).toEqual({})
    expect(result.summary.linkedCount).toBe(2)
  })

  it('never removes a linked target', async () => {
    const projectDir = await writeProject({
      root: {
        de: { a: { target: 'Ziel' }, b: { source: 'Quelle' }, c: { dead: 'Tot' } },
        en: { b: { source: '@:a.target' } },
        code: `<template><p>{{ $t('b.source') }}</p></template>`,
      },
    })

    const result = await removeOrphanKeys({ projectDir, dryRun: false })

    expect(result.removed).toEqual({ root: ['c.dead'] })
    expect(JSON.parse(await readFile(join(projectDir, 'i18n/locales/de-DE.json'), 'utf-8'))).toEqual({
      a: { target: 'Ziel' },
      b: { source: 'Quelle' },
    })
  })
})
