import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { FileIOError } from '../utils/errors.js'

/** Cache of parsed locale files: path → { data, mtime } */
const fileCache = new Map<string, { data: Record<string, unknown>; mtime: number }>()

/** Clear the entire file cache. */
export function clearFileCache(): void {
  fileCache.clear()
}

/** Clear a single entry from the file cache. */
export function clearFileCacheEntry(filePath: string): void {
  fileCache.delete(filePath)
}

/**
 * Read and parse a JSON locale file.
 * Uses an mtime-based cache to avoid re-reading unchanged files.
 */
export async function readLocaleFile(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) {
    throw new FileIOError(`File not found: ${filePath}`, filePath)
  }

  try {
    const fileStat = await stat(filePath)
    const mtime = fileStat.mtimeMs

    const cached = fileCache.get(filePath)
    if (cached && cached.mtime === mtime) {
      return structuredClone(cached.data)
    }

    const content = await readFile(filePath, 'utf-8')
    const data = JSON.parse(content) as Record<string, unknown>
    fileCache.set(filePath, { data: structuredClone(data), mtime })
    return data
  } catch (error) {
    if (error instanceof FileIOError) throw error
    if (error instanceof SyntaxError) {
      throw new FileIOError(`Invalid JSON in file: ${filePath}`, filePath)
    }
    throw new FileIOError(
      `Failed to read file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }
}

/**
 * Detect the indentation style used in a JSON file.
 * Scans the first few indented lines to find the smallest indent unit.
 * Returns the indent string (e.g., '\t', '  ', '    ').
 */
export function detectIndentation(content: string): string {
  const lines = content.split('\n', 10)
  let minSpaces = Infinity
  let usesTabs = false

  for (const line of lines) {
    const match = line.match(/^(\s+)\S/)
    if (!match) continue

    const indent = match[1]
    if (indent.includes('\t')) {
      usesTabs = true
      break
    }

    if (indent.length < minSpaces) {
      minSpaces = indent.length
    }
  }

  if (usesTabs) return '\t'
  if (minSpaces === Infinity) return '\t' // no indentation found
  return ' '.repeat(minSpaces)
}

/**
 * Read a locale file and also return the raw content for format detection.
 * This function does NOT use the cache — it always reads fresh data from disk,
 * as it returns raw content and indent info needed for writes.
 */
export async function readLocaleFileWithMeta(filePath: string): Promise<{
  data: Record<string, unknown>
  rawContent: string
  indent: string
  trailingNewline: boolean
}> {
  if (!existsSync(filePath)) {
    throw new FileIOError(`File not found: ${filePath}`, filePath)
  }

  try {
    const rawContent = await readFile(filePath, 'utf-8')
    const data = JSON.parse(rawContent) as Record<string, unknown>
    const indent = detectIndentation(rawContent)
    const trailingNewline = rawContent.endsWith('\n')

    return { data, rawContent, indent, trailingNewline }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FileIOError(`Invalid JSON in file: ${filePath}`, filePath)
    }
    throw new FileIOError(
      `Failed to read file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }
}
