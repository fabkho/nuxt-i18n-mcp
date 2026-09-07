/**
 * Translation memory: what each target locale was translated *from*.
 *
 * State alone cannot tell a current translation from an outdated one — a target
 * value exists either way. So every write records a hash of the source text it
 * was produced from, in `.i18n-kit.lock.json` at the project root (next to
 * `.i18n-mcp.json`). A later run compares that hash against the source text on
 * disk and knows whether the target still matches the sentence it translated.
 *
 * File shape:
 *
 * ```json
 * {
 *   "version": 2,
 *   "sourceLocale": "en",
 *   "entries": {
 *     "<layer>": { "<key>": { "<hash>": ["de", "fr"], "<hash2>": ["it"] } }
 *   }
 * }
 * ```
 *
 * Target locales are grouped under the hash they were written against instead
 * of each carrying a copy of it: the hash describes the source text, so a
 * 30-locale project would otherwise repeat one string 30 times per key in a
 * file that is committed and merged. Several buckets under one key are normal
 * and meant — locales translated at different times were written from
 * different source versions, and telling them apart is the point of the file.
 *
 * A hash is of the *source* value at the moment the locales listed under it
 * were written, not of any translation. That is the whole question this
 * file answers: for (layer, key, targetLocale), was the target written against
 * the current source? Nothing else is stored — in particular no copy of the
 * current source hash, which would be a second source of truth that silently
 * disagrees with the locale files as soon as someone edits one by hand. The
 * live source value is always read from disk instead.
 *
 * Two consequences worth knowing:
 *
 * - A key with no record is *not* stale. First runs, hand-written translations
 *   and files that predate the lockfile would otherwise all report as outdated,
 *   which would re-spend tokens on translations that are perfectly good.
 * - Editing the source value marks every target for that key stale for free:
 *   the recorded hashes no longer match, so no bookkeeping is needed on a
 *   source-locale write.
 *
 * Hashes are of one locale's text, so the memory only means anything relative
 * to a single source locale. It is recorded in the file, entries are dropped if
 * the project's default locale changes, and operations that translate from some
 * other reference locale bypass the memory entirely.
 *
 * The file is written sorted and atomically, so its git diff shows exactly the
 * keys a run touched. It is on unless the project sets `translationMemory` to
 * false, so the first translate run in a project creates it; turning it off
 * stops all reading and writing and leaves any existing file alone.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { I18nConfig } from '../../config/types.js'
import { atomicWrite } from '../../io/atomic-write.js'
import { getNestedValue } from '../../io/key-operations.js'
import { readLocaleData } from '../../io/locale-data.js'
import { toErrorMessage } from '../../utils/errors.js'
import { log } from '../../utils/logger.js'
import { findLocaleImpl } from '../shared.js'

/** Lockfile name, at the project root. */
export const MEMORY_FILE = '.i18n-kit.lock.json'

/**
 * Bumped only when the shape changes. Version 1 (a hash per target locale) is
 * migrated on read; anything else is ignored.
 */
export const MEMORY_VERSION = 2

/** Hash of a source value → the target locales written from it. */
export type LocalesByHash = Record<string, string[]>

/** layer → key → the source hashes that key's targets were written from. */
export type MemoryEntries = Record<string, Record<string, LocalesByHash>>

export interface TranslationMemory {
  version: number
  /** Locale whose values the hashes are of. Empty for a memory that has none yet. */
  sourceLocale: string
  entries: MemoryEntries
}

export function memoryFilePath(dir: string): string {
  return join(dir, MEMORY_FILE)
}

/**
 * The stored fingerprint of a source value. Truncated to 16 hex chars: the
 * lockfile is read by humans in diffs, and 64 bits is far past the point where
 * two edited sentences in one project collide.
 */
export function sourceHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

export function emptyMemory(sourceLocale = ''): TranslationMemory {
  return { version: MEMORY_VERSION, sourceLocale, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBuckets(raw: Record<string, unknown>): LocalesByHash {
  const buckets: LocalesByHash = {}
  for (const [hash, locales] of Object.entries(raw)) {
    if (!Array.isArray(locales)) continue
    buckets[hash] = locales.filter((l): l is string => typeof l === 'string')
  }
  return buckets
}

/** Version 1 stored one hash per target locale; group them into the buckets. */
function parseV1Buckets(raw: Record<string, unknown>): LocalesByHash {
  const buckets: LocalesByHash = {}
  for (const [locale, hash] of Object.entries(raw)) {
    if (typeof hash === 'string') (buckets[hash] ??= []).push(locale)
  }
  return buckets
}

/**
 * Accept what this version wrote and migrate what version 1 did; anything else
 * is treated as no memory. A migrated file keeps every recorded hash, so the
 * bump costs no re-translation.
 */
function parseMemory(raw: string): { memory: TranslationMemory, migrated: boolean } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const legacy = parsed.version === 1
  if (!legacy && parsed.version !== MEMORY_VERSION) return null
  if (typeof parsed.sourceLocale !== 'string' || !isRecord(parsed.entries)) return null

  const entries: MemoryEntries = {}
  for (const [layer, keys] of Object.entries(parsed.entries)) {
    if (!isRecord(keys)) continue
    const layerEntries: Record<string, LocalesByHash> = {}
    for (const [key, buckets] of Object.entries(keys)) {
      if (!isRecord(buckets)) continue
      layerEntries[key] = legacy ? parseV1Buckets(buckets) : parseBuckets(buckets)
    }
    entries[layer] = layerEntries
  }
  return {
    memory: { version: MEMORY_VERSION, sourceLocale: parsed.sourceLocale, entries },
    migrated: legacy,
  }
}

/**
 * Read the lockfile, plus whether the file on disk has to be replaced: an
 * unreadable one is reported as empty so the run continues, and rewritten at
 * the end rather than left to fail every future run the same way. A migrated
 * older file is equally due a rewrite, so the next run reads it natively.
 */
async function loadMemory(dir: string): Promise<{ memory: TranslationMemory, mustRewrite: boolean }> {
  let raw: string
  try {
    raw = await readFile(memoryFilePath(dir), 'utf-8')
  } catch (error) {
    // No file is the ordinary first run, not a problem to report.
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    if (!missing) {
      log.warn(`Could not read ${MEMORY_FILE}: ${toErrorMessage(error)} — continuing with an empty translation memory.`)
    }
    return { memory: emptyMemory(), mustRewrite: !missing }
  }

  const parsed = parseMemory(raw)
  if (!parsed) {
    log.warn(`${MEMORY_FILE} is not a version ${MEMORY_VERSION} translation memory — continuing as if empty and rewriting it.`)
    return { memory: emptyMemory(), mustRewrite: true }
  }
  return { memory: parsed.memory, mustRewrite: parsed.migrated }
}

/**
 * Read the lockfile, in this version's shape whatever version wrote it. Never
 * throws: an unreadable or foreign file yields an empty memory (and a
 * warning), because a translate run must not fail over its own bookkeeping.
 */
export async function readMemory(dir: string): Promise<TranslationMemory> {
  return (await loadMemory(dir)).memory
}

/** Sort every level so the file's diff shows only the keys a run touched. */
function sortMemory(memory: TranslationMemory): TranslationMemory {
  const entries: MemoryEntries = {}
  for (const layer of Object.keys(memory.entries).sort()) {
    const keys = memory.entries[layer] ?? {}
    const layerEntries: Record<string, LocalesByHash> = {}
    for (const key of Object.keys(keys).sort()) {
      const buckets = keys[key] ?? {}
      const sorted: LocalesByHash = {}
      for (const hash of Object.keys(buckets).sort()) {
        sorted[hash] = [...(buckets[hash] ?? [])].sort()
      }
      layerEntries[key] = sorted
    }
    entries[layer] = layerEntries
  }
  return { version: memory.version, sourceLocale: memory.sourceLocale, entries }
}

export async function writeMemory(dir: string, memory: TranslationMemory): Promise<void> {
  await atomicWrite(memoryFilePath(dir), JSON.stringify(sortMemory(memory), null, 2) + '\n')
}

/** The source hash `locale` was written from, or undefined if nothing recorded it. */
function recordedHash(buckets: LocalesByHash, locale: string): string | undefined {
  for (const [hash, locales] of Object.entries(buckets)) {
    if (locales.includes(locale)) return hash
  }
  return undefined
}

/**
 * Whether `locale`'s value for this key was written from different source text
 * than the one on disk now. Unknown keys are not stale — see the module header.
 */
export function isStale(
  memory: TranslationMemory,
  layer: string,
  key: string,
  locale: string,
  currentSourceValue: string,
): boolean {
  const buckets = memory.entries[layer]?.[key]
  if (!buckets) return false
  const recorded = recordedHash(buckets, locale)
  if (recorded === undefined) return false
  return recorded !== sourceHash(currentSourceValue)
}

/**
 * Remember that `locale`'s value for this key was written from `sourceValue`.
 * Returns whether anything changed, so a run that re-records what the file
 * already says does not rewrite it.
 */
export function recordTranslation(
  memory: TranslationMemory,
  layer: string,
  key: string,
  locale: string,
  sourceValue: string,
): boolean {
  const hash = sourceHash(sourceValue)
  const layerEntries = (memory.entries[layer] ??= {})
  const buckets = (layerEntries[key] ??= {})
  const previous = recordedHash(buckets, locale)
  if (previous === hash) return false
  if (previous !== undefined) {
    // A locale sits under exactly one hash: the one its value was last written
    // from. Leaving it under the old one too would report it stale forever.
    const rest = (buckets[previous] ?? []).filter(l => l !== locale)
    if (rest.length === 0) delete buckets[previous]
    else buckets[previous] = rest
  }
  const bucket = (buckets[hash] ??= [])
  bucket.push(locale)
  return true
}

/**
 * On unless the project turned it off, so a project gets the lockfile without
 * asking. `false` also stops reading an existing file, which stays untouched.
 */
export function isTranslationMemoryEnabled(config: I18nConfig): boolean {
  return config.projectConfig?.translationMemory !== false
}

/** The project's default locale, as a canonical code. */
function defaultLocaleCode(config: I18nConfig): string {
  return findLocaleImpl(config, config.defaultLocale)?.code ?? config.defaultLocale
}

/**
 * One operation's view of the memory: the loaded file, the questions the
 * translate operations ask of it, and a single write at the end.
 */
export interface TranslationMemorySession {
  readonly memory: TranslationMemory
  isStale(layer: string, key: string, locale: string, sourceValue: string): boolean
  record(layer: string, key: string, locale: string, sourceValue: string): void
  /** Overwrite the lockfile if this session changed it. Never throws. */
  flush(): Promise<void>
}

/**
 * Open the memory for one operation, or return null when it does not apply:
 * the feature is off, or the operation translates from something other than
 * the project's default locale — hashes of another locale's text cannot answer
 * whether a target matches the source.
 */
export async function openTranslationMemory(opts: {
  config: I18nConfig
  projectDir: string
  /** Canonical code of the locale this operation translates from. */
  sourceLocale: string
  dryRun?: boolean
}): Promise<TranslationMemorySession | null> {
  const { config, projectDir, sourceLocale } = opts
  if (!isTranslationMemoryEnabled(config)) return null

  const defaultCode = defaultLocaleCode(config)
  if (sourceLocale !== defaultCode) {
    log.debug(`Translation memory skipped: translating from "${sourceLocale}" rather than the project source locale "${defaultCode}".`)
    return null
  }

  const loaded = await loadMemory(projectDir)
  // Hashes recorded against another source locale are of text this run cannot
  // compare against, so they are dropped rather than trusted.
  const localeChanged = loaded.memory.sourceLocale !== '' && loaded.memory.sourceLocale !== defaultCode
  if (localeChanged) {
    log.warn(`${MEMORY_FILE} was recorded against source locale "${loaded.memory.sourceLocale}" but the project's is "${defaultCode}" — starting a fresh translation memory.`)
  }
  const memory: TranslationMemory = localeChanged
    ? emptyMemory(defaultCode)
    : { ...loaded.memory, sourceLocale: defaultCode }
  // Both cases leave the file on disk wrong, so it is rewritten at the end of
  // the run even if nothing new is recorded.
  let dirty = localeChanged || loaded.mustRewrite

  return {
    memory,
    isStale: (layer, key, locale, sourceValue) => isStale(memory, layer, key, locale, sourceValue),
    record: (layer, key, locale, sourceValue) => {
      if (recordTranslation(memory, layer, key, locale, sourceValue)) dirty = true
    },
    flush: async () => {
      // A dry run answers questions, it does not leave anything behind.
      if (opts.dryRun || !dirty) return
      try {
        await writeMemory(projectDir, memory)
        dirty = false
      } catch (error) {
        log.warn(`Could not write ${MEMORY_FILE}: ${toErrorMessage(error)} — translations were written, the translation memory was not updated.`)
      }
    },
  }
}

/**
 * Post-write hook for the plain write operations: record the target values a
 * write just put on disk as written against the current source text.
 *
 * Writes to the source locale itself need no entry — they change the text the
 * recorded hashes are compared against, which is exactly what marks that key's
 * targets stale.
 */
export async function recordWrittenTranslations(opts: {
  config: I18nConfig
  projectDir: string
  layer: string
  /** What the write actually applied, as canonical locale code and key. */
  writes: Array<{ locale: string, key: string }>
}): Promise<void> {
  const { config, projectDir, layer } = opts
  if (!isTranslationMemoryEnabled(config)) return

  const sourceCode = defaultLocaleCode(config)
  const targetWrites = opts.writes.filter(w => w.locale !== sourceCode)
  if (targetWrites.length === 0) return

  const session = await openTranslationMemory({ config, projectDir, sourceLocale: sourceCode })
  if (!session) return

  const sourceLocale = findLocaleImpl(config, sourceCode)
  if (!sourceLocale) return

  let sourceData: Record<string, unknown>
  try {
    // Read after the write, so a call that set the source value in the same
    // request records its targets against the new text rather than the old.
    sourceData = await readLocaleData(config, layer, sourceLocale)
  } catch (error) {
    log.warn(`Could not read source locale "${sourceCode}" to update ${MEMORY_FILE}: ${toErrorMessage(error)}`)
    return
  }

  for (const { locale, key } of targetWrites) {
    const value = getNestedValue(sourceData, key)
    if (typeof value === 'string') session.record(layer, key, locale, value)
  }
  await session.flush()
}
