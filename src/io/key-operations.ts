/**
 * Get a value from a nested object using a dot-separated path.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Set a value in a nested object using a dot-separated path.
 * Creates intermediate objects as needed.
 */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/**
 * Remove a value from a nested object using a dot-separated path.
 * Cleans up empty parent objects after removal.
 * Returns true if the key was found and removed.
 */
export function removeNestedValue(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.')
  const parents: Array<{ obj: Record<string, unknown>; key: string }> = []
  let current: Record<string, unknown> = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      return false
    }
    parents.push({ obj: current, key: part })
    current = current[part] as Record<string, unknown>
  }

  const lastKey = parts[parts.length - 1]
  if (!(lastKey in current)) {
    return false
  }

  delete current[lastKey]

  // Clean up empty parent objects
  for (let i = parents.length - 1; i >= 0; i--) {
    const { obj: parentObj, key } = parents[i]
    const child = parentObj[key] as Record<string, unknown>
    if (Object.keys(child).length === 0) {
      delete parentObj[key]
    } else {
      break
    }
  }

  return true
}

/**
 * Check if a key exists in a nested object.
 */
export function hasNestedKey(obj: Record<string, unknown>, path: string): boolean {
  return getNestedValue(obj, path) !== undefined
}

/**
 * Get all leaf keys as dot-separated paths.
 * A leaf key is one whose value is not a plain object (i.e., it's a string, number, array, etc.).
 */
export function getLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const value = obj[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getLeafKeys(value as Record<string, unknown>, fullPath))
    } else {
      keys.push(fullPath)
    }
  }
  return keys
}

/**
 * Sort keys alphabetically at every nesting level (deep).
 * Returns a new object — does not mutate the input.
 */
export function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {}
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b))
  for (const key of keys) {
    const value = obj[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sorted[key] = sortKeysDeep(value as Record<string, unknown>)
    } else {
      sorted[key] = value
    }
  }
  return sorted
}

/**
 * Rename a key in a nested object. Preserves the value.
 * Returns true if the old key was found and renamed.
 */
export function renameNestedKey(
  obj: Record<string, unknown>,
  oldPath: string,
  newPath: string,
): boolean {
  const value = getNestedValue(obj, oldPath)
  if (value === undefined) {
    return false
  }
  removeNestedValue(obj, oldPath)
  setNestedValue(obj, newPath, value)
  return true
}

/**
 * Validate a translation value. Returns a warning message if problematic, null if OK.
 * This is soft validation — callers should warn but not block.
 */
export function validateTranslationValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return `Value must be a string, got ${typeof value}`
  }

  // Check for unbalanced placeholder braces
  const openBraces = (value.match(/\{/g) || []).length
  const closeBraces = (value.match(/\}/g) || []).length
  if (openBraces !== closeBraces) {
    return `Unbalanced placeholder braces: ${openBraces} opening vs ${closeBraces} closing in "${value}"`
  }

  // Check for malformed linked references
  if (value.includes('@:') && /@:\s*$/.test(value)) {
    return `Malformed linked reference: "@:" at end of string with no target`
  }

  return null
}

/**
 * Get statistics about a translation value's complexity.
 */
export function getTranslationStats(value: string): {
  placeholders: string[]
  linkedRefs: string[]
  hasPluralPipe: boolean
  hasHtml: boolean
} {
  // Extract {placeholder} tokens
  const placeholders = [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1])

  // Extract @:linked.ref references
  const linkedRefs = [...value.matchAll(/@:(?:\{'[^']+'\}|[\w.]+)/g)].map(m => m[0])

  // Check for plural pipe separator
  const hasPluralPipe = / \| /.test(value)

  // Check for HTML tags
  const hasHtml = /<\/?[a-zA-Z]/.test(value)

  return { placeholders, linkedRefs, hasPluralPipe, hasHtml }
}
