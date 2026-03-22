import { writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FileIOError } from '../utils/errors'
import { sortKeysDeep } from './key-operations'
import { clearFileCacheEntry, readLocaleFileWithMeta } from './json-reader'

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
 * - Sorts keys alphabetically at every nesting level by default
 * - Uses atomic write (write to temp file, then rename)
 * - The \t default for indent is a fallback for new files; existing files
 *   get their indent auto-detected via mutateLocaleFile → readLocaleFileWithMeta.
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
 * This is the primary write entry point used by all tools in server.ts.
 */
/**
 * Write a diagnostic report to a JSON file.
 * - Atomic write (temp file + rename)
 * - Wraps the output with metadata (generatedAt, tool, args)
 * - Creates parent directories if needed
 * - Does NOT interact with the locale file cache
 */
export async function writeReportFile(
  filePath: string,
  output: Record<string, unknown>,
  meta: { tool: string; args: Record<string, unknown> },
): Promise<void> {
  const report = {
    generatedAt: new Date().toISOString(),
    tool: meta.tool,
    args: meta.args,
    ...output,
  }

  const content = JSON.stringify(report, null, 2) + '\n'

  try {
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = join(dirname(filePath), `.${randomUUID()}.tmp`)

    try {
      await writeFile(tmpPath, content, 'utf-8')
      await rename(tmpPath, filePath)
    } catch (error) {
      try {
        await unlink(tmpPath)
      } catch {
        // Ignore cleanup errors
      }
      throw error
    }
  } catch (error) {
    if (error instanceof FileIOError) throw error
    throw new FileIOError(
      `Failed to write report file: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    )
  }
}

export async function mutateLocaleFile(
  filePath: string,
  mutate: (data: Record<string, unknown>) => void,
): Promise<void> {
  const { data, indent, trailingNewline } = await readLocaleFileWithMeta(filePath)
  mutate(data)
  await writeLocaleFile(filePath, data, { indent, trailingNewline })
}
