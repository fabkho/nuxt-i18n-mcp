import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { detectI18nConfig, clearConfigCache } from '../../src/config/detector.js'
import { readLocaleFile, clearFileCache, detectIndentation } from '../../src/io/json-reader.js'
import { writeLocaleFile } from '../../src/io/json-writer.js'
import {
  getNestedValue,
  setNestedValue,
  removeNestedValue,
  getLeafKeys,
  sortKeysDeep,
  hasNestedKey,
} from '../../src/io/key-operations.js'

const playgroundDir = resolve(import.meta.dirname, '../../playground')
const appAdminDir = resolve(import.meta.dirname, '../../playground/app-admin')
const tmpDir = resolve(import.meta.dirname, '../../.tmp-perf')

// ─── Helpers ──────────────────────────────────────────────────────

function buildLargeLocale(leafKeyCount: number): Record<string, unknown> {
  const namespaces = ['admin', 'pages', 'components', 'forms', 'modals', 'tables', 'dashboard', 'settings', 'auth', 'billing', 'notifications', 'profile', 'users', 'reports', 'integrations', 'workflows']
  const sections = ['title', 'description', 'labels', 'actions', 'messages', 'errors', 'tooltips', 'placeholders', 'buttons', 'headings', 'columns', 'filters', 'validation', 'confirmation']

  const obj: Record<string, unknown> = {}
  let count = 0
  const keysPerSection = Math.ceil(leafKeyCount / (namespaces.length * sections.length))

  for (const ns of namespaces) {
    const nsObj: Record<string, unknown> = {}
    for (const sec of sections) {
      const secObj: Record<string, string> = {}
      for (let i = 0; i < keysPerSection && count < leafKeyCount; i++) {
        secObj[`key_${String(i).padStart(3, '0')}`] = `Eine ziemlich lange Übersetzung für Schlüssel Nummer ${count}`
        count++
      }
      nsObj[sec] = secObj
    }
    obj[ns] = nsObj
  }
  return obj
}

function time(fn: () => void, runs: number): { totalMs: number; perCallMs: number } {
  const start = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const totalMs = performance.now() - start
  return { totalMs, perCallMs: totalMs / runs }
}

async function timeAsync(fn: () => Promise<void>, runs: number): Promise<{ totalMs: number; perCallMs: number }> {
  const start = performance.now()
  for (let i = 0; i < runs; i++) await fn()
  const totalMs = performance.now() - start
  return { totalMs, perCallMs: totalMs / runs }
}

// ─── Key operations on large objects ─────────────────────────────

describe('perf: key-operations on large objects', () => {
  const sizes = [500, 2000, 5000]

  for (const size of sizes) {
    const locale = buildLargeLocale(size)
    const leafKeys = getLeafKeys(locale)
    const lines = JSON.stringify(locale, null, 2).split('\n').length

    describe(`${size} keys (~${lines} lines)`, () => {
      it('getLeafKeys', () => {
        const { perCallMs } = time(() => getLeafKeys(locale), 100)
        console.error(`  getLeafKeys(${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(10)
      })

      it('sortKeysDeep', () => {
        const { perCallMs } = time(() => sortKeysDeep(locale), 100)
        console.error(`  sortKeysDeep(${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(10)
      })

      it('getNestedValue (random access)', () => {
        const sampleKeys = leafKeys.slice(0, Math.min(100, leafKeys.length))
        const { perCallMs } = time(() => {
          for (const key of sampleKeys) getNestedValue(locale, key)
        }, 100)
        console.error(`  getNestedValue x${sampleKeys.length} (${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(10)
      })

      it('hasNestedKey (random access)', () => {
        const sampleKeys = leafKeys.slice(0, Math.min(100, leafKeys.length))
        const { perCallMs } = time(() => {
          for (const key of sampleKeys) hasNestedKey(locale, key)
        }, 100)
        console.error(`  hasNestedKey x${sampleKeys.length} (${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(10)
      })

      it('setNestedValue (100 inserts)', () => {
        const { perCallMs } = time(() => {
          const copy = structuredClone(locale)
          for (let i = 0; i < 100; i++) {
            setNestedValue(copy, `bench.new_ns.key_${i}`, `value_${i}`)
          }
        }, 50)
        console.error(`  setNestedValue x100 (${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(20)
      })

      it('removeNestedValue (100 removals)', () => {
        const sampleKeys = leafKeys.slice(0, 100)
        const { perCallMs } = time(() => {
          const copy = structuredClone(locale)
          for (const key of sampleKeys) removeNestedValue(copy, key)
        }, 50)
        console.error(`  removeNestedValue x100 (${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(20)
      })

      it('full write pipeline: clone + sort + stringify', () => {
        const { perCallMs } = time(() => {
          const sorted = sortKeysDeep(locale)
          JSON.stringify(sorted, null, 2)
        }, 50)
        console.error(`  sort + stringify (${size} keys): ${perCallMs.toFixed(3)}ms/call`)
        expect(perCallMs).toBeLessThan(20)
      })
    })
  }
})

// ─── File I/O with real and synthetic files ──────────────────────

describe('perf: file I/O', () => {
  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readLocaleFile: playground file (cold)', async () => {
    const filePath = join(playgroundDir, 'i18n/locales/de-DE.json')
    const { perCallMs } = await timeAsync(async () => {
      clearFileCache()
      await readLocaleFile(filePath)
    }, 50)
    console.error(`  readLocaleFile cold (playground): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(5)
  })

  it('readLocaleFile: playground file (cached)', async () => {
    const filePath = join(playgroundDir, 'i18n/locales/de-DE.json')
    clearFileCache()
    await readLocaleFile(filePath) // warm cache
    const { perCallMs } = await timeAsync(async () => {
      await readLocaleFile(filePath)
    }, 200)
    console.error(`  readLocaleFile cached (playground): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(2)
  })

  it('readLocaleFile: large synthetic file (cold)', async () => {
    const locale = buildLargeLocale(3000)
    const filePath = join(tmpDir, 'large-locale.json')
    writeFileSync(filePath, JSON.stringify(locale, null, 2))

    const { perCallMs } = await timeAsync(async () => {
      clearFileCache()
      await readLocaleFile(filePath)
    }, 30)
    console.error(`  readLocaleFile cold (3000 keys): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(10)
  })

  it('readLocaleFile: large synthetic file (cached)', async () => {
    const locale = buildLargeLocale(3000)
    const filePath = join(tmpDir, 'large-locale-cached.json')
    writeFileSync(filePath, JSON.stringify(locale, null, 2))
    clearFileCache()
    await readLocaleFile(filePath) // warm cache

    const { perCallMs } = await timeAsync(async () => {
      await readLocaleFile(filePath)
    }, 200)
    console.error(`  readLocaleFile cached (3000 keys): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(5)
  })

  it('writeLocaleFile: large synthetic file', async () => {
    const locale = buildLargeLocale(3000)
    const filePath = join(tmpDir, 'write-bench.json')

    const { perCallMs } = await timeAsync(async () => {
      await writeLocaleFile(filePath, locale)
    }, 20)
    console.error(`  writeLocaleFile (3000 keys): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(20)
  })

  it('detectIndentation: large file', () => {
    const locale = buildLargeLocale(3000)
    const content = JSON.stringify(locale, null, 2)
    const { perCallMs } = time(() => detectIndentation(content), 500)
    console.error(`  detectIndentation (3000 keys): ${perCallMs.toFixed(4)}ms/call`)
    expect(perCallMs).toBeLessThan(1)
  })
})

// ─── Config detection ────────────────────────────────────────────

describe('perf: config detection', () => {
  afterAll(() => {
    clearConfigCache()
  })

  it('detectI18nConfig: cold (playground)', async () => {
    clearConfigCache()
    const start = performance.now()
    await detectI18nConfig(playgroundDir)
    const ms = performance.now() - start
    console.error(`  detectI18nConfig cold (playground): ${ms.toFixed(0)}ms`)
    // loadNuxt is slow — just assert it finishes in reasonable time
    expect(ms).toBeLessThan(15_000)
  }, 30_000)

  it('detectI18nConfig: cached (playground)', async () => {
    // Ensure cache is warm from previous test
    await detectI18nConfig(playgroundDir)
    const { perCallMs } = await timeAsync(async () => {
      await detectI18nConfig(playgroundDir)
    }, 1000)
    console.error(`  detectI18nConfig cached: ${perCallMs.toFixed(4)}ms/call`)
    expect(perCallMs).toBeLessThan(0.1)
  })

  it('detectI18nConfig: cold (app-admin, 2 layers)', async () => {
    clearConfigCache()
    const start = performance.now()
    await detectI18nConfig(appAdminDir)
    const ms = performance.now() - start
    console.error(`  detectI18nConfig cold (app-admin): ${ms.toFixed(0)}ms`)
    expect(ms).toBeLessThan(15_000)
  }, 30_000)
})

// ─── End-to-end tool simulation ──────────────────────────────────

describe('perf: tool simulation', () => {
  it('get_translations: read 10 keys from 4 locales', async () => {
    const rootLocales = join(playgroundDir, 'i18n/locales')
    const localeFiles = ['de-DE.json', 'en-US.json', 'fr-FR.json', 'es-ES.json']
    const keys = [
      'common.actions.save', 'common.actions.cancel', 'common.actions.delete',
      'common.messages.success', 'common.messages.error', 'common.messages.loading',
      'common.navigation.back', 'common.navigation.home', 'common.navigation.settings',
      'common.actions.edit',
    ]

    clearFileCache()
    const { perCallMs } = await timeAsync(async () => {
      for (const file of localeFiles) {
        const data = await readLocaleFile(join(rootLocales, file))
        for (const key of keys) getNestedValue(data, key)
      }
    }, 50)
    console.error(`  get_translations (10 keys x 4 locales): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(10)
  })

  it('get_missing_translations: compare 2 locales in large file', async () => {
    const locale1 = buildLargeLocale(3000)
    const locale2 = structuredClone(locale1)

    // Remove 50 random keys from locale2
    const allKeys = getLeafKeys(locale2)
    const removed: string[] = []
    for (let i = 0; i < 50; i++) {
      const key = allKeys[i * Math.floor(allKeys.length / 50)]
      if (removeNestedValue(locale2, key)) removed.push(key)
    }

    const { perCallMs } = time(() => {
      const refKeys = getLeafKeys(locale1)
      const targetKeySet = new Set(getLeafKeys(locale2))
      refKeys.filter(k => !targetKeySet.has(k))
    }, 100)
    console.error(`  get_missing_translations (3000 keys, ~50 missing): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(10)
  })

  it('search_translations: substring search across large file', async () => {
    const locale = buildLargeLocale(3000)
    const leafKeys = getLeafKeys(locale)
    const query = 'schlüssel nummer 1'

    const { perCallMs } = time(() => {
      const matches: string[] = []
      for (const key of leafKeys) {
        const value = getNestedValue(locale, key)
        if (typeof value === 'string' && value.toLowerCase().includes(query)) {
          matches.push(key)
        }
      }
    }, 50)
    console.error(`  search_translations (3000 keys, value search): ${perCallMs.toFixed(3)}ms/call`)
    expect(perCallMs).toBeLessThan(20)
  })

  it('add_translations: insert 20 keys into large file', async () => {
    const locale = buildLargeLocale(3000)
    const filePath = join(tmpDir, 'add-bench.json')

    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(locale, null, 2))

    const newKeys: Record<string, string> = {}
    for (let i = 0; i < 20; i++) {
      newKeys[`bench.feature.key_${i}`] = `New translation ${i}`
    }

    clearFileCache()
    const start = performance.now()
    const data = await readLocaleFile(filePath)
    for (const [key, value] of Object.entries(newKeys)) {
      if (!hasNestedKey(data, key)) setNestedValue(data, key, value)
    }
    await writeLocaleFile(filePath, data)
    const ms = performance.now() - start

    console.error(`  add_translations (20 keys into 3000-key file): ${ms.toFixed(2)}ms`)
    expect(ms).toBeLessThan(50)

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
