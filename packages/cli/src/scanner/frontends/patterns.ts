import type { CallSite, LanguageFrontend } from './types.js'
import type { ScanPatternSet } from '../patterns.js'

/**
 * Pattern matching as a language frontend, reached only for a file a syntax
 * frontend declined.
 *
 * Regexes frame text and report call sites; what a site means is decided once,
 * in the rules, the same as for every other frontend. Binding is always
 * `ambiguous`, because a regex can never prove what a name is bound to — which
 * is the entire reason the syntax frontends exist.
 *
 * This frontend never declines: it is the floor every scan can fall back to.
 */
export function createPatternsFrontend(pat: ScanPatternSet): LanguageFrontend {
  return {
    name: 'patterns',
    handles: () => true,
    read: (content, filePath) => Promise.resolve(readPatternSites(content, filePath, pat)),
  }
}

/**
 * Synchronous core, so the sync `extractKeys` contract the scanner suites are
 * written against keeps working unchanged.
 */
export function readPatternSites(content: string, filePath: string, pat: ScanPatternSet): CallSite[] {
  const sites: CallSite[] = []
  // A pattern set whose static and dynamic regexes cover the same quote style
  // (Laravel: both read double quotes) would report one call twice; the
  // frontend reports each site once.
  const seen = new Set<string>()

  const lines = maskHtmlComments(content, filePath).split('\n')
  for (const [i, line] of lines.entries()) {
    const lineNumber = i + 1
    staticSites(line, lineNumber, pat, sites, seen)
    dynamicSites(line, lineNumber, pat, sites, seen)
    concatSites(line, lineNumber, pat, sites)
  }

  return sites
}

/**
 * Commented-out markup is not code: a `$t('a.b')` inside `<!-- -->` must not
 * count as a usage here either, or a file the SFC frontend declined gets the
 * dead keys the frontend was fixed to stop reporting. Blanked rather than cut,
 * so the line numbers this frontend reports stay the file's own.
 *
 * Scoped to .vue, where the two frontends have to agree. The same blind spot
 * in an HTML-bearing PHP template is a separate question, with that language's
 * own comment syntax to answer first.
 */
function maskHtmlComments(content: string, filePath: string): string {
  if (!filePath.endsWith('.vue')) return content
  return content.replace(/<!--[\s\S]*?-->/g, span => span.replace(/[^\n]/g, ' '))
}

function pushStatic(sites: CallSite[], seen: Set<string>, callee: string, value: string, line: number): void {
  const id = `${line}:${callee}:${value}`
  if (seen.has(id)) return
  seen.add(id)
  sites.push({ callee, binding: 'ambiguous', argument: { kind: 'static', value }, line })
}

function staticSites(line: string, lineNumber: number, pat: ScanPatternSet, sites: CallSite[], seen: Set<string>): void {
  for (const regex of pat.staticKeyPatterns) {
    regex.lastIndex = 0
    for (const match of line.matchAll(regex)) {
      const callee = match[1] ?? ''
      const key = match[3]
      if (!key) continue
      // A quoted string carrying PHP interpolation is not a static key; the
      // dynamic pattern reads it.
      if (key.includes('{$')) continue
      pushStatic(sites, seen, callee, key, lineNumber)
    }
  }
}

function dynamicSites(line: string, lineNumber: number, pat: ScanPatternSet, sites: CallSite[], seen: Set<string>): void {
  for (const regex of pat.dynamicKeyPatterns) {
    regex.lastIndex = 0
    for (const match of line.matchAll(regex)) {
      const callee = match[1] ?? ''
      const raw = match[2]
      if (!raw) continue
      const normalized = normalizeDynamicExpression(raw)
      // No interpolation is a plain string written in template syntax.
      if (normalized === undefined) {
        pushStatic(sites, seen, callee, raw, lineNumber)
        continue
      }
      sites.push({ callee, binding: 'ambiguous', argument: { kind: 'template', expression: normalized }, line: lineNumber })
    }
  }
}

function concatSites(line: string, lineNumber: number, pat: ScanPatternSet, sites: CallSite[]): void {
  for (const regex of pat.concatKeyPatterns) {
    regex.lastIndex = 0
    for (const match of line.matchAll(regex)) {
      const callee = match[1] ?? ''
      const prefix = match[3]
      if (!prefix) continue
      sites.push({ callee, binding: 'ambiguous', argument: { kind: 'concat', prefix }, line: lineNumber })
    }
  }
}

/**
 * Matches `const` declarations initialized to a key-shaped string literal
 * (>=1 dot). Scope is deliberately tight: identifier = literal only — no
 * object properties, no expressions, and no `let` (a reassigned binding
 * would substitute a stale literal and bypass the conservative widening).
 */
const CONST_KEY_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:[\w-]+\.)+[\w-]+)\2/g

/**
 * Collects same-file `const NAME = 'dotted.path'` declarations for the
 * bare-candidate net, which stays deliberately non-syntactic (#332): a
 * substituted candidate is an exact protector where an unsubstituted one
 * would be a wildcard. Usage extraction no longer consults this — the syntax
 * frontends resolve real bindings instead.
 */
export function collectConstKeyTable(content: string): Map<string, string> {
  const table = new Map<string, string>()
  const ambiguous = new Set<string>()
  CONST_KEY_DECL.lastIndex = 0
  for (const match of content.matchAll(CONST_KEY_DECL)) {
    const name = match[1]
    const value = match[3]
    if (!name || !value || ambiguous.has(name)) continue
    const existing = table.get(name)
    if (existing !== undefined && existing !== value) {
      table.delete(name)
      ambiguous.add(name)
      continue
    }
    table.set(name, value)
  }
  return table
}

/**
 * Substitutes `${NAME}` interpolations with the const table's literal value,
 * producing an exact or narrower pattern: `${i18nBase}.title` +
 * `const i18nBase = 'a.b.c'` -> `a.b.c.title`. Only plain-identifier
 * interpolations qualify; member expressions and anything else stay dynamic.
 */
export function substituteConstIdentifiers(expr: string, table: Map<string, string>): string {
  if (table.size === 0 || !expr.includes('${')) return expr
  return expr.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) => table.get(name) ?? whole)
}

/**
 * Normalizes every interpolation syntax (JS `${expr}`, PHP `{$expr}` and
 * bare `$var->prop`) to `${_}` slots. Returns undefined when the expression
 * contains no interpolation at all.
 */
function normalizeDynamicExpression(expression: string): string | undefined {
  const hasDollarBrace = expression.includes('${')
  const hasBraceDollar = expression.includes('{$')
  const hasBarePHP = !hasDollarBrace && !hasBraceDollar && /\$[a-zA-Z_]/.test(expression)
  if (!hasDollarBrace && !hasBraceDollar && !hasBarePHP) return undefined
  return hasBraceDollar
    ? expression.replace(/\{\$[^}]+\}/g, '${_}')
    : hasBarePHP
      ? expression.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*(?:->[a-zA-Z_][a-zA-Z0-9_]*)*/g, '${_}')
      : expression
}
