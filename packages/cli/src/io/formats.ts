/**
 * One registry for everything that differs between locale file formats.
 *
 * The readers and writers used to be reachable only through
 * `if (format === 'php-array')` branches scattered across locale IO, format
 * detection, the read operations and the scaffolder, so every new format meant
 * finding all of them again. A format now declares its extensions, its IO
 * functions and the two layout facts those callers used the format id to
 * guess, and they dispatch through `getFormat` / `formatForFile` instead of
 * comparing strings.
 */

import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ConfigError, FileIOError, toErrorMessage } from '../utils/errors.js'
import { log } from '../utils/logger.js'

import { readLocaleFile, clearFileCache, clearFileCacheEntry } from './json-reader.js'
import { writeLocaleFile, mutateLocaleFile } from './json-writer.js'
import { readPhpLocaleFile, clearPhpFileCache, clearPhpFileCacheEntry } from './php-reader.js'
import { writePhpLocaleFile, mutatePhpLocaleFile } from './php-writer.js'
import { readYamlLocaleFile, clearYamlFileCache, clearYamlFileCacheEntry } from './yaml-reader.js'
import { writeYamlLocaleFile, mutateYamlLocaleFile } from './yaml-writer.js'

/**
 * The locale file formats this registry can read and write. An adapter names
 * one, a project config may override it, and the scanner picks its pattern set
 * from it — but what the id means is the registry entry below.
 */
export type LocaleFileFormat = 'json' | 'php-array' | 'yaml'

/**
 * Write options every format understands. Per-format style (indentation,
 * quote style) is detected from the file being written, not passed in.
 */
export interface LocaleWriteOptions {
  sortKeys?: boolean
}

/**
 * How a layer directory is laid out when there is nothing on disk to observe.
 * 'namespaced' is Laravel's directory-per-locale with one file per namespace;
 * 'flat' is one file per locale. Layouts are read off disk wherever files
 * already exist — this is only the fallback for a layer that has none.
 */
export type LocaleLayout = 'flat' | 'namespaced'

export interface LocaleFormat {
  readonly id: LocaleFileFormat
  /** Recognized extensions, canonical one first — the one new files get. */
  readonly extensions: readonly string[]
  readonly defaultLayout: LocaleLayout
  /**
   * Whether a flat layout is discovered from disk rather than declared. A PHP
   * project may be namespaced or flat and only the directory says which, so
   * the flat file is guessed as `<localeCode><ext>` and confirmed to exist.
   * The adapters that resolve JSON always name the file instead, and it counts
   * even before it exists — that is what scaffolding a new locale writes.
   */
  readonly flatFileFromDisk: boolean
  read(filePath: string): Promise<Record<string, unknown>>
  write(filePath: string, data: Record<string, unknown>, options?: LocaleWriteOptions): Promise<void>
  /** Read, mutate and write back, preserving on-disk style and key order. */
  mutate(filePath: string, mutate: (data: Record<string, unknown>) => void): Promise<void>
  clearCache(): void
  clearCacheEntry(filePath: string): void
}

const formats = new Map<LocaleFileFormat, LocaleFormat>()
const byExtension = new Map<string, LocaleFormat>()

export function registerFormat(format: LocaleFormat): void {
  formats.set(format.id, format)
  for (const extension of format.extensions) {
    byExtension.set(extension.toLowerCase(), format)
  }
}

/**
 * The format a config's `localeFileFormat` names. Undefined resolves to JSON,
 * which is what an adapter that declares nothing has always meant.
 */
export function getFormat(id: LocaleFileFormat | undefined): LocaleFormat {
  const format = formats.get(id ?? 'json')
  if (!format) {
    throw new ConfigError(
      `Unknown locale file format: ${id}. Known formats: ${[...formats.keys()].join(', ')}`,
    )
  }
  return format
}

/** The format that owns a file's extension. */
export function formatForFile(filePath: string): LocaleFormat {
  const ext = extname(filePath).toLowerCase()
  const format = byExtension.get(ext)
  if (!format) {
    throw new FileIOError(`Unsupported locale file format: ${ext}`, filePath)
  }
  return format
}

export function listFormats(): LocaleFormat[] {
  return [...formats.values()]
}

/**
 * Guess the format of a locale directory from the files in it — flat
 * `en.json` / `en.php` / `en.yaml` first, then a directory per locale. Returns
 * null when nothing recognizable is there, leaving the default to the caller. A
 * directory holding more than one format resolves to whichever has the most
 * files and warns, because the format that loses is invisible from then on.
 */
export async function detectFormatInDir(localeDir: string): Promise<LocaleFileFormat | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(localeDir, { withFileTypes: true })
  }
  catch (error) {
    log.debug(`Cannot list ${localeDir} to detect its locale file format: ${toErrorMessage(error)}`)
    return null
  }

  // Flat files: en.json, de.json, en.yaml — or en.php, de.php for a PHP
  // project that does not use Laravel's directory-per-locale layout.
  const flat = decide(countFormats(entries.filter(e => e.isFile()).map(e => e.name)), localeDir)
  if (flat) return flat

  // Directory-per-locale: en/, de/ — check contents.
  const nested = new Map<LocaleFileFormat, number>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const subFiles = await readdir(join(localeDir, entry.name)).catch(() => [] as string[])
    for (const [id, count] of countFormats(subFiles)) {
      nested.set(id, (nested.get(id) ?? 0) + count)
    }
  }
  return decide(nested, localeDir)
}

function countFormats(fileNames: string[]): Map<LocaleFileFormat, number> {
  const counts = new Map<LocaleFileFormat, number>()
  for (const name of fileNames) {
    const format = byExtension.get(extname(name).toLowerCase())
    if (!format) continue
    counts.set(format.id, (counts.get(format.id) ?? 0) + 1)
  }
  return counts
}

function decide(counts: Map<LocaleFileFormat, number>, localeDir: string): LocaleFileFormat | null {
  let winner: LocaleFileFormat | null = null
  let best = 0
  // Walked in registration order, so an exact tie always resolves the same way.
  for (const id of formats.keys()) {
    const count = counts.get(id) ?? 0
    if (count > best) {
      winner = id
      best = count
    }
  }
  if (!winner) return null

  if (counts.size > 1) {
    const seen = [...counts.entries()].map(([id, count]) => `${id} (${count})`).join(', ')
    log.warn(
      `Locale directory ${localeDir} mixes file formats: ${seen}. Reading and writing it as `
      + `'${winner}' — files in the other formats are ignored. Keep one format per locale directory.`,
    )
  }

  return winner
}

// Registration order is the tie-break order in `decide`: JSON first keeps a
// mixed directory resolving the way it did before the files were counted.
registerFormat({
  id: 'json',
  extensions: ['.json'],
  defaultLayout: 'flat',
  flatFileFromDisk: false,
  read: readLocaleFile,
  write: (filePath, data, options) => writeLocaleFile(filePath, data, options),
  mutate: mutateLocaleFile,
  clearCache: clearFileCache,
  clearCacheEntry: clearFileCacheEntry,
})

registerFormat({
  id: 'php-array',
  extensions: ['.php'],
  defaultLayout: 'namespaced',
  flatFileFromDisk: true,
  read: readPhpLocaleFile,
  write: (filePath, data, options) => writePhpLocaleFile(filePath, data, options),
  mutate: mutatePhpLocaleFile,
  clearCache: clearPhpFileCache,
  clearCacheEntry: clearPhpFileCacheEntry,
})

// Rails, Symfony and vue-i18n all read `.yaml`; `.yml` is the same format
// under the extension half of them actually use.
registerFormat({
  id: 'yaml',
  extensions: ['.yaml', '.yml'],
  defaultLayout: 'flat',
  flatFileFromDisk: false,
  read: readYamlLocaleFile,
  write: (filePath, data, options) => writeYamlLocaleFile(filePath, data, options),
  mutate: mutateYamlLocaleFile,
  clearCache: clearYamlFileCache,
  clearCacheEntry: clearYamlFileCacheEntry,
})
