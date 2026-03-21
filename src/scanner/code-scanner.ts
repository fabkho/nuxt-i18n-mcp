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

/**
 * Matches concatenation-based dynamic keys: t('prefix.' + var), $t("key." + expr)
 * Captures the static string prefix before the `+` operator.
 *
 * Group 1: callee
 * Group 2: quote character
 * Group 3: the static prefix string
 */
const CONCAT_KEY_PATTERN = /(?<!\w)(this\.\$t|\$t|\bt)\s*\(\s*(['"])((?:(?!\2).)*)\2\s*\+/g

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

    // Concatenation-based dynamic keys: t('prefix.' + var)
    // Convert prefix to template literal format so buildDynamicKeyRegexes can handle it
    for (const match of line.matchAll(CONCAT_KEY_PATTERN)) {
      const callee = match[1]
      const prefix = match[3]
      if (!prefix) continue
      if (callee === 't' && !prefix.includes('.')) continue
      dynamicKeys.push({ expression: `\`${prefix}\${_}\``, file: filePath, line: lineNumber, callee })
    }
  }

  return { usages, dynamicKeys }
}

// ─── Dynamic key pattern matching ───────────────────────────────

/**
 * Split a template literal expression on `${...}` interpolation boundaries,
 * returning only the static literal segments. Handles nested braces inside
 * interpolations (e.g. `${fn({a:1})}`) by tracking brace depth.
 */
function splitInterpolations(expr: string): string[] {
  const parts: string[] = []
  let current = ''
  let i = 0

  while (i < expr.length) {
    if (expr[i] === '$' && expr[i + 1] === '{') {
      parts.push(current)
      current = ''
      i += 2
      let depth = 1
      while (i < expr.length && depth > 0) {
        if (expr[i] === '{') depth++
        else if (expr[i] === '}') depth--
        i++
      }
    } else {
      current += expr[i]
      i++
    }
  }

  parts.push(current)
  return parts
}

/**
 * Convert dynamic key expressions (template literals with interpolation) into
 * regex patterns that can match concrete translation keys.
 *
 * Example: `components.integrations.${type}.title` → /^components\.integrations\.[^.]+\.title$/
 */
export function buildDynamicKeyRegexes(dynamicKeys: Pick<DynamicKeyUsage, 'expression'>[]): RegExp[] {
  const seen = new Set<string>()
  const regexes: RegExp[] = []

  for (const dk of dynamicKeys) {
    // Strip outer backticks: `foo.${bar}.baz` → foo.${bar}.baz
    let expr = dk.expression
    if (expr.startsWith('`') && expr.endsWith('`')) {
      expr = expr.slice(1, -1)
    }

    // Skip expressions that don't contain interpolation
    if (!expr.includes('${')) continue

    const pattern = splitInterpolations(expr)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')

    // Deduplicate identical patterns
    if (seen.has(pattern)) continue
    seen.add(pattern)

    regexes.push(new RegExp(`^${pattern}$`))
  }

  return regexes
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
