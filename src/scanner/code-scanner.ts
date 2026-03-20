import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { glob } from 'tinyglobby'
import { log } from '../utils/logger.js'

// ─── Types ──────────────────────────────────────────────────────

export interface KeyUsage {
  key: string
  file: string
  line: number
  callee: string
}

export interface DynamicKeyUsage {
  expression: string
  file: string
  line: number
  callee: string
}

export interface ScanResult {
  usages: KeyUsage[]
  dynamicKeys: DynamicKeyUsage[]
  filesScanned: number
  uniqueKeys: Set<string>
}

// ─── Patterns ───────────────────────────────────────────────────

const SCAN_PATTERNS = ['**/*.vue', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.mts']

const DEFAULT_IGNORE = ['node_modules', '.nuxt', '.output', 'dist', '.git', 'coverage', '.tmp']

/**
 * Matches static i18n calls: $t('key'), t('key'), this.$t('key'), and double-quote variants.
 *
 * Group 1: callee ($t | t | this.$t)
 * Group 2: quote character
 * Group 3: the key string
 */
const STATIC_KEY_PATTERN = /(?<!\w)(this\.\$t|\$t|\bt)\s*\(\s*(['"])((?:(?!\2).)*)\2/g

/**
 * Matches dynamic i18n calls with template literals: $t(`prefix.${var}`), t(`...`), this.$t(`...`)
 *
 * Group 1: callee
 * Group 2: template literal content (without backticks)
 */
const DYNAMIC_KEY_PATTERN = /(?<!\w)(this\.\$t|\$t|\bt)\s*\(\s*`((?:[^`]|\\.)*)`/g

// ─── Extraction ─────────────────────────────────────────────────

/**
 * Extract all i18n key references from file content.
 * Returns static usages and dynamic (unresolvable) references.
 */
export function extractKeys(content: string, filePath: string): { usages: KeyUsage[]; dynamicKeys: DynamicKeyUsage[] } {
  const usages: KeyUsage[] = []
  const dynamicKeys: DynamicKeyUsage[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1

    // Static keys: $t('key'), t('key.path'), this.$t('key')
    for (const match of line.matchAll(STATIC_KEY_PATTERN)) {
      const callee = match[1]
      const key = match[3]
      if (!key) continue
      // Bare `t('word')` without a dot is likely not i18n (emit, import, etc.)
      if (callee === 't' && !key.includes('.')) continue
      usages.push({ key, file: filePath, line: lineNumber, callee })
    }

    // Dynamic keys: t(`prefix.${var}`)
    for (const match of line.matchAll(DYNAMIC_KEY_PATTERN)) {
      const expression = match[2]
      if (!expression.includes('${')) continue
      dynamicKeys.push({ expression: `\`${expression}\``, file: filePath, line: lineNumber, callee: match[1] })
    }
  }

  return { usages, dynamicKeys }
}

// ─── Scanning ───────────────────────────────────────────────────

/**
 * Scan source files in a directory for i18n key usage.
 *
 * Uses tinyglobby for file discovery, then extracts $t() / t() / this.$t()
 * references from all Vue, TS, and JS files.
 */
export async function scanSourceFiles(rootDir: string, excludeDirs?: string[]): Promise<ScanResult> {
  const ignore = [...DEFAULT_IGNORE, ...(excludeDirs ?? [])]

  let relativePaths: string[]
  try {
    relativePaths = await glob(SCAN_PATTERNS, { cwd: rootDir, ignore, dot: false, absolute: false })
  } catch {
    return { usages: [], dynamicKeys: [], filesScanned: 0, uniqueKeys: new Set() }
  }

  const allUsages: KeyUsage[] = []
  const allDynamicKeys: DynamicKeyUsage[] = []
  let filesScanned = 0

  for (const relPath of relativePaths) {
    const filePath = join(rootDir, relPath)
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      log.warn(`Failed to read file: ${filePath}`)
      continue
    }

    const { usages, dynamicKeys } = extractKeys(content, filePath)
    allUsages.push(...usages)
    allDynamicKeys.push(...dynamicKeys)
    filesScanned++
  }

  const uniqueKeys = new Set(allUsages.map(u => u.key))
  log.debug(`Scanned ${filesScanned} files, found ${uniqueKeys.size} unique keys, ${allDynamicKeys.length} dynamic references`)

  return { usages: allUsages, dynamicKeys: allDynamicKeys, filesScanned, uniqueKeys }
}

// ─── Utilities ──────────────────────────────────────────────────

export function toRelativePath(filePath: string, rootDir: string): string {
  return relative(rootDir, filePath)
}
