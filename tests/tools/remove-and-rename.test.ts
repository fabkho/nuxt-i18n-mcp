import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { resolve, join } from 'node:path'
import { cp, rm, readFile, mkdir } from 'node:fs/promises'
import { readLocaleFile } from '../../src/io/json-reader.js'
import { mutateLocaleFile } from '../../src/io/json-writer.js'
import {
  getNestedValue,
  getLeafKeys,
  hasNestedKey,
  removeNestedValue,
  renameNestedKey,
} from '../../src/io/key-operations.js'

const playgroundDir = resolve(import.meta.dirname, '../../playground')

// We use temp copies of just the locale directories so we can safely mutate files
// (copying the whole playground fails due to node_modules symlinks)
const tmpDir = resolve(import.meta.dirname, '../../.tmp-locales')
const tmpRootLocales = resolve(tmpDir, 'root')
const tmpAdminLocales = resolve(tmpDir, 'admin')

const playgroundRootLocales = resolve(playgroundDir, 'i18n/locales')
const playgroundAdminLocales = resolve(playgroundDir, 'app-admin/i18n/locales')

const localeFiles = ['de-DE.json', 'en-US.json', 'fr-FR.json', 'es-ES.json']

/**
 * Copy just the locale JSON files into tmp directories for safe mutation.
 */
async function copyLocaleFiles() {
  await mkdir(tmpRootLocales, { recursive: true })
  await mkdir(tmpAdminLocales, { recursive: true })
  await cp(playgroundRootLocales, tmpRootLocales, { recursive: true })
  await cp(playgroundAdminLocales, tmpAdminLocales, { recursive: true })
}

// ─── Unit-level: removeNestedValue ──────────────────────────────

describe('removeNestedValue', () => {
  it('removes a leaf key', () => {
    const obj = { a: { b: { c: 'hello', d: 'world' } } }
    const removed = removeNestedValue(obj, 'a.b.c')
    expect(removed).toBe(true)
    expect(obj).toEqual({ a: { b: { d: 'world' } } })
  })

  it('cleans up empty parent objects', () => {
    const obj = { a: { b: { c: 'only' } }, x: 1 }
    const removed = removeNestedValue(obj, 'a.b.c')
    expect(removed).toBe(true)
    // a.b is now empty → removed, a is now empty → removed
    expect(obj).toEqual({ x: 1 })
  })

  it('returns false for non-existent key', () => {
    const obj = { a: { b: 'hello' } }
    const removed = removeNestedValue(obj, 'a.c')
    expect(removed).toBe(false)
    expect(obj).toEqual({ a: { b: 'hello' } })
  })

  it('returns false when traversal hits a non-object', () => {
    const obj = { a: 'string' }
    const removed = removeNestedValue(obj, 'a.b.c')
    expect(removed).toBe(false)
  })

  it('removes a top-level key', () => {
    const obj = { a: 1, b: 2 }
    const removed = removeNestedValue(obj, 'a')
    expect(removed).toBe(true)
    expect(obj).toEqual({ b: 2 })
  })
})

// ─── Unit-level: renameNestedKey ────────────────────────────────

describe('renameNestedKey', () => {
  it('renames a leaf key', () => {
    const obj = { a: { b: 'hello' }, c: 1 }
    const renamed = renameNestedKey(obj, 'a.b', 'a.d')
    expect(renamed).toBe(true)
    expect(obj).toEqual({ a: { d: 'hello' }, c: 1 })
  })

  it('moves a key to a different namespace', () => {
    const obj = { a: { b: 'hello' }, x: {} }
    const renamed = renameNestedKey(obj, 'a.b', 'x.y')
    expect(renamed).toBe(true)
    expect(getNestedValue(obj, 'x.y')).toBe('hello')
    expect(getNestedValue(obj, 'a.b')).toBeUndefined()
    // a was emptied → cleaned up
    expect(hasNestedKey(obj, 'a')).toBe(false)
  })

  it('creates intermediate objects for the new path', () => {
    const obj = { a: { b: 'hello' } }
    const renamed = renameNestedKey(obj, 'a.b', 'x.y.z')
    expect(renamed).toBe(true)
    expect(getNestedValue(obj, 'x.y.z')).toBe('hello')
  })

  it('returns false if old key does not exist', () => {
    const obj = { a: 1 }
    const renamed = renameNestedKey(obj, 'b', 'c')
    expect(renamed).toBe(false)
    expect(obj).toEqual({ a: 1 })
  })

  it('preserves nested objects when renaming', () => {
    const obj = { a: { b: { c: 1, d: 2 } } }
    const renamed = renameNestedKey(obj, 'a.b', 'x.y')
    expect(renamed).toBe(true)
    expect(getNestedValue(obj, 'x.y')).toEqual({ c: 1, d: 2 })
  })
})

// ─── Integration: remove across locale files ────────────────────

describe('remove_translations integration', () => {
  beforeEach(async () => {
    await copyLocaleFiles()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('removes a key from all locale files in a layer', async () => {
    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      await mutateLocaleFile(filePath, (data) => {
        removeNestedValue(data, 'common.actions.save')
      })
    }

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      expect(hasNestedKey(data, 'common.actions.save')).toBe(false)
      expect(hasNestedKey(data, 'common.actions.cancel')).toBe(true)
      expect(hasNestedKey(data, 'common.actions.delete')).toBe(true)
    }
  })

  it('removes multiple keys from all locales', async () => {
    const keysToRemove = ['common.actions.save', 'common.messages.loading']

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      await mutateLocaleFile(filePath, (data) => {
        for (const key of keysToRemove) {
          removeNestedValue(data, key)
        }
      })
    }

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      expect(hasNestedKey(data, 'common.actions.save')).toBe(false)
      expect(hasNestedKey(data, 'common.messages.loading')).toBe(false)
      expect(hasNestedKey(data, 'common.actions.cancel')).toBe(true)
      expect(hasNestedKey(data, 'common.messages.success')).toBe(true)
    }
  })

  it('removing all keys in a namespace cleans up parent objects', async () => {
    const navKeys = ['common.navigation.back', 'common.navigation.home', 'common.navigation.settings']

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      await mutateLocaleFile(filePath, (data) => {
        for (const key of navKeys) {
          removeNestedValue(data, key)
        }
      })
    }

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      expect(hasNestedKey(data, 'common.navigation')).toBe(false)
      expect(hasNestedKey(data, 'common.actions')).toBe(true)
      expect(hasNestedKey(data, 'common.messages')).toBe(true)
    }
  })

  it('non-existent key does not corrupt the file', async () => {
    const filePath = join(tmpRootLocales, 'en-US.json')
    const before = await readLocaleFile(filePath)
    const beforeKeys = getLeafKeys(before)

    await mutateLocaleFile(filePath, (data) => {
      removeNestedValue(data, 'nonexistent.key.path')
    })

    const after = await readLocaleFile(filePath)
    const afterKeys = getLeafKeys(after)
    expect(afterKeys).toEqual(beforeKeys)
  })

  it('preserves file formatting after removal', async () => {
    const filePath = join(tmpRootLocales, 'en-US.json')

    await mutateLocaleFile(filePath, (data) => {
      removeNestedValue(data, 'common.actions.save')
    })

    const raw = await readFile(filePath, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

// ─── Integration: rename across locale files ────────────────────

describe('rename_translation_key integration', () => {
  beforeEach(async () => {
    await copyLocaleFiles()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('renames a key in all locale files', async () => {
    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      await mutateLocaleFile(filePath, (data) => {
        renameNestedKey(data, 'common.actions.save', 'common.buttons.save')
      })
    }

    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      expect(hasNestedKey(data, 'common.actions.save')).toBe(false)
      expect(hasNestedKey(data, 'common.buttons.save')).toBe(true)
      const value = getNestedValue(data, 'common.buttons.save')
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    }
  })

  it('preserves specific values per locale after rename', async () => {
    // Capture values before rename
    const valuesBefore: Record<string, unknown> = {}
    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      valuesBefore[file] = getNestedValue(data, 'common.actions.save')
    }

    // Rename
    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      await mutateLocaleFile(filePath, (data) => {
        renameNestedKey(data, 'common.actions.save', 'common.buttons.save')
      })
    }

    // Verify values are preserved
    for (const file of localeFiles) {
      const filePath = join(tmpRootLocales, file)
      const data = await readLocaleFile(filePath)
      expect(getNestedValue(data, 'common.buttons.save')).toBe(valuesBefore[file])
    }
  })

  it('moves a key to a completely new namespace', async () => {
    const filePath = join(tmpRootLocales, 'en-US.json')
    const before = await readLocaleFile(filePath)
    const originalValue = getNestedValue(before, 'common.navigation.home')

    await mutateLocaleFile(filePath, (data) => {
      renameNestedKey(data, 'common.navigation.home', 'ui.nav.homePage')
    })

    const after = await readLocaleFile(filePath)
    expect(hasNestedKey(after, 'common.navigation.home')).toBe(false)
    expect(getNestedValue(after, 'ui.nav.homePage')).toBe(originalValue)
  })

  it('renames across app-admin layer locales', async () => {
    for (const file of localeFiles) {
      const filePath = join(tmpAdminLocales, file)
      try {
        const data = await readLocaleFile(filePath)
        if (hasNestedKey(data, 'admin.dashboard.title')) {
          await mutateLocaleFile(filePath, (fileData) => {
            renameNestedKey(fileData, 'admin.dashboard.title', 'admin.overview.title')
          })
        }
      } catch {
        // File may not exist
      }
    }

    // Verify in de-DE (we know it exists and had admin.dashboard.title)
    const deFile = join(tmpAdminLocales, 'de-DE.json')
    const deData = await readLocaleFile(deFile)
    expect(hasNestedKey(deData, 'admin.dashboard.title')).toBe(false)
    expect(getNestedValue(deData, 'admin.overview.title')).toBe('Dashboard')
  })

  it('does not rename if old key does not exist', async () => {
    const filePath = join(tmpRootLocales, 'en-US.json')
    const before = await readLocaleFile(filePath)
    const beforeKeys = getLeafKeys(before)

    await mutateLocaleFile(filePath, (data) => {
      renameNestedKey(data, 'does.not.exist', 'new.path')
    })

    const after = await readLocaleFile(filePath)
    const afterKeys = getLeafKeys(after)
    expect(afterKeys).toEqual(beforeKeys)
  })

  it('preserves file formatting after rename', async () => {
    const filePath = join(tmpRootLocales, 'en-US.json')

    await mutateLocaleFile(filePath, (data) => {
      renameNestedKey(data, 'common.actions.save', 'common.actions.submit')
    })

    const raw = await readFile(filePath, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(raw)).not.toThrow()

    const parsed = JSON.parse(raw)
    expect(hasNestedKey(parsed, 'common.actions.submit')).toBe(true)
  })
})

// ─── Dry-run preview logic ──────────────────────────────────────

describe('dry-run preview logic', () => {
  it('collects preview data for remove without mutating', async () => {
    // Simulate dry-run: read files, collect what would be removed, but don't write
    const data = await readLocaleFile(join(playgroundRootLocales, 'en-US.json'))

    const preview: Array<{ key: string; value: unknown }> = []
    const keysToRemove = ['common.actions.save', 'common.nonexistent']

    for (const key of keysToRemove) {
      const value = getNestedValue(data, key)
      if (value !== undefined) {
        preview.push({ key, value })
      }
    }

    expect(preview).toHaveLength(1)
    expect(preview[0].key).toBe('common.actions.save')
    expect(preview[0].value).toBe('Save')

    // Original file untouched
    const dataAfter = await readLocaleFile(join(playgroundRootLocales, 'en-US.json'))
    expect(hasNestedKey(dataAfter, 'common.actions.save')).toBe(true)
  })

  it('collects preview data for rename without mutating', async () => {
    const data = await readLocaleFile(join(playgroundRootLocales, 'en-US.json'))

    const oldKey = 'common.actions.save'
    const newKey = 'common.buttons.save'

    const value = getNestedValue(data, oldKey)
    const wouldConflict = hasNestedKey(data, newKey)

    expect(value).toBe('Save')
    expect(wouldConflict).toBe(false)

    // Original file untouched
    const dataAfter = await readLocaleFile(join(playgroundRootLocales, 'en-US.json'))
    expect(hasNestedKey(dataAfter, oldKey)).toBe(true)
    expect(hasNestedKey(dataAfter, newKey)).toBe(false)
  })

  it('detects conflicts in rename preview', async () => {
    const data = await readLocaleFile(join(playgroundRootLocales, 'en-US.json'))

    // Trying to rename to a key that already exists
    const oldKey = 'common.actions.save'
    const newKey = 'common.actions.cancel' // already exists

    const value = getNestedValue(data, oldKey)
    const wouldConflict = hasNestedKey(data, newKey)

    expect(value).toBe('Save')
    expect(wouldConflict).toBe(true)
  })
})
