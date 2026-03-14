import { writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileIOError } from '../utils/errors.js'
import { sortKeysDeep } from './key-operations.js'
import { clearFileCacheEntry, detectIndentation, readLocaleFileWithMeta } from './json-reader.js'

export interface WriteOptions {
  /** Indentation string. If not provided, auto-detected from existing file. */
  indent?: string
  /** Whether to add trailing newline. Default: true. */
  trailingNewline?: boolean
  /** Whether to sort keys alphabetically at every level. Default: true. */
  sortKeys?: boolean
}

/**
 * Write a JSON object to a locale file.
 * - Preserves formatting (auto-detects indent from existing file if not specified)
 * - Sorts keys alphabetically at every nesting level by default
 * - Uses atomic write (write to temp file, then rename)
 */
export async function writeLocaleFile(
  filePath: string,
  data: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<void> {
  const {
    indent = '\t',
    trailingNewline = true,
    sortKeys = true,
  } = options

  try {
    const outputData = sortKeys ? sortKeysDeep(data) : data
    let content = JSON.stringify(outputData, null, indent)
    if (trailingNewline) {
      content += '\n'
    }

    // Atomic write: write to temp file, then rename
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = join(dirname(filePath), `.${randomUUID()}.tmp`)

    try {
      await writeFile(tmpPath, content, 'utf-8')
      await rename(tmpPath, filePath)
      clearFileCacheEntry(filePath)
    } catch (error) {
      // Clean up temp file on failure (best-effort)
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(tmpPath)
      } catch {
        // Ignore cleanup errors
      }
      throw error
    }
  } catch (error) {
    if (error instanceof FileIOError) throw error
    throw new FileIOError(
      `Failed to write file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }
}

/**
 * Read a locale file, apply a mutation function, and write it back.
 * Preserves the file's original formatting (indent style, trailing newline).
 */
export async function mutateLocaleFile(
  filePath: string,
  mutate: (data: Record<string, unknown>) => void,
): Promise<void> {
  const { data, indent, trailingNewline } = await readLocaleFileWithMeta(filePath)
  mutate(data)
  await writeLocaleFile(filePath, data, { indent, trailingNewline })
}
