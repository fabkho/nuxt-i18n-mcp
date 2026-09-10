import { parse as parseYaml } from 'yaml'
import { log } from '../utils/logger.js'

/**
 * Messages an SFC defines for itself in an `<i18n>` block:
 *
 *   <i18n lang="json">{ "en": { "form": { "title": "Details" } } }</i18n>
 *
 * vue-i18n resolves these in that component, so `t('form.title')` there names a
 * key no locale file carries — reported as undefined, it sends someone looking
 * for a definition that is on the screen in front of them.
 *
 * Scoped to the file that declares them, including a `global` block: a global
 * block defines the key app-wide, and treating it as file-local only withholds
 * this file's usages from the check, which is the direction that cannot invent
 * a definition the app does not have.
 */

/** The `<i18n>` custom block, with its attributes; `<i18n-t>` is an element, not a block. */
const I18N_BLOCK = /<i18n(?=[\s>])((?:"[^"]*"|'[^']*'|[^>])*)>([\s\S]*?)<\/i18n\s*>/gi

const LANG_ATTRIBUTE = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)')/i
/** A `src` block's messages live in another file; nothing here reads it. */
const SRC_ATTRIBUTE = /\bsrc\s*=\s*(?:"|')/i

/** Matches the leaf-key walk's limit; a message table cannot loop the walk. */
const MAX_DEPTH = 200

/**
 * Every key path the file's `<i18n>` blocks define — leaves and the prefixes
 * above them, so a parent-node lookup (`tm('form')`) resolves like a leaf.
 */
export function collectLocalMessageKeys(content: string, filePath: string): Set<string> {
  const keys = new Set<string>()
  if (!filePath.endsWith('.vue') || !content.includes('<i18n')) return keys

  for (const match of content.matchAll(I18N_BLOCK)) {
    const attributes = match[1] ?? ''
    if (SRC_ATTRIBUTE.test(attributes)) continue

    const messages = readBlock(match[2] ?? '', attributes, filePath)
    if (!messages || typeof messages !== 'object') continue

    // The top level is locale codes; the paths below it are what the code asks for.
    for (const perLocale of Object.values(messages)) addPaths(perLocale, '', keys)
  }

  return keys
}

function readBlock(body: string, attributes: string, filePath: string): Record<string, unknown> | undefined {
  if (!body.trim()) return undefined
  const attribute = LANG_ATTRIBUTE.exec(attributes)
  // JSON is what a block without `lang` contains.
  const lang = (attribute?.[1] ?? attribute?.[2] ?? 'json').toLowerCase()

  try {
    const parsed: unknown = lang === 'json' ? JSON.parse(body) : parseYaml(body)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch (error) {
    log.debug(`<i18n> block in ${filePath} is not readable ${lang}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function addPaths(value: unknown, prefix: string, into: Set<string>, depth = 0): void {
  if (prefix) into.add(prefix)
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object' || Array.isArray(value)) return

  for (const [key, child] of Object.entries(value)) {
    addPaths(child, prefix ? `${prefix}.${key}` : key, into, depth + 1)
  }
}
