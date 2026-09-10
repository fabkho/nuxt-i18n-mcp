/**
 * GitLab Code Quality mapping (#270) — pure transforms, no I/O.
 *
 * Contract under test: every issue carries the full required field set,
 * paths are project-root-relative with no leading `./`, lines.begin is an
 * integer ≥ 1, and fingerprints are line-independent (edits that shift a
 * usage must not churn findings as new/resolved in the MR widget).
 */

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'

import type { I18nConfig } from '../../src/config/types.js'
import type { UndefinedKeyFinding } from '../../src/core/ops-check.js'
import type { DuplicateKeyCollision, FindDuplicateKeysResult } from '../../src/core/ops-duplicates.js'
import type { MissingTranslationsResult } from '../../src/core/ops-read.js'
import type { LocaleStatus, TranslationStatusResult } from '../../src/core/ops-status.js'
import {
  duplicateKeysToCodeQuality,
  missingTranslationsToCodeQuality,
  orphanKeysToCodeQuality,
  referenceLocaleAnchorPaths,
  statusToCodeQuality,
  undefinedKeysToCodeQuality,
} from '../../src/core/codequality.js'
import type { CodeQualityIssue } from '../../src/core/codequality.js'

const finding = (key: string, usages: Array<{ file: string; line: number }>): UndefinedKeyFinding =>
  ({ key, app: 'app', searchedLayers: ['root'], usages })

function expectValidIssue(issue: CodeQualityIssue): void {
  expect(issue.description).toEqual(expect.any(String))
  expect(issue.description.length).toBeGreaterThan(0)
  expect(issue.check_name).toMatch(/^i18n\./)
  expect(issue.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(['info', 'minor', 'major', 'critical', 'blocker']).toContain(issue.severity)
  expect(issue.location.path).toEqual(expect.any(String))
  expect(issue.location.path).not.toMatch(/^\.\//)
  expect(issue.location.path).not.toMatch(/^\//)
  expect(Number.isInteger(issue.location.lines.begin)).toBe(true)
  expect(issue.location.lines.begin).toBeGreaterThanOrEqual(1)
}

describe('undefinedKeysToCodeQuality', () => {
  it('maps one major finding per usage location', () => {
    const issues = undefinedKeysToCodeQuality([
      finding('a.b', [{ file: 'src/App.vue', line: 3 }, { file: 'src/Other.vue', line: 7 }]),
      finding('c.d', [{ file: 'src/App.vue', line: 9 }]),
    ])

    expect(issues).toHaveLength(3)
    for (const issue of issues) expectValidIssue(issue)
    expect(issues[0]).toMatchObject({
      check_name: 'i18n.undefined-key',
      severity: 'major',
      location: { path: 'src/App.vue', lines: { begin: 3 } },
    })
    expect(issues[0]!.description).toContain('"a.b"')
  })

  it('fingerprints are line-independent but key- and path-sensitive', () => {
    const at = (line: number): CodeQualityIssue[] =>
      undefinedKeysToCodeQuality([finding('a.b', [{ file: 'src/App.vue', line }])])

    // Frozen vector: sha256 over check_name, key, path — changing this hash
    // resets every consumer's new/resolved state in the widget.
    expect(at(3)[0]!.fingerprint).toBe('0998722d98ee09e187b0b2683a90d831966e193bb63c9782de439a8d0a559158')
    expect(at(300)[0]!.fingerprint).toBe(at(3)[0]!.fingerprint)

    const otherKey = undefinedKeysToCodeQuality([finding('a.c', [{ file: 'src/App.vue', line: 3 }])])
    const otherFile = undefinedKeysToCodeQuality([finding('a.b', [{ file: 'src/B.vue', line: 3 }])])
    expect(otherKey[0]!.fingerprint).not.toBe(at(3)[0]!.fingerprint)
    expect(otherFile[0]!.fingerprint).not.toBe(at(3)[0]!.fingerprint)
  })

  it('normalizes path shape and clamps lines.begin to an integer ≥ 1', () => {
    const issues = undefinedKeysToCodeQuality([
      finding('a.b', [{ file: './src\\win\\App.vue', line: 0 }]),
    ])

    expect(issues[0]!.location).toEqual({ path: 'src/win/App.vue', lines: { begin: 1 } })
  })

  it('maps an empty result to an empty array (the default-branch baseline)', () => {
    expect(undefinedKeysToCodeQuality([])).toEqual([])
  })
})

describe('orphanKeysToCodeQuality', () => {
  const anchors = { 'root': 'i18n/locales/de-DE.json', 'app-admin': 'app-admin/i18n/locales/de-DE.json' }

  it('maps one minor finding per key, anchored at the reference-locale file, line 1', () => {
    const issues = orphanKeysToCodeQuality(
      { 'root': ['a.b', 'a.c'], 'app-admin': ['admin.x'] },
      anchors,
    )

    expect(issues).toHaveLength(3)
    for (const issue of issues) expectValidIssue(issue)
    expect(issues[0]).toMatchObject({
      check_name: 'i18n.orphan-key',
      severity: 'minor',
      location: { path: 'i18n/locales/de-DE.json', lines: { begin: 1 } },
    })
    expect(issues[2]!.location.path).toBe('app-admin/i18n/locales/de-DE.json')
    expect(issues[0]!.description).toContain('"a.b"')
    expect(issues[0]!.description).toContain('verify before deleting')
  })

  it('fingerprints depend on layer + key, not the anchor path', () => {
    const [issue] = orphanKeysToCodeQuality({ root: ['a.b'] }, anchors)
    const [moved] = orphanKeysToCodeQuality({ root: ['a.b'] }, { root: 'renamed/locales/en.json' })

    expect(issue!.fingerprint).toBe('7b340a6a9273b1d9346c77ec83a1723b01f710da22356dfd67a963bd2d6e6557')
    expect(moved!.fingerprint).toBe(issue!.fingerprint)

    const [otherLayer] = orphanKeysToCodeQuality({ other: ['a.b'] }, { other: 'x.json' })
    expect(otherLayer!.fingerprint).not.toBe(issue!.fingerprint)
  })
})

describe('referenceLocaleAnchorPaths', () => {
  const projectDir = resolve('/proj')
  const config = {
    localeDirs: [
      { path: resolve('/proj/i18n/locales'), layer: 'root', layerRootDir: projectDir },
      { path: resolve('/proj/app-shop/i18n/locales'), layer: 'app-shop', layerRootDir: resolve('/proj/app-shop') },
      { path: resolve('/proj/app-shop/i18n/locales'), layer: 'app-outlook', layerRootDir: resolve('/proj/app-outlook'), aliasOf: 'app-shop' },
    ],
  } as I18nConfig
  const locale = { code: 'de', language: 'de-DE', file: 'de-DE.json' }

  it('resolves flat layouts to the locale file, relative without leading ./', () => {
    const anchors = referenceLocaleAnchorPaths(config, ['root', 'app-shop'], locale, projectDir)

    expect(anchors).toEqual({
      'root': 'i18n/locales/de-DE.json',
      'app-shop': 'app-shop/i18n/locales/de-DE.json',
    })
  })

  it('aliases anchor at their target layer\'s directory', () => {
    const anchors = referenceLocaleAnchorPaths(config, ['app-outlook'], locale, projectDir)

    expect(anchors['app-outlook']).toBe('app-shop/i18n/locales/de-DE.json')
  })

  it('locales without a file (namespaced layouts) anchor at the locale directory', () => {
    const anchors = referenceLocaleAnchorPaths(config, ['root'], { code: 'de', language: 'de-DE' }, projectDir)

    expect(anchors['root']).toBe('i18n/locales/de')
  })
})

/**
 * The three report-only mappings: `missing`, `status` and `find-duplicates`.
 * All of them anchor at a locale file rather than a call site, so what is
 * asserted per operation is which file, which severity, and that the
 * fingerprint survives the numbers moving.
 */
const projectDir = resolve('/proj')
const shopDir = resolve('/proj/app-shop')

const localeConfig = {
  rootDir: projectDir,
  defaultLocale: 'de',
  fallbackLocale: { default: ['en'] },
  locales: [
    { code: 'de', language: 'de-DE', file: 'de-DE.json' },
    { code: 'fr', language: 'fr-FR', file: 'fr-FR.json' },
    { code: 'it', language: 'it-IT', file: 'it-IT.json' },
  ],
  localeDirs: [
    { path: resolve('/proj/i18n/locales'), layer: 'root', layerRootDir: projectDir },
    { path: resolve('/proj/app-shop/i18n/locales'), layer: 'app-shop', layerRootDir: shopDir },
  ],
  layerRootDirs: [projectDir, shopDir],
  apps: [],
} as I18nConfig

const mappingContext = { config: localeConfig, projectDir }

describe('missingTranslationsToCodeQuality', () => {
  const missing = (byLocale: Record<string, Record<string, string[]>>): MissingTranslationsResult => ({
    missing: byLocale,
    summary: {
      referenceLocale: 'de',
      targetLocales: Object.keys(byLocale),
      layersScanned: ['root', 'app-shop'],
      totalMissingKeys: 0,
    },
  })

  it('maps one minor finding per key per locale, anchored at that locale\'s file', () => {
    const issues = missingTranslationsToCodeQuality(
      missing({ fr: { 'root': ['a.b', 'a.c'], 'app-shop': ['shop.x'] } }),
      mappingContext,
    )

    expect(issues).toHaveLength(3)
    for (const issue of issues) expectValidIssue(issue)
    expect(issues[0]).toMatchObject({
      check_name: 'i18n.missing-translation',
      severity: 'minor',
      location: { path: 'i18n/locales/fr-FR.json', lines: { begin: 1 } },
    })
    expect(issues[0]!.description).toContain('Missing translation for "a.b" in fr')
    // The finding belongs to the layer short of the key, not to the project.
    expect(issues[2]!.location.path).toBe('app-shop/i18n/locales/fr-FR.json')
  })

  it('fingerprints depend on layer, locale and key, not on how many are missing', () => {
    const [alone] = missingTranslationsToCodeQuality(missing({ fr: { root: ['a.b'] } }), mappingContext)
    const amid = missingTranslationsToCodeQuality(
      missing({ fr: { root: ['a.a', 'a.b', 'a.c'] }, it: { root: ['a.b'] } }),
      mappingContext,
    ).find(issue => issue.description.includes('"a.b" in fr'))

    // Frozen vector: sha256 over check_name, layer, locale, key.
    expect(alone!.fingerprint).toBe('543e3d87508943618609d750e07b2abf41774745b9ec1d715aacc727ca93b4e4')
    expect(amid!.fingerprint).toBe(alone!.fingerprint)

    const [otherLocale] = missingTranslationsToCodeQuality(missing({ it: { root: ['a.b'] } }), mappingContext)
    const [otherLayer] = missingTranslationsToCodeQuality(
      missing({ fr: { 'app-shop': ['a.b'] } }),
      mappingContext,
    )
    expect(otherLocale!.fingerprint).not.toBe(alone!.fingerprint)
    expect(otherLayer!.fingerprint).not.toBe(alone!.fingerprint)
  })

  it('maps an empty result to an empty array (the default-branch baseline)', () => {
    expect(missingTranslationsToCodeQuality(missing({}), mappingContext)).toEqual([])
  })
})

describe('statusToCodeQuality', () => {
  const localeStatus = (code: string, completion: number, extra: Partial<LocaleStatus> = {}): LocaleStatus => ({
    code,
    file: `${code}-${code.toUpperCase()}.json`,
    total: 10,
    translated: Math.round(completion / 10),
    missing: 10 - Math.round(completion / 10),
    empty: 0,
    completion,
    ...extra,
  })

  const status = (locales: LocaleStatus[], unconsumedLayers: string[] = []): TranslationStatusResult => ({
    locales,
    layers: [],
    summary: {
      referenceLocale: { code: 'de', language: 'de-DE', file: 'de-DE.json' },
      layersScanned: ['root', 'app-shop'],
      unconsumedLayers,
      localesChecked: locales.length,
      protectedLocales: locales.filter(l => l.protected).map(l => l.code),
      totalKeys: 10,
      translatedKeys: 9,
      missingKeys: 1,
      emptyKeys: 0,
      completionPercent: 90,
    },
  })

  it('reports an incomplete locale as info and an unconsumed layer as minor', () => {
    const issues = statusToCodeQuality(
      status([
        localeStatus('de', 100),
        localeStatus('fr', 80),
        localeStatus('it', 40, { protected: true, excludedFromOverall: true }),
      ], ['app-shop']),
      mappingContext,
    )

    for (const issue of issues) expectValidIssue(issue)
    // A complete locale is not a finding, and a protected one is a decision.
    expect(issues.map(i => i.check_name))
      .toEqual(['i18n.incomplete-locale', 'i18n.unconsumed-layer'])
    expect(issues[0]).toMatchObject({
      severity: 'info',
      location: { path: 'i18n/locales/fr-FR.json', lines: { begin: 1 } },
    })
    expect(issues[0]!.description).toContain('"fr"')
    expect(issues[1]).toMatchObject({
      severity: 'minor',
      // The layer nothing consumes, at its reference-locale file.
      location: { path: 'app-shop/i18n/locales/de-DE.json', lines: { begin: 1 } },
    })
    expect(issues[1]!.description).toContain('consumed by no app')
  })

  it('reads the bar from failUnder when the caller set one', () => {
    const locales = [localeStatus('fr', 80)]

    expect(statusToCodeQuality(status(locales), { ...mappingContext, failUnder: 80 })).toEqual([])
    expect(statusToCodeQuality(status(locales), { ...mappingContext, failUnder: 90 })).toHaveLength(1)
    // No threshold: anything short of complete is what status reports on.
    expect(statusToCodeQuality(status(locales), mappingContext)).toHaveLength(1)
  })

  it('fingerprints carry no percentage, so a moving figure is one finding', () => {
    const at = (completion: number): CodeQualityIssue[] =>
      statusToCodeQuality(status([localeStatus('fr', completion)]), mappingContext)

    // Frozen vectors: sha256 over check_name and the locale code / layer name.
    expect(at(80)[0]!.fingerprint).toBe('88a8ddb7e7eec51c06d971a8401689d7d10e9b9ae1f52c1f96b629e45fa8ab82')
    expect(at(30)[0]!.fingerprint).toBe(at(80)[0]!.fingerprint)
    expect(at(80)[0]!.description).not.toBe(at(30)[0]!.description)

    const [layer] = statusToCodeQuality(status([], ['app-shop']), mappingContext)
    expect(layer!.fingerprint).toBe('17b0dcd3b142ccc391ff5652b278bbad5a5a2a27ad196d40c6bdf10f2310e97f')

    const [otherLocale] = statusToCodeQuality(status([localeStatus('it', 80)]), mappingContext)
    expect(otherLocale!.fingerprint).not.toBe(at(80)[0]!.fingerprint)
  })
})

describe('duplicateKeysToCodeQuality', () => {
  const collision = (over: Partial<DuplicateKeyCollision> = {}): DuplicateKeyCollision => ({
    key: 'common.save',
    sharedLayer: 'root',
    childLayer: 'app-shop',
    sharedValue: 'Speichern',
    childValue: 'Sichern',
    divergent: true,
    ...over,
  })

  const duplicates = (collisions: DuplicateKeyCollision[]): FindDuplicateKeysResult => ({
    collisions,
    guidance: '',
    summary: {
      totalCollisions: collisions.length,
      divergentCount: collisions.filter(c => c.divergent).length,
      pairsChecked: 1,
      locale: 'de',
    },
  })

  it('maps one minor finding per collision, anchored at the shadowing layer\'s file', () => {
    const issues = duplicateKeysToCodeQuality(
      duplicates([collision(), collision({ key: 'common.cancel', divergent: false })]),
      mappingContext,
    )

    expect(issues).toHaveLength(2)
    for (const issue of issues) expectValidIssue(issue)
    expect(issues[0]).toMatchObject({
      check_name: 'i18n.duplicate-key',
      severity: 'minor',
      // The child layer shadows the shared one, so its file is where to look.
      location: { path: 'app-shop/i18n/locales/de-DE.json', lines: { begin: 1 } },
    })
    expect(issues[0]!.description).toContain('"common.save"')
    expect(issues[0]!.description).toContain('with different values')
    expect(issues[1]!.description).toContain('with the same value')
  })

  it('fingerprints depend on the pair and the key, never on the values', () => {
    const [issue] = duplicateKeysToCodeQuality(duplicates([collision()]), mappingContext)
    const [reworded] = duplicateKeysToCodeQuality(
      duplicates([collision({ sharedValue: 'Sichern', divergent: false })]),
      mappingContext,
    )

    // Frozen vector: sha256 over check_name, shared layer, child layer, key.
    expect(issue!.fingerprint).toBe('d19f976acdfdf0abc5f2745a1c304bdda717d9993d8f3080349ef374fe4faab6')
    expect(reworded!.fingerprint).toBe(issue!.fingerprint)

    const [otherKey] = duplicateKeysToCodeQuality(duplicates([collision({ key: 'common.cancel' })]), mappingContext)
    expect(otherKey!.fingerprint).not.toBe(issue!.fingerprint)
  })

  it('leaves value duplicates unmapped: a consolidation is not a defect', () => {
    const result = duplicates([])
    result.valueDuplicates = [{
      value: 'Speichern',
      normalized: 'speichern',
      action: 'reuse',
      members: [{ key: 'common.save', layer: 'root', shared: true }],
    }]

    expect(duplicateKeysToCodeQuality(result, mappingContext)).toEqual([])
  })
})
