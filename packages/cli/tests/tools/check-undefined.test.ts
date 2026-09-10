/**
 * checkUndefinedKeys (#195) — the inverse of orphan scanning: keys
 * referenced in source code but defined in no locale file of the using
 * app's consumed layers. Covers scope-correct resolution over a multi-app
 * temp project, dynamic-usage downgrades to uncertain, ignorePatterns,
 * the no-app-info degenerate fallback, and the reports the surface derives
 * from the result.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdir, writeFile, rm, mkdtemp, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { I18nConfig } from '../../src/config/types.js'
import type { CheckUndefinedKeysResult } from '../../src/core/ops-check.js'
import { createTempMultiAppConfig } from '../fixtures/config.js'

const holder = vi.hoisted(() => ({ config: undefined as unknown }))
vi.mock('../../src/config/detector.js', async importOriginal =>
  (await import('../fixtures/holder-detector.js')).holderDetectorMock(holder, importOriginal))

const adminPage = join('app-admin', 'pages/index.vue')
const { checkUndefinedKeys } = await import('../../src/core/operations.js')
// The report files are the surface's doing, so the cases below that ask for
// one go through the surface rather than through the operation.
const { runOperation } = await import('../fixtures/surface.js')

let projectDir: string
let config: I18nConfig

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'i18n-check-undefined-'))
  const write = async (rel: string, content: string): Promise<void> => {
    const path = join(projectDir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  // Locale files: the root layer defines root.shared.used, each app layer
  // defines its own keys. Nothing defines admin.ghost or admin.dyn.*.
  await write('i18n/locales/de-DE.json', JSON.stringify({ root: { shared: { used: 'a' } } }))
  await write('app-admin/i18n/locales/de-DE.json', JSON.stringify({ admin: { used: 'a' } }))
  await write('app-shop/i18n/locales/de-DE.json', JSON.stringify({ shop: { only: 'a' } }))

  // Root-layer code uses a root key — clean.
  await write('components/Shared.vue', `{{ $t('root.shared.used') }}`)

  // app-admin exercises every classification (line numbers matter below).
  await write(adminPage, [
    `{{ $t('admin.used') }}`, // line 1: own layer — clean
    `{{ $t('root.shared.used') }}`, // line 2: consumed shared layer — clean
    `{{ $t('admin.ghost') }}`, // line 3: defined nowhere — undefined
    `{{ $t('shop.only') }}`, // line 4: only in non-consumed app-shop — undefined here
    'const label = t(`admin.dyn.${variant}`)', // line 5: dynamic — uncertain
    `{{ $te('admin.optional') }}`, // line 6: existence check only — uncertain
    `{{ $t('admin.ignored.x') }}`, // line 7: matches ignorePatterns — ignored
    `{{ $t('root.shared') }}`, // line 8: parent node of a leaf — clean
    `{{ $t('admin.ghost') }}`, // line 9: second usage aggregates
    `{{ $t('admin.concat.' + kind) }}`, // line 10: concat — dynamic uncertain, prefix never a hard finding
  ].join('\n'))

  // app-shop uses its own key — clean in its scope.
  await write('app-shop/pages/index.vue', `{{ $t('shop.only') }}`)

  config = {
    ...createTempMultiAppConfig(projectDir),
    projectConfig: {
      orphanScan: { 'app-admin': { ignorePatterns: ['admin.ignored.**'] } },
    },
  }
  holder.config = config
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

async function runCheck(): Promise<CheckUndefinedKeysResult> {
  const result = await checkUndefinedKeys({ projectDir })
  if ('reportFile' in result) throw new Error('Expected inline result, got report file')
  return result
}

/**
 * Run `body` against a throwaway project built from `files`, restoring the
 * shared holder config afterwards (tests in this file share it). Unlike
 * checkTempProject the directory reaches the case, which is what a write test
 * needs: the assertion is the locale file on disk.
 */
async function inTempProject<T>(opts: {
  prefix: string
  files: Record<string, string>
  config: (dir: string) => I18nConfig
  body: (dir: string) => Promise<T>
}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), opts.prefix))
  try {
    for (const [rel, content] of Object.entries(opts.files)) {
      const path = join(dir, rel)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    holder.config = opts.config(dir)
    return await opts.body(dir)
  }
  finally {
    holder.config = config
    await rm(dir, { recursive: true, force: true })
  }
}

/** A one-layer project: nothing about it can be ambiguous. */
function singleLayerConfig(dir: string): I18nConfig {
  return {
    rootDir: dir,
    defaultLocale: 'de',
    fallbackLocale: { default: ['en'] },
    locales: [
      { code: 'de', language: 'de-DE', file: 'de-DE.json' },
      { code: 'en', language: 'en-US', file: 'en-US.json' },
    ],
    localeDirs: [{ path: join(dir, 'i18n/locales'), layer: 'root', layerRootDir: dir }],
    layerRootDirs: [dir],
    apps: [{ name: 'root', rootDir: dir, layers: ['root'] }],
  }
}

const readJson = async (path: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(path, 'utf-8')) as Record<string, any>

/**
 * Run one check against a throwaway multi-app project built from `files`,
 * restoring the shared holder config afterwards (tests in this file share it).
 */
async function checkTempProject(prefix: string, files: Record<string, string>): Promise<CheckUndefinedKeysResult> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(dir, rel)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    holder.config = createTempMultiAppConfig(dir)
    const result = await checkUndefinedKeys({ projectDir: dir })
    if ('reportFile' in result) throw new Error('Expected inline result')
    return result
  } finally {
    holder.config = config
    await rm(dir, { recursive: true, force: true })
  }
}

describe('checkUndefinedKeys — scope-aware', () => {
  it('keys defined in a consumed layer (own, shared, or parent node) are clean', async () => {
    const result = await runCheck()

    const flagged = [...result.undefinedKeys, ...result.uncertainKeys].map(f => f.key)
    for (const clean of ['admin.used', 'root.shared.used', 'root.shared']) {
      expect(flagged).not.toContain(clean)
    }
  })

  it('reports a key defined nowhere with all its usage locations', async () => {
    const result = await runCheck()

    expect(result.undefinedKeys).toContainEqual({
      key: 'admin.ghost',
      app: 'app-admin',
      searchedLayers: ['root', 'app-admin'],
      usages: [
        { file: adminPage, line: 3 },
        { file: adminPage, line: 9 },
      ],
    })
  })

  it('a key defined only in a non-consumed app layer is undefined for the using app', async () => {
    const result = await runCheck()

    expect(result.undefinedKeys).toContainEqual(
      expect.objectContaining({ key: 'shop.only', app: 'app-admin' }),
    )
    // …but clean where the defining layer IS consumed.
    expect(result.undefinedKeys.filter(f => f.app === 'app-shop')).toEqual([])
    expect(result.undefinedKeys).toHaveLength(2)
  })

  it('dynamic usages and existence-check-only keys are uncertain, never hard findings', async () => {
    const result = await runCheck()

    expect(result.uncertainKeys).toContainEqual(
      expect.objectContaining({
        key: '`admin.dyn.${variant}`',
        app: 'app-admin',
        usages: [{ file: adminPage, line: 5 }],
      }),
    )
    expect(result.uncertainKeys).toContainEqual(
      expect.objectContaining({ key: 'admin.optional', app: 'app-admin' }),
    )
    const undefinedKeyNames = result.undefinedKeys.map(f => f.key)
    expect(undefinedKeyNames).not.toContain('`admin.dyn.${variant}`')
    expect(undefinedKeyNames).not.toContain('admin.optional')
  })

  it('concat usage: the quoted prefix is never a hard finding, the expression is uncertain', async () => {
    const result = await runCheck()

    // Static extraction also captures 'admin.concat.' from the concat call —
    // a trailing-dot artifact, not a key.
    expect(result.undefinedKeys.map(f => f.key)).not.toContain('admin.concat.')
    expect(result.uncertainKeys).toContainEqual(
      expect.objectContaining({
        key: '`admin.concat.${_}`',
        app: 'app-admin',
        usages: [{ file: adminPage, line: 10 }],
      }),
    )
  })

  it('respects orphanScan ignorePatterns and counts the exclusions', async () => {
    const result = await runCheck()

    const flagged = [...result.undefinedKeys, ...result.uncertainKeys].map(f => f.key)
    expect(flagged).not.toContain('admin.ignored.x')
    expect(result.summary.ignoredCount).toBe(1)
  })

  it('summarizes counts, locale, and per-app searched layers', async () => {
    const result = await runCheck()

    expect(result.summary).toMatchObject({
      usedKeysChecked: 8, // incl. the concat-prefix artifact captured statically
      undefinedCount: 2,
      uncertainCount: 3,
      ignoredCount: 1,
      filesScanned: 3,
      locale: 'de',
    })
    expect(result.summary.searchedLayersByApp).toEqual({
      'root': ['root'],
      'app-admin': ['root', 'app-admin'],
      'app-shop': ['root', 'app-shop'],
    })
    expect(result.summary.message).toContain('raw keys')
    expect(result.limitation).toContain('line-based')
  })

  it('no-app-info degenerate: a key defined in ANY layer counts as resolvable', async () => {
    holder.config = { ...config, apps: [] }
    try {
      const result = await runCheck()

      // shop.only now resolves for app-admin code too; only the truly
      // nowhere-defined key remains.
      expect(result.undefinedKeys).toEqual([
        expect.objectContaining({
          key: 'admin.ghost',
          searchedLayers: ['root', 'app-admin', 'app-shop'],
        }),
      ])
    } finally {
      holder.config = config
    }
  })

  it('multiline single-segment concat: the bare fallback downgrades matching static keys', async () => {
    // `t(` and the 'menu.' + suffix prefix on separate lines: only the
    // BARE_PREFIX_LITERAL fallback sees this usage. Its `menu.${_}` candidate
    // must downgrade the statically used, nowhere-defined menu.ghost from a
    // hard undefined finding to uncertain.
    const result = await checkTempProject('i18n-check-concat-', {
      'i18n/locales/de-DE.json': JSON.stringify({ root: { used: 'a' } }),
      'app-admin/i18n/locales/de-DE.json': '{}',
      'app-shop/i18n/locales/de-DE.json': '{}',
      'components/Menu.vue': [
        'const menuLabel = t(',
        `  'menu.' + suffix,`,
        ')',
        `{{ $t('menu.ghost') }}`,
      ].join('\n'),
    })

    expect(result.undefinedKeys).toEqual([])
    expect(result.uncertainKeys).toContainEqual(
      expect.objectContaining({
        key: 'menu.ghost',
        reason: expect.stringContaining('dynamic key pattern'),
      }),
    )
  })

  it('string-keys and package-namespaced keys are uncertain, never hard findings (#267)', async () => {
    // Mimics the bookings-api Laravel idioms: full-sentence JSON-style keys
    // (Nova labels, `__('Server Error')`) render as-is when unresolved, and
    // `namespace::group.key` resolves in vendor lang dirs this scan cannot
    // see. Both must land in uncertainKeys with distinct reasons.
    const result = await checkTempProject('i18n-check-stringkey-', {
      'i18n/locales/de-DE.json': JSON.stringify({ root: { used: 'a' } }),
      'app-admin/i18n/locales/de-DE.json': '{}',
      'app-shop/i18n/locales/de-DE.json': '{}',
      'components/Nova.vue': [
        `{{ $t('Server Error') }}`,
        `{{ $t('30 Days') }}`,
        `{{ $t('Logout') }}`,
        `{{ $t('accounting::messages.invoice.table.total') }}`,
        `{{ $t('admin.truly.missing') }}`,
      ].join('\n'),
    })

    // Only the well-shaped, nowhere-defined key stays a hard finding.
    expect(result.undefinedKeys.map(f => f.key)).toEqual(['admin.truly.missing'])
    for (const key of ['Server Error', '30 Days', 'Logout']) {
      expect(result.uncertainKeys).toContainEqual(
        expect.objectContaining({ key, reason: expect.stringContaining('string-key') }),
      )
    }
    expect(result.uncertainKeys).toContainEqual(
      expect.objectContaining({
        key: 'accounting::messages.invoice.table.total',
        reason: expect.stringContaining('package-namespaced'),
      }),
    )
  })

  it('a key the component defines in its own <i18n> block is not undefined', async () => {
    const result = await checkTempProject('i18n-check-local-messages-', {
      'i18n/locales/de-DE.json': '{}',
      'app-admin/i18n/locales/de-DE.json': '{}',
      'app-shop/i18n/locales/de-DE.json': '{}',
      'components/Local.vue': [
        '<i18n lang="json">',
        '{ "de": { "local": { "title": "Details" } } }',
        '</i18n>',
        '<template>',
        `  <p>{{ $t('local.title') }}</p>`,
        `  <p>{{ $t('local.missing') }}</p>`,
        '</template>',
      ].join('\n'),
      // The block is that component's, so the same key elsewhere is undefined.
      'components/Other.vue': `{{ $t('local.title') }}`,
    })

    expect(result.undefinedKeys.map(f => ({ key: f.key, files: f.usages.map(u => u.file) }))).toEqual([
      { key: 'local.missing', files: [join('components', 'Local.vue')] },
      { key: 'local.title', files: [join('components', 'Other.vue')] },
    ])
  })

  it('honors outputFile: writes the full report and returns only the summary', async () => {
    const reportPath = join(projectDir, 'undefined-report.json')
    const result = await runOperation('check', { projectDir, outputFile: reportPath })

    expect(result).toEqual({
      reportFile: reportPath,
      summary: expect.objectContaining({ undefinedCount: 2, uncertainCount: 3 }),
    })

    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as Record<string, unknown>
    expect(report.tool).toBe('find_undefined_keys')
    expect(report.undefinedKeys).toHaveLength(2)
  })

  it('resolves a relative outputFile against the project dir, not the process cwd', async () => {
    const result = await runOperation('check', { projectDir, outputFile: 'undefined-report-rel.json' })

    const expectedPath = join(projectDir, 'undefined-report-rel.json')
    expect(result).toMatchObject({ reportFile: expectedPath })

    const report = JSON.parse(await readFile(expectedPath, 'utf-8')) as Record<string, unknown>
    expect(report.tool).toBe('find_undefined_keys')
  })

  it('rejects a relative outputFile escaping the project dir', async () => {
    await expect(
      runOperation('check', { projectDir, outputFile: '../escape.json' }),
    ).rejects.toThrow(/resolves outside the project directory/)
  })

  it('honors codequalityOutput: writes a CodeClimate array alongside the normal report', async () => {
    const reportPath = join(projectDir, 'undefined-report-cq.json')
    const cqPath = join(projectDir, 'gl-codequality.json')
    const result = await runOperation('check', {
      projectDir,
      outputFile: reportPath,
      codequalityOutput: cqPath,
    })

    // The flag is additive: the normal report behavior is unchanged.
    expect(result).toMatchObject({ reportFile: reportPath })

    const issues = JSON.parse(await readFile(cqPath, 'utf-8')) as Array<Record<string, any>>
    // One issue per usage: admin.ghost (lines 3 + 9) and shop.only (line 4).
    expect(issues).toHaveLength(3)
    for (const issue of issues) {
      expect(issue).toMatchObject({
        description: expect.any(String),
        check_name: 'i18n.undefined-key',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        severity: 'major',
        location: { path: adminPage, lines: { begin: expect.any(Number) } },
      })
    }
    // Same key, different lines → identical line-independent fingerprint.
    const ghosts = issues.filter(i => i.description.includes('"admin.ghost"'))
    expect(ghosts.map(i => i.location.lines.begin)).toEqual([3, 9])
    expect(ghosts[0]!.fingerprint).toBe(ghosts[1]!.fingerprint)
    // Uncertain findings (dynamic, $te-only) are omitted.
    const serialized = JSON.stringify(issues)
    expect(serialized).not.toContain('admin.optional')
    expect(serialized).not.toContain('admin.dyn')
  })
})

/**
 * `write` extracts the hard findings into a locale file as empty translations.
 * What matters is which layer they land in, that nothing already written is
 * touched, and that the gate counter follows: an extracted key has a
 * definition, so it no longer renders raw.
 */
describe('checkUndefinedKeys — write', () => {
  const singleLayerFiles = {
    'i18n/locales/de-DE.json': JSON.stringify({ root: { used: 'Benutzt', legacy: 'Alt' } }),
    'i18n/locales/en-US.json': JSON.stringify({ root: { used: 'Used' } }),
    'components/App.vue': [
      `{{ $t('root.used') }}`,
      `{{ $t('root.ghost') }}`,
      `{{ $t('root.legacy') }}`,
    ].join('\n'),
  }

  it('writes the undefined keys into the one layer, as empty strings in the default locale', async () => {
    await inTempProject({
      prefix: 'i18n-check-write-single-',
      files: singleLayerFiles,
      config: singleLayerConfig,
      body: async (dir) => {
        const result = await runOperation<CheckUndefinedKeysResult>('check', { projectDir: dir, write: true })

        expect(result.written).toEqual({ layer: 'root', locale: 'de', keys: ['root.ghost'] })
        expect(result.summary.writtenCount).toBe(1)
        // Everything found was written, so nothing renders raw any more and the
        // always-on gate reads zero.
        expect(result.summary.undefinedCount).toBe(0)
        // The finding itself stays: the call site is still what a reader visits.
        expect(result.undefinedKeys.map(f => f.key)).toEqual(['root.ghost'])
        expect(result.summary.message).toContain('written to layer "root"')

        const de = await readJson(join(dir, 'i18n/locales/de-DE.json'))
        expect(de.root).toEqual({ used: 'Benutzt', legacy: 'Alt', ghost: '' })
        // Only the default locale is touched.
        expect(await readJson(join(dir, 'i18n/locales/en-US.json'))).toEqual({ root: { used: 'Used' } })
      },
    })
  })

  it('leaves an existing value untouched, and that key stays undefined', async () => {
    await inTempProject({
      prefix: 'i18n-check-write-add-',
      files: singleLayerFiles,
      config: singleLayerConfig,
      body: async (dir) => {
        // Checked against en, where root.legacy is undefined — but de already
        // defines it, so the add-only write must not overwrite "Alt".
        const result = await runOperation<CheckUndefinedKeysResult>('check', {
          projectDir: dir,
          locale: 'en',
          write: true,
        })

        expect(result.written).toEqual({ layer: 'root', locale: 'de', keys: ['root.ghost'] })
        expect(result.summary.writtenCount).toBe(1)
        expect(result.summary.undefinedCount).toBe(1)
        expect(result.summary.message).toContain('already had a value')

        const de = await readJson(join(dir, 'i18n/locales/de-DE.json'))
        expect(de.root).toEqual({ used: 'Benutzt', legacy: 'Alt', ghost: '' })
      },
    })
  })

  it('refuses when the using code resolves against several layers, and writes nothing', async () => {
    await inTempProject({
      prefix: 'i18n-check-write-ambiguous-',
      files: {
        'i18n/locales/de-DE.json': '{}',
        'app-admin/i18n/locales/de-DE.json': '{}',
        'app-shop/i18n/locales/de-DE.json': '{}',
        'app-admin/pages/index.vue': `{{ $t('admin.ghost') }}`,
      },
      config: createTempMultiAppConfig,
      body: async (dir) => {
        await expect(runOperation('check', { projectDir: dir, write: true })).rejects.toMatchObject({
          code: 'AMBIGUOUS_LAYER',
          message: expect.stringContaining('--layer'),
        })

        expect(await readJson(join(dir, 'app-admin/i18n/locales/de-DE.json'))).toEqual({})
        expect(await readJson(join(dir, 'i18n/locales/de-DE.json'))).toEqual({})
      },
    })
  })

  it('writes into the layer the caller names when the findings do not decide', async () => {
    await inTempProject({
      prefix: 'i18n-check-write-layer-',
      files: {
        'i18n/locales/de-DE.json': '{}',
        'app-admin/i18n/locales/de-DE.json': '{}',
        'app-shop/i18n/locales/de-DE.json': '{}',
        'app-admin/pages/index.vue': `{{ $t('admin.ghost') }}`,
      },
      config: createTempMultiAppConfig,
      body: async (dir) => {
        const result = await runOperation<CheckUndefinedKeysResult>('check', {
          projectDir: dir,
          write: true,
          layer: 'app-admin',
        })

        expect(result.written).toEqual({ layer: 'app-admin', locale: 'de', keys: ['admin.ghost'] })
        expect(result.summary.undefinedCount).toBe(0)
        expect(await readJson(join(dir, 'app-admin/i18n/locales/de-DE.json')))
          .toEqual({ admin: { ghost: '' } })
        expect(await readJson(join(dir, 'i18n/locales/de-DE.json'))).toEqual({})
      },
    })
  })

  it('a clean scan writes nothing and never asks which layer', async () => {
    await inTempProject({
      prefix: 'i18n-check-write-clean-',
      files: {
        'i18n/locales/de-DE.json': '{}',
        'app-admin/i18n/locales/de-DE.json': JSON.stringify({ admin: { used: 'a' } }),
        'app-shop/i18n/locales/de-DE.json': '{}',
        'app-admin/pages/index.vue': `{{ $t('admin.used') }}`,
      },
      config: createTempMultiAppConfig,
      body: async (dir) => {
        const result = await runOperation<CheckUndefinedKeysResult>('check', { projectDir: dir, write: true })

        expect(result.written).toBeUndefined()
        expect(result.summary.writtenCount).toBeUndefined()
        expect(result.summary.undefinedCount).toBe(0)
      },
    })
  })
})
