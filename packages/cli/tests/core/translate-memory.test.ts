import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  MEMORY_FILE,
  emptyMemory,
  isStale,
  readMemory,
  recordTranslation,
  sourceHash,
  writeMemory,
} from '../../src/core/translate/memory.js'
import type { TranslationMemory } from '../../src/core/translate/memory.js'
import { translateMissing, translateKey, writeTranslations } from '../../src/core/operations.js'
import type { TranslateMissingOptions, TranslateMissingResult } from '../../src/core/types.js'
import { clearConfigCache } from '../../src/config/detector.js'
import { clearFileCache } from '../../src/io/json-reader.js'
import { fakeTranslator } from '../fixtures/translate-harness.js'
import { runOperation } from '../fixtures/surface.js'

/**
 * Translation memory: hashes of the source text each target was translated
 * from. Driven against real temp projects through the generic adapter — no
 * mocks — so what is asserted is the lockfile on disk and the result shape a
 * caller actually receives.
 */

const SOURCE = {
  greeting: 'Hello {name}',
  actions: {
    save: 'Save',
    cancel: 'Cancel',
  },
}

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
  clearConfigCache()
  clearFileCache()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-memory-'))
  created.push(dir)
  return dir
}

/**
 * A three-locale project translating from `en`. `translationMemory` is left
 * out of the config unless a test says otherwise, so the default is what most
 * of this file exercises.
 */
async function createProject(opts: { translationMemory?: boolean } = {}): Promise<string> {
  const dir = await tempDir()
  const locales = join(dir, 'i18n', 'locales')
  await mkdir(locales, { recursive: true })
  await writeFile(join(dir, '.i18n-mcp.json'), JSON.stringify({
    localeDirs: [{ path: 'i18n/locales', layer: 'root' }],
    defaultLocale: 'en',
    locales: ['en', 'de', 'fr'],
    ...(opts.translationMemory === undefined ? {} : { translationMemory: opts.translationMemory }),
  }, null, 2))
  await writeFile(join(locales, 'en.json'), JSON.stringify(SOURCE, null, 2))
  await writeFile(join(locales, 'de.json'), '{}\n')
  await writeFile(join(locales, 'fr.json'), '{}\n')
  clearConfigCache()
  clearFileCache()
  return dir
}

const localeFile = (dir: string, code: string) => join(dir, 'i18n', 'locales', `${code}.json`)
const lockPath = (dir: string) => join(dir, MEMORY_FILE)

async function readLocale(dir: string, code: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(localeFile(dir, code), 'utf-8')) as Record<string, unknown>
}

async function readLock(dir: string): Promise<TranslationMemory> {
  return JSON.parse(await readFile(lockPath(dir), 'utf-8')) as TranslationMemory
}

/** Edit the source file behind the read cache's back, as a developer would. */
async function editSource(dir: string, mutate: (data: Record<string, unknown>) => void): Promise<void> {
  const data = await readLocale(dir, 'en')
  mutate(data)
  await writeFile(localeFile(dir, 'en'), JSON.stringify(data, null, 2))
  clearFileCache()
}

async function translateAll(
  dir: string,
  opts: Partial<TranslateMissingOptions> = {},
  transform: (key: string, value: string) => string = (_k, v) => `[t] ${v}`,
): Promise<TranslateMissingResult> {
  return await translateMissing({
    projectDir: dir,
    layer: 'root',
    translateFn: fakeTranslator(transform),
    ...opts,
  }) as TranslateMissingResult
}

/** The result as a project without a translation memory would report it. */
function withoutMemoryFields(result: TranslateMissingResult): TranslateMissingResult {
  const clone = structuredClone(result)
  delete clone.summary.staleCount
  for (const locale of Object.values(clone.results ?? {})) delete locale.stale
  return clone
}

describe('the lockfile itself', () => {
  it('hashes a source value stably and distinguishably', () => {
    expect(sourceHash('Save')).toBe(sourceHash('Save'))
    expect(sourceHash('Save')).toMatch(/^[0-9a-f]{16}$/)
    expect(sourceHash('Save')).not.toBe(sourceHash('Store'))
    expect(sourceHash('')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('writes sorted JSON that reads back unchanged, leaving no temp files', async () => {
    const dir = await tempDir()
    const memory: TranslationMemory = {
      version: 2,
      sourceLocale: 'en',
      entries: {
        zeta: { 'b.key': { [sourceHash('B')]: ['fr', 'de'] } },
        alpha: { 'z.key': { [sourceHash('Z')]: ['de'] }, 'a.key': { [sourceHash('A')]: ['de'] } },
      },
    }

    await writeMemory(dir, memory)

    const raw = await readFile(lockPath(dir), 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw) as TranslationMemory
    expect(Object.keys(parsed.entries)).toEqual(['alpha', 'zeta'])
    expect(Object.keys(parsed.entries.alpha!)).toEqual(['a.key', 'z.key'])
    expect(parsed.entries.zeta!['b.key']).toEqual({ [sourceHash('B')]: ['de', 'fr'] })
    // Sorting is the only thing writing changes; the memory itself survives it.
    expect(await readMemory(dir)).toEqual({
      ...memory,
      entries: { ...memory.entries, zeta: { 'b.key': { [sourceHash('B')]: ['de', 'fr'] } } },
    })

    expect((await readdir(dir)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('stores one hash per source version, not one per locale', async () => {
    const dir = await tempDir()
    const memory = emptyMemory('en')
    for (const locale of ['de', 'fr', 'it']) recordTranslation(memory, 'root', 'actions.save', locale, 'Save')
    // `it` alone was retranslated after the source changed.
    recordTranslation(memory, 'root', 'actions.save', 'it', 'Store')

    await writeMemory(dir, memory)

    expect((await readMemory(dir)).entries.root!['actions.save']).toEqual({
      [sourceHash('Save')]: ['de', 'fr'],
      [sourceHash('Store')]: ['it'],
    })
  })

  it('reads an absent or unreadable file as an empty memory', async () => {
    const dir = await tempDir()
    expect(await readMemory(dir)).toEqual(emptyMemory())

    await writeFile(lockPath(dir), '{ not json')
    expect(await readMemory(dir)).toEqual(emptyMemory())

    await writeFile(lockPath(dir), JSON.stringify({ version: 99, sourceLocale: 'en', entries: {} }))
    expect(await readMemory(dir)).toEqual(emptyMemory())
  })

  // A version 1 file recorded a hash per target locale. Reading it as empty
  // would call every recorded translation unknown and re-spend tokens on it.
  it('migrates a version 1 file instead of discarding what it recorded', async () => {
    const dir = await tempDir()
    await writeFile(lockPath(dir), JSON.stringify({
      version: 1,
      sourceLocale: 'en',
      entries: {
        root: {
          'actions.save': { de: sourceHash('Save'), fr: sourceHash('Save') },
          greeting: { de: sourceHash('Hello'), fr: sourceHash('Hi') },
        },
      },
    }))

    const memory = await readMemory(dir)

    expect(memory.version).toBe(2)
    expect(memory.entries.root!['actions.save']).toEqual({ [sourceHash('Save')]: ['de', 'fr'] })
    expect(memory.entries.root!.greeting).toEqual({
      [sourceHash('Hello')]: ['de'],
      [sourceHash('Hi')]: ['fr'],
    })
    expect(isStale(memory, 'root', 'actions.save', 'de', 'Save')).toBe(false)
    expect(isStale(memory, 'root', 'greeting', 'fr', 'Hello')).toBe(true)

    await writeMemory(dir, memory)
    expect((JSON.parse(await readFile(lockPath(dir), 'utf-8')) as TranslationMemory).version).toBe(2)
  })

  it('calls a key stale only when a recorded hash disagrees with the source', () => {
    const memory = emptyMemory('en')
    // Nothing recorded: a hand-written translation is not evidence of staleness.
    expect(isStale(memory, 'root', 'actions.save', 'de', 'Save')).toBe(false)

    expect(recordTranslation(memory, 'root', 'actions.save', 'de', 'Save')).toBe(true)
    expect(recordTranslation(memory, 'root', 'actions.save', 'de', 'Save')).toBe(false)

    expect(isStale(memory, 'root', 'actions.save', 'de', 'Save')).toBe(false)
    expect(isStale(memory, 'root', 'actions.save', 'de', 'Store')).toBe(true)
    expect(isStale(memory, 'root', 'actions.save', 'fr', 'Store')).toBe(false)
  })

  // A locale left under its old hash would read as stale forever, however
  // often it is retranslated.
  it('moves a locale to the new hash and drops the bucket it emptied', () => {
    const memory = emptyMemory('en')
    recordTranslation(memory, 'root', 'actions.save', 'de', 'Save')
    recordTranslation(memory, 'root', 'actions.save', 'fr', 'Save')

    expect(recordTranslation(memory, 'root', 'actions.save', 'de', 'Store')).toBe(true)
    expect(memory.entries.root!['actions.save']).toEqual({
      [sourceHash('Save')]: ['fr'],
      [sourceHash('Store')]: ['de'],
    })

    recordTranslation(memory, 'root', 'actions.save', 'fr', 'Store')
    expect(memory.entries.root!['actions.save']).toEqual({ [sourceHash('Store')]: ['de', 'fr'] })
    expect(isStale(memory, 'root', 'actions.save', 'fr', 'Store')).toBe(false)
  })
})

describe('translateMissing with a translation memory', () => {
  it('records the source hash of every translation it writes', async () => {
    const dir = await createProject({ translationMemory: true })

    const result = await translateAll(dir)

    expect(result.summary.totalTranslated).toBe(6) // 3 keys × de + fr
    const lock = await readLock(dir)
    expect(lock.version).toBe(2)
    expect(lock.sourceLocale).toBe('en')
    expect(Object.keys(lock.entries.root!)).toEqual(['actions.cancel', 'actions.save', 'greeting'])
    expect(lock.entries.root!['actions.save']).toEqual({ [sourceHash('Save')]: ['de', 'fr'] })
    expect(lock.entries.root!.greeting).toEqual({ [sourceHash('Hello {name}')]: ['de', 'fr'] })
  })

  it('reports a key whose source changed as stale, without touching its value', async () => {
    const dir = await createProject({ translationMemory: true })
    await translateAll(dir)
    const before = await readLocale(dir, 'de')

    await editSource(dir, data => { data.greeting = 'Hi {name}' })
    const result = await translateAll(dir)

    expect(result.results!.de!.stale).toEqual(['greeting'])
    expect(result.results!.fr!.stale).toEqual(['greeting'])
    expect(result.summary.staleCount).toBe(2)
    // Stale keys are their own bucket: nothing was missing, so nothing counts
    // as translated, failed or skipped either.
    expect(result.results!.de!.missing).toBe(0)
    expect(result.summary.totalTranslated).toBe(0)
    expect(await readLocale(dir, 'de')).toEqual(before)
  })

  it('re-translates only the stale key when overwriteStale is set', async () => {
    const dir = await createProject({ translationMemory: true })
    await translateAll(dir)

    await editSource(dir, data => { data.greeting = 'Hi {name}' })
    const result = await translateAll(dir, { overwriteStale: true }, (_k, v) => `[again] ${v}`)

    expect(result.results!.de!.translated).toEqual(['greeting'])
    expect(result.results!.de!.missing).toBe(1)
    expect(result.results!.de!.stale).toBeUndefined()
    expect(result.summary.staleCount).toBeUndefined()

    const de = await readLocale(dir, 'de')
    expect(de.greeting).toBe('[again] Hi {name}')
    expect((de.actions as Record<string, string>).save).toBe('[t] Save')

    // The rewritten value is recorded against the new source, so a follow-up
    // run has nothing left to report, and the hash it replaced is gone.
    expect((await readLock(dir)).entries.root!.greeting).toEqual({
      [sourceHash('Hi {name}')]: ['de', 'fr'],
    })
    expect((await translateAll(dir)).summary.staleCount).toBeUndefined()
  })

  it('does not treat translations written before the memory existed as stale', async () => {
    const dir = await createProject({ translationMemory: true })
    // Fill de by hand, with no lockfile anywhere in sight.
    await writeFile(localeFile(dir, 'de'), JSON.stringify({ greeting: 'Hallo {name}' }, null, 2))
    clearFileCache()

    const result = await translateAll(dir)

    expect(result.results!.de!.stale).toBeUndefined()
    expect((await readLocale(dir, 'de')).greeting).toBe('Hallo {name}')
  })

  it('writes no lockfile in a dry run', async () => {
    const dir = await createProject({ translationMemory: true })

    const result = await translateAll(dir, { dryRun: true })

    expect(result.summary.mode).toBe('dry-run')
    expect(existsSync(lockPath(dir))).toBe(false)
  })

  it('survives an unreadable lockfile and replaces it', async () => {
    const dir = await createProject({ translationMemory: true })
    await writeFile(lockPath(dir), 'not a lockfile at all')

    const result = await translateAll(dir)

    expect(result.summary.totalTranslated).toBe(6)
    expect((await readLock(dir)).entries.root!['actions.save']).toEqual({
      [sourceHash('Save')]: ['de', 'fr'],
    })
  })

  // A file written before the shape changed still holds usable answers.
  it('reads a version 1 lockfile and rewrites it in the current shape', async () => {
    const dir = await createProject()
    await translateAll(dir)
    const v2 = await readLock(dir)
    await writeFile(lockPath(dir), JSON.stringify({
      version: 1,
      sourceLocale: 'en',
      entries: { root: { greeting: { de: sourceHash('Hello {name}'), fr: sourceHash('Hello {name}') } } },
    }))

    await editSource(dir, data => { data.greeting = 'Hi {name}' })
    const result = await translateAll(dir)

    expect(result.results!.de!.stale).toEqual(['greeting'])
    const lock = await readLock(dir)
    expect(lock.version).toBe(2)
    expect(lock.entries.root!.greeting).toEqual(v2.entries.root!.greeting)
  })
})

/**
 * The surface path: what a terminal or an MCP host reaches. The core option is
 * only worth having if a caller can ask for it, which is what the descriptor
 * decides — and it took the same spelling on both surfaces.
 */
describe('overwriteStale through the operation descriptor', () => {
  const runTranslate = async (dir: string, args: Record<string, unknown>): Promise<TranslateMissingResult> =>
    await runOperation<TranslateMissingResult>(
      'translate',
      { projectDir: dir, layer: 'root', ...args },
      { translateFn: fakeTranslator((_k, v) => `[cli] ${v}`) },
    )

  /** A project whose de/fr translations were made from source text since edited. */
  async function projectWithStaleTargets(): Promise<string> {
    const dir = await createProject({ translationMemory: true })
    await translateAll(dir)
    await editSource(dir, (data) => { data.greeting = 'Hi {name}' })
    return dir
  }

  it('re-translates the stale keys when asked, and only then', async () => {
    const untouched = await projectWithStaleTargets()
    const rewritten = await projectWithStaleTargets()

    const reported = await runTranslate(untouched, {})
    expect(reported.results!.de!.stale).toEqual(['greeting'])
    expect((await readLocale(untouched, 'de')).greeting).toBe('[t] Hello {name}')

    const result = await runTranslate(rewritten, { overwriteStale: true })
    expect(result.results!.de!.translated).toEqual(['greeting'])
    expect(result.results!.de!.stale).toBeUndefined()
    expect((await readLocale(rewritten, 'de')).greeting).toBe('[cli] Hi {name}')
  })

  it('changes nothing in a project without a translation memory', async () => {
    const dir = await createProject({ translationMemory: false })
    await translateAll(dir)
    await editSource(dir, (data) => { data.greeting = 'Hi {name}' })

    const result = await runTranslate(dir, { overwriteStale: true })

    // Nothing is known to be stale, so there is nothing to re-translate: the
    // existing value stands, exactly as it does without the flag.
    expect(result.summary.totalTranslated).toBe(0)
    expect((await readLocale(dir, 'de')).greeting).toBe('[t] Hello {name}')
  })
})

describe('the translationMemory setting', () => {
  // The lockfile is what makes a stale translation visible at all, so a project
  // gets one without asking — the first run creates it.
  it('records a run in a project that never mentioned it', async () => {
    const dir = await createProject()

    await translateAll(dir)

    const lock = await readLock(dir)
    expect(lock.version).toBe(2)
    expect(lock.entries.root!['actions.save']).toEqual({ [sourceHash('Save')]: ['de', 'fr'] })
  })

  it('leaves an existing lockfile untouched when set to false', async () => {
    const dir = await createProject({ translationMemory: false })
    const before = JSON.stringify({
      version: 2,
      sourceLocale: 'en',
      entries: { root: { greeting: { [sourceHash('Hello {name}')]: ['de'] } } },
    })
    await writeFile(lockPath(dir), before)

    await editSource(dir, data => { data.greeting = 'Hi {name}' })
    const result = await translateAll(dir)

    expect(result.summary.staleCount).toBeUndefined()
    expect(await readFile(lockPath(dir), 'utf-8')).toBe(before)
  })

  it('writes no lockfile and returns what it always has when set to false', async () => {
    const on = await createProject({ translationMemory: true })
    const off = await createProject({ translationMemory: false })

    expect(await translateAll(off)).toEqual(await translateAll(on))

    await editSource(on, data => { data.greeting = 'Hi {name}' })
    await editSource(off, data => { data.greeting = 'Hi {name}' })
    const staleRun = await translateAll(on)
    const plainRun = await translateAll(off)

    expect(staleRun.summary.staleCount).toBe(2)
    expect(plainRun).toEqual(withoutMemoryFields(staleRun))
    expect(existsSync(lockPath(off))).toBe(false)
  })
})

describe('translateKey with a translation memory', () => {
  const skipRequest = (dir: string) => ({
    projectDir: dir,
    layer: 'root',
    key: 'actions.save',
    sourceLocale: 'en',
    targetLocales: ['de'],
    overwrite: false,
  })

  it('marks an existing translation up to date, then stale once the source changes', async () => {
    const dir = await createProject({ translationMemory: true })
    await translateAll(dir)

    const current = await translateKey(skipRequest(dir))
    expect(current.skipped).toEqual([{ locale: 'de', reason: 'already-translated', stale: false }])

    await editSource(dir, (data) => {
      (data.actions as Record<string, string>).save = 'Store'
    })
    const outdated = await translateKey(skipRequest(dir))
    expect(outdated.skipped).toEqual([{ locale: 'de', reason: 'already-translated', stale: true }])
  })

  it('records what it wrote, so the next run does not call it stale', async () => {
    const dir = await createProject({ translationMemory: true })
    await editSource(dir, (data) => {
      (data.actions as Record<string, string>).save = 'Store'
    })

    const result = await translateKey({
      projectDir: dir,
      layer: 'root',
      key: 'actions.save',
      sourceLocale: 'en',
      targetLocales: ['de'],
      translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
    })

    expect(result.translated).toEqual(['de'])
    expect((await readLock(dir)).entries.root!['actions.save']).toEqual({ [sourceHash('Store')]: ['de'] })

    const skipped = await translateKey(skipRequest(dir))
    expect(skipped.skipped).toEqual([{ locale: 'de', reason: 'already-translated', stale: false }])
  })
})

describe('write_translations and the translation memory', () => {
  it('records a hand-written target against the source text on disk', async () => {
    const dir = await createProject({ translationMemory: true })

    await writeTranslations({
      projectDir: dir,
      layer: 'root',
      translations: { 'actions.save': { de: 'Speichern' } },
    })

    expect((await readLock(dir)).entries.root!['actions.save']).toEqual({ [sourceHash('Save')]: ['de'] })
    expect((await translateAll(dir)).summary.staleCount).toBeUndefined()
  })

  it('makes every target of a rewritten source key stale', async () => {
    const dir = await createProject({ translationMemory: true })
    await translateAll(dir)

    await writeTranslations({
      projectDir: dir,
      layer: 'root',
      translations: { greeting: { en: 'Hi {name}' } },
    })

    const result = await translateAll(dir)
    expect(result.results!.de!.stale).toEqual(['greeting'])
    expect(result.summary.staleCount).toBe(2)
  })

  it('writes no lockfile in a dry run', async () => {
    const dir = await createProject({ translationMemory: true })

    await writeTranslations({
      projectDir: dir,
      layer: 'root',
      translations: { 'actions.save': { de: 'Speichern' } },
      dryRun: true,
    })

    expect(existsSync(lockPath(dir))).toBe(false)
  })
})
