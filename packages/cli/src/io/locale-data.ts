import { join, extname } from 'node:path'
import { readdir, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readLocale, writeLocale, mutateLocale } from './locale-io'
import { formatForFile, getFormat } from './formats'
import type { LocaleFormat } from './formats'
import type { I18nConfig, LocaleDefinition } from '../config/types'
import { log } from '../utils/logger'
import { FileIOError, toErrorMessage } from '../utils/errors'

/**
 * A single locale file entry with its path and optional namespace.
 * - Nuxt: one entry with namespace = null (flat file)
 * - Laravel / Next.js / React: one entry per file, namespace = filename without extension
 */
export interface LocaleEntry {
  /** Absolute path to the locale file */
  path: string
  /** Namespace for this entry (e.g., 'auth', 'validation'). null for flat file formats. */
  namespace: string | null
}

/**
 * Resolve all locale file entries for a given locale in a layer.
 *
 * - Nuxt (json): Returns a single entry `[{path: ".../en-US.json", namespace: null}]`
 * - Laravel (php-array): Scans `{langDir}/{localeCode}/*.php` and returns one entry per file
 * - Next.js / React (json): Scans `{localeDir}/{localeCode}/*.json` and returns one entry per file
 *   e.g., `[{path: ".../en/common.json", namespace: "common"}, ...]`
 *
 * Returns an empty array if the locale directory doesn't exist (e.g., new locale).
 */
export async function resolveLocaleEntries(
  config: I18nConfig,
  layer: string,
  locale: LocaleDefinition,
): Promise<LocaleEntry[]> {
  const localeDir = resolveLayerDir(config, layer)
  if (!localeDir) return []

  const format = getFormat(config.localeFileFormat)

  // Namespaced: Laravel's lang/<locale>/<namespace>.php, Next.js/React's
  // messages/en/common.json.
  const namespaced = await resolveNamespacedEntries(localeDir, locale.code, format.extensions)
  if (namespaced.length > 0) return namespaced

  const defaultExt = format.extensions[0]!

  if (format.flatFileFromDisk) {
    // Flat: lang/<locale>.php. Not Laravel's layout, but a legitimate one that
    // the generic adapter meets in the wild (#308), and indistinguishable from
    // namespaced by format alone — only the directory says which it is.
    const flat = locale.file ?? `${locale.code}${defaultExt}`
    return existsSync(join(localeDir, flat)) ? [{ path: join(localeDir, flat), namespace: null }] : []
  }

  // Flat and declared (Nuxt: i18n/en-US.json)
  if (!locale.file) {
    // A flat-layout locale without a `file` cannot be resolved at all — reads
    // would silently report {} and writes would vanish. If a matching flat
    // file exists on disk, this is a misconfiguration (e.g. an adapter that
    // forgot to set `file`): fail loudly instead of silently returning [].
    const flatCandidate = join(localeDir, `${locale.code}${defaultExt}`)
    if (existsSync(flatCandidate)) {
      log.warn(
        `Locale '${locale.code}' (layer '${layer}') uses a flat layout but has no 'file' set — `
        + `${flatCandidate} exists yet cannot be resolved. Reads will return no keys and writes will be no-ops. `
        + `Set 'file' on the locale definition (e.g. '${locale.code}${defaultExt}').`,
      )
    }
    return []
  }
  return [{ path: join(localeDir, locale.file), namespace: null }]
}

/**
 * Like readLocaleData, but reports a layer holding nothing for this locale as
 * absent — for scan loops that skip locales without data there.
 *
 * Absent only. A file that exists but cannot be read or parsed throws, because
 * "no keys" and "could not look" are the same answer to a caller that is about
 * to decide which keys nothing protects.
 */
export async function readLocaleDataIfPresent(
  config: I18nConfig,
  layer: string,
  locale: LocaleDefinition,
): Promise<Record<string, unknown> | null> {
  const data = await readLocaleData(config, layer, locale)
  return Object.keys(data).length === 0 ? null : data
}

/**
 * Read all locale data for a locale in a layer, merged into a single object.
 *
 * - Nuxt: Returns the JSON file contents as-is
 * - Laravel / Next.js / React: Reads each namespace file and mounts under its namespace key
 *   e.g., `{ auth: { failed: "..." }, common: { welcome: "Hello" } }`
 *
 * A file that is not there is an empty object — a locale legitimately has no
 * file in every layer. One that is there and unreadable throws FileIOError
 * naming it.
 */
export async function readLocaleData(
  config: I18nConfig,
  layer: string,
  locale: LocaleDefinition,
): Promise<Record<string, unknown>> {
  const entries = await resolveLocaleEntries(config, layer, locale)
  if (entries.length === 0) return {}

  const merged: Record<string, unknown> = {}

  for (const entry of entries) {
    let data: Record<string, unknown>
    try {
      data = await readLocale(entry.path)
    }
    catch (err) {
      if (err instanceof FileIOError && err.code === 'FILE_NOT_FOUND') {
        data = {}
      }
      else {
        throw err
      }
    }

    if (entry.namespace === null) {
      Object.assign(merged, data)
    }
    else {
      merged[entry.namespace] = data
    }
  }

  return merged
}

/**
 * Read, mutate, and write back locale data for a locale in a layer.
 *
 * The mutation function receives the merged locale object (same shape as readLocaleData)
 * and may modify it in-place. After mutation:
 *
 * - Nuxt: Writes the entire object back to the single JSON file
 * - Laravel / Next.js / React: Splits by top-level namespace keys and writes each to its file.
 *   New namespaces create new files. Empty namespaces delete the content (write empty object).
 *
 * Returns the set of file paths that were written.
 */
export async function mutateLocaleData(
  config: I18nConfig,
  layer: string,
  locale: LocaleDefinition,
  mutate: (data: Record<string, unknown>) => void,
): Promise<Set<string>> {
  const data = await readLocaleData(config, layer, locale)

  const filesWritten = new Set<string>()

  const entries = await resolveLocaleEntries(config, layer, locale)
  const format = getFormat(config.localeFileFormat)
  // What is on disk decides, not the declared format: a PHP project may be
  // namespaced (Laravel) or flat (#308), and writing one as the other would
  // restructure someone's locale files rather than edit them. The format is
  // the fallback for a locale that has no files yet, where there is nothing
  // to observe — scaffolding a new Laravel locale, for instance.
  const isNamespaced = entries.length > 0
    ? entries.some(e => e.namespace !== null)
    : format.defaultLayout === 'namespaced' || await hasNamespacedLayout(config, layer, format)

  if (isNamespaced) {
    // Per-namespace write (PHP arrays, namespaced JSON, …)
    const localeDir = resolveLayerDir(config, layer)
    if (!localeDir) return filesWritten

    const localePath = join(localeDir, locale.code)
    const firstEntry = entries[0]
    const fileExt = firstEntry
      ? extname(firstEntry.path) // the extension the locale already uses
      : format.extensions[0]!

    const preSnapshots = new Map<string, string>()
    for (const [ns, nsData] of Object.entries(data)) {
      preSnapshots.set(ns, JSON.stringify(nsData))
    }
    const mergedSnapshot = JSON.stringify(data)

    mutate(data)

    if (JSON.stringify(data) === mergedSnapshot) {
      return filesWritten
    }

    if (!existsSync(localePath)) {
      await mkdir(localePath, { recursive: true })
    }

    await writeChangedNamespaces(data, preSnapshots, localePath, fileExt, locale.code, filesWritten)
    await deleteRemovedNamespaceFiles(data, preSnapshots, localePath, fileExt, locale.code)
  }
  else {
    // Flat file write (Nuxt-style single JSON file)
    const snapshot = JSON.stringify(data)
    mutate(data)

    if (JSON.stringify(data) === snapshot) {
      return filesWritten
    }

    const firstEntry = entries[0]
    if (!firstEntry) return filesWritten
    const filePath = firstEntry.path
    await writeLocaleEntryFile(filePath, data)
    filesWritten.add(filePath)
  }

  return filesWritten
}

// ─── Internal helpers ───────────────────────────────────────────

/** Write every namespace whose content changed relative to its pre-mutation snapshot. */
async function writeChangedNamespaces(
  data: Record<string, unknown>,
  preSnapshots: Map<string, string>,
  localePath: string,
  fileExt: string,
  localeCode: string,
  filesWritten: Set<string>,
): Promise<void> {
  for (const [namespace, nsData] of Object.entries(data)) {
    if (typeof nsData !== 'object' || nsData === null) {
      log.warn(`Skipping non-object namespace '${namespace}' for locale '${localeCode}'`)
      continue
    }
    if (JSON.stringify(nsData) !== preSnapshots.get(namespace)) {
      const filePath = join(localePath, `${namespace}${fileExt}`)
      await writeLocaleEntryFile(filePath, nsData as Record<string, unknown>)
      filesWritten.add(filePath)
    }
  }
}

/**
 * Delete only the namespace files this mutation explicitly removed (top-level
 * keys present before the mutation and absent after) — never a
 * whole-directory reconciliation. Narrowing deletion to this mutation's own
 * removals also defuses the concurrency hazard: translateMissing runs one
 * mutation per locale in a Promise.all, and a directory-wide sweep could race
 * concurrent mutations on shared/aliased namespace dirs and delete files
 * another locale's mutation was about to write.
 */
async function deleteRemovedNamespaceFiles(
  data: Record<string, unknown>,
  preSnapshots: Map<string, string>,
  localePath: string,
  fileExt: string,
  localeCode: string,
): Promise<void> {
  for (const namespace of preSnapshots.keys()) {
    if (namespace in data) continue
    const filePath = join(localePath, `${namespace}${fileExt}`)
    if (!existsSync(filePath)) continue
    log.warn(`Deleting namespace file '${filePath}': namespace '${namespace}' was removed from locale '${localeCode}'`)
    try {
      await unlink(filePath)
    }
    catch (err) {
      throw new FileIOError(
        `Failed to delete removed namespace file: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      )
    }
    formatForFile(filePath).clearCacheEntry(filePath)
  }
}

/**
 * Write mutated locale data to a single file.
 *
 * Existing files go through their format's format-preserving mutate path:
 * indentation, trailing newline and PHP quote style are detected from the file
 * on disk, existing keys keep their on-disk order, and new keys are inserted
 * in sorted position among their siblings. The mutate path re-reads the file
 * with metadata (bypassing
 * the mtime read cache by design) and the write clears the cache entry, so
 * cached readers stay consistent.
 *
 * New files are written with the writer defaults (sorted keys, standard
 * indentation).
 */
async function writeLocaleEntryFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!existsSync(filePath)) {
    await writeLocale(filePath, data)
    return
  }

  await mutateLocale(filePath, (fileData) => {
    for (const key of Object.keys(fileData)) {
      delete fileData[key]
    }
    Object.assign(fileData, data)
  })
}

function resolveLayerDir(config: I18nConfig, layer: string): string | null {
  const dir = config.localeDirs.find(d => d.layer === layer)
  if (!dir) return null
  if (dir.aliasOf) {
    const aliasDir = config.localeDirs.find(d => d.layer === dir.aliasOf)
    if (aliasDir) return aliasDir.path
  }
  return dir.path
}

async function hasNamespacedLayout(config: I18nConfig, layer: string, format: LocaleFormat): Promise<boolean> {
  const localeDir = resolveLayerDir(config, layer)
  if (!localeDir) return false

  try {
    const entries = await readdir(localeDir)
    for (const entry of entries) {
      const subPath = join(localeDir, entry)
      try {
        if (existsSync(subPath)) {
          const subFiles = await readdir(subPath)
          if (subFiles.some(f => matchExtension(f, format.extensions))) return true
        }
      }
      catch (err) {
        if (!isAbsent(err)) log.warn(`Cannot inspect ${subPath} for a namespaced layout: ${toErrorMessage(err)}`)
      }
    }
  }
  catch (err) {
    if (!isAbsent(err)) log.warn(`Cannot inspect ${localeDir} for a namespaced layout: ${toErrorMessage(err)}`)
  }

  return false
}

/** ENOENT: the path is simply not there, which is not a failure to read it. */
function isAbsent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The extension a file name ends with, out of the ones given. */
function matchExtension(fileName: string, extensions: readonly string[]): string | undefined {
  return extensions.find(ext => fileName.toLowerCase().endsWith(ext))
}

async function resolveNamespacedEntries(localeDir: string, localeCode: string, extensions: readonly string[]): Promise<LocaleEntry[]> {
  const localePath = join(localeDir, localeCode)

  if (!existsSync(localePath)) return []

  let files: string[]
  try {
    files = await readdir(localePath)
  }
  catch (err) {
    // Anything but "not there" would come back as a locale with no keys, which
    // is what a deletion reads as "nothing to protect".
    if (!isAbsent(err)) {
      throw new FileIOError(
        `Failed to read locale directory: ${localePath}: ${toErrorMessage(err)}`,
        localePath,
      )
    }
    return []
  }

  return files
    .flatMap((f) => {
      const extension = matchExtension(f, extensions)
      return extension ? [{ file: f, extension }] : []
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, extension }) => ({
      path: join(localePath, file),
      namespace: file.slice(0, -extension.length),
    }))
}
