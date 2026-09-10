/**
 * Placeholder and plural-variant parity between a source string and its
 * translations. Pure — no config loading, no IO, no logging — so it stays
 * cheap to call per key and easy to extend with further message-format rules.
 *
 * Two message shapes are covered. Plain messages are compared token class by
 * token class per plural variant: interpolations (`{name}`, `{0}`, vue-i18n
 * `@:linked.refs`, Laravel `:param`), HTML tags and entities, and printf
 * conversions. ICU MessageFormat sources (`{n, plural, …}`) are compared
 * structurally instead: their arms are language-dependent, so a set
 * comparison would report mismatches for perfectly good translations.
 *
 * Every rule here decides whether a translation is accepted — `translate`
 * discards a value that trips one, `write` warns about it — so a false
 * positive costs a user a translation. Where a shape cannot be told apart from
 * ordinary prose, it is deliberately not reported, and the comment on the rule
 * says which prose it was yielding to.
 */

import type { LocaleFileFormat } from '../../io/formats.js'

import type { PlaceholderIssue, PlaceholderIssueKind, PlaceholderValidationResult } from '../types.js'

/* ── Token extraction ──────────────────────────────────────────────────── */

/** vue-i18n named and list interpolation. Whitespace inside the braces is
 *  insignificant to vue-i18n, so `{ name }` is normalised to `{name}` and the
 *  two compare equal; `{0}` is a list index, a name like any other. A brace
 *  group holding anything else (`{count, plural, …}`, `{# item}`) is not an
 *  interpolation and belongs to the ICU path below. */
const CURLY_INTERPOLATION = /\{\s*([A-Za-z0-9_]+)\s*\}/g

/** vue-i18n linked message. */
const LINKED_REF = /@:([A-Za-z0-9_.-]+)/g

/**
 * Laravel-style `:param`, recognised in every format — a Laravel project keeps
 * the same convention in its JSON and YAML files as in its PHP arrays.
 *
 * A colon-prefixed word only counts as a parameter at a token boundary: the
 * colon must open the value or follow a character that is not a word
 * character, `@`, `:`, `}`, `%` or `/`. Real locale files are full of colons
 * that are not parameters — `12:30` and `HH:mm:ss`, `https://example.com`,
 * German gender forms like `Kund:innen`, the link `@:common.help`, the Swedish
 * ordinal `{n}:e`, the Finnish case suffix `{percent} %:n` — and that rule
 * excludes every one of them. A token followed by `=` is a Vue binding
 * (`:href="…"`) pasted into a value, never a parameter.
 */
const LARAVEL_PARAM = /(?<![A-Za-z0-9_@:}%/]):([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]*=)/g

/** A well-formed HTML tag. Attributes are matched but not captured: an `href`
 *  may legitimately point at a localised page, while the tag around it may not
 *  disappear. A name has to start directly after the bracket, which is what
 *  keeps prose out — `< 1 minute` and `a < b` are text, not markup. */
const HTML_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?\/?>/g

/** A well-formed HTML entity, named or numeric. It has to be terminated by
 *  `;`, so a bare `&` in prose is not one — and a translation that turns
 *  `&amp;` into `&` is reported as having lost the `&amp;`. */
const HTML_ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g

/** printf conversions as gettext and PHP UI strings write them: `%s`, `%d`
 *  and the positional `%1$s`. The set stops there on purpose — `%f`, `%i` and
 *  `%u` are not distinguishable from a prose percentage (`100%ige
 *  Rückerstattung`) often enough to be worth a lost translation, and the same
 *  reasoning bars a conversion that continues into a word. */
const PRINTF_CONVERSION = /%(?:[0-9]+\$)?[sd](?![A-Za-z])/g

function extractPlaceholders(value: string, format?: LocaleFileFormat): string[] {
  const placeholders = new Set<string>()

  // Braces and links are vue-i18n conventions; in a PHP array file they are
  // literal text, and `:param` is the only interpolation Laravel resolves.
  if (format !== 'php-array') {
    for (const match of value.matchAll(CURLY_INTERPOLATION)) placeholders.add(`{${match[1]}}`)
    for (const match of value.matchAll(LINKED_REF)) placeholders.add(`@:${match[1]}`)
  }
  for (const match of value.matchAll(LARAVEL_PARAM)) placeholders.add(`:${match[1]}`)

  return [...placeholders].sort()
}

/** Tag names are case-insensitive in HTML, so `<BR>` and `<br>` are one tag
 *  and a translation may not be failed for changing the case of one. */
function extractHtmlTags(value: string): string[] {
  return [...value.matchAll(HTML_TAG)].map(match => `<${match[1] ?? ''}${(match[2] ?? '').toLowerCase()}>`)
}

function extractHtmlEntities(value: string): string[] {
  return [...value.matchAll(HTML_ENTITY)].map(match => `&${match[1]};`)
}

function extractPrintfConversions(value: string): string[] {
  return [...value.matchAll(PRINTF_CONVERSION)].map(match => match[0])
}

/* ── Plural variants ───────────────────────────────────────────────────── */

/**
 * Split a vue-i18n message into plural variants. vue-i18n's compiler splits on
 * a bare `|` wherever it stands, so `Tag|Tage` is two variants and `a |b` is
 * two as well: the space around the pipe is presentation, which is why the
 * variants are trimmed before anything is read out of them.
 *
 * A value meaning to show a literal pipe is therefore read as a plural here —
 * but vue-i18n reads it that way too and renders only the first segment, so
 * the value is already broken and no shape is exempted from the split.
 */
function splitPluralVariants(value: string): string[] {
  return value.split('|').map(variant => variant.trim())
}

/** PHP array messages have no pipe plural convention — their `|` is text. */
function splitVariants(value: string, format?: LocaleFileFormat): string[] {
  return format === 'php-array' ? [value] : splitPluralVariants(value)
}

/* ── Token classes ─────────────────────────────────────────────────────── */

interface TokenClass {
  kind: PlaceholderIssueKind
  extract: (value: string, format?: LocaleFileFormat) => string[]
}

/** One entry per class of token, each reported under its own issue kind.
 *  `extractPlaceholders` deduplicates before counting, so interpolations keep
 *  their set semantics — repeating `{name}` where the source used it once is
 *  idiomatic. The other classes are compared as multisets: losing one of two
 *  `<b>` leaves markup that no longer closes. */
const TOKEN_CLASSES: readonly TokenClass[] = [
  { kind: 'placeholder', extract: extractPlaceholders },
  { kind: 'html-tag', extract: extractHtmlTags },
  { kind: 'html-entity', extract: extractHtmlEntities },
  { kind: 'printf', extract: extractPrintfConversions },
]

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function addCounts(into: Map<string, number>, from: Map<string, number>): void {
  for (const [token, count] of from) into.set(token, (into.get(token) ?? 0) + count)
}

function diffTokenCounts(
  source: Map<string, number>,
  target: Map<string, number>,
): { missing: Map<string, number>, extra: Map<string, number> } {
  const missing = new Map<string, number>()
  const extra = new Map<string, number>()
  for (const [token, count] of source) {
    const deficit = count - (target.get(token) ?? 0)
    if (deficit > 0) missing.set(token, deficit)
  }
  for (const [token, count] of target) {
    const surplus = count - (source.get(token) ?? 0)
    if (surplus > 0) extra.set(token, surplus)
  }
  return { missing, extra }
}

/** Names every token, because a caller turns these into a corrective
 *  instruction and a bare count is not actionable. `×N` appears only where the
 *  same token is off by more than one. */
function describeTokenCounts(counts: Map<string, number>): string[] {
  return [...counts].map(([token, count]) => (count > 1 ? `${token} ×${count}` : token)).sort()
}

/* ── ICU MessageFormat ─────────────────────────────────────────────────── */

type IcuArgumentType = 'plural' | 'selectordinal' | 'select' | 'number' | 'date' | 'time' | 'none'

const ICU_ARGUMENT_TYPES: readonly string[] = ['plural', 'selectordinal', 'select', 'number', 'date', 'time']

/** Cheap pre-check before parsing: only a *typed* argument makes a message
 *  ICU. A plain `{name}` string keeps the set-comparison fast path, so results
 *  for vue-i18n and Laravel projects are unchanged. */
const ICU_TYPED_ARGUMENT = /\{\s*[A-Za-z0-9_$]+\s*,\s*(?:plural|selectordinal|select|number|date|time)\s*[,}]/

/** Reported instead of a placeholder list when the candidate cannot be parsed
 *  at all — the CLI renders `missing` into the warning line. */
const UNBALANCED_BRACES = 'unbalanced ICU braces'

interface IcuArgument {
  name: string
  type: IcuArgumentType
  /** Arm keys of a plural/selectordinal/select argument: `one`, `=0`, `male`. */
  arms: string[]
  /** Some arm interpolates the plural number, as `#` or as `{name}`. */
  usesNumber: boolean
}

interface IcuMessage {
  /** Every argument of the message, at every nesting level, in source order. */
  args: IcuArgument[]
  /** False when a brace, an arm or an argument was left open. */
  balanced: boolean
}

function isChoiceType(type: IcuArgumentType): boolean {
  return type === 'plural' || type === 'selectordinal' || type === 'select'
}

/**
 * Structure-only scan of an ICU message: which arguments it declares, of which
 * type, and which arms a plural/select offers. Nothing is evaluated and no
 * message is rebuilt — this only has to be precise enough to compare two
 * messages, so an argument style it does not know is skipped, not interpreted.
 */
function parseIcuMessage(input: string): IcuMessage {
  const args: IcuArgument[] = []
  let pos = 0
  let balanced = true

  function charAt(index: number): string | undefined {
    return input[index]
  }

  function skipSpace(): void {
    while (pos < input.length && /\s/.test(input[pos] ?? '')) pos += 1
  }

  /** Consume an apostrophe run. `''` is a literal quote; `'` before `{`, `}`
   *  or `#` opens a span ICU treats as plain text; every other apostrophe is
   *  itself literal, which is why "It's" needs no escaping. */
  function skipApostrophe(): void {
    const next = charAt(pos + 1)
    if (next === '\'') {
      pos += 2
      return
    }
    if (next !== '{' && next !== '}' && next !== '#') {
      pos += 1
      return
    }
    pos += 2
    while (pos < input.length) {
      if (charAt(pos) === '\'') {
        // `''` inside a quoted span is an escaped quote, not the end of it.
        if (charAt(pos + 1) === '\'') {
          pos += 2
          continue
        }
        pos += 1
        return
      }
      pos += 1
    }
    // An unterminated span runs to the end of the message — still text.
  }

  /** Read an argument name or type up to its delimiter. */
  function readToken(): string {
    const start = pos
    while (pos < input.length) {
      const char = charAt(pos)
      if (char === ',' || char === '}' || char === '{') break
      pos += 1
    }
    return input.slice(start, pos).trim()
  }

  /** Skip a style this parser does not interpret (`number`, `date`, custom)
   *  up to the `}` that closes its argument. */
  function skipArgumentStyle(): void {
    let depth = 0
    while (pos < input.length) {
      const char = charAt(pos)
      if (char === '\'') {
        skipApostrophe()
        continue
      }
      if (char === '{') depth += 1
      if (char === '}') {
        if (depth === 0) {
          pos += 1
          return
        }
        depth -= 1
      }
      pos += 1
    }
    balanced = false
  }

  function parseArms(argument: IcuArgument): void {
    skipSpace()
    while (pos < input.length && charAt(pos) !== '}') {
      const keyStart = pos
      while (pos < input.length && !/[\s{}]/.test(input[pos] ?? '')) pos += 1
      const key = input.slice(keyStart, pos)
      skipSpace()
      if (charAt(pos) !== '{') {
        // `offset:1` is a plural parameter, not an arm — it has no body.
        if (key.startsWith('offset:')) continue
        balanced = false
        return
      }
      if (key === '') {
        balanced = false
        return
      }
      pos += 1
      const nestedFrom = args.length
      const sawHash = scanText(true)
      if (pos >= input.length) return // scanText already flagged the open arm
      pos += 1 // the arm's `}`
      argument.arms.push(key)
      // `#` and an explicit `{count}` are the same interpolation to a reader,
      // and a translation may legitimately swap one for the other.
      const referencesItself = args
        .slice(nestedFrom)
        .some(nested => nested.name === argument.name && nested.type === 'none')
      if (sawHash || referencesItself) argument.usesNumber = true
      skipSpace()
    }
    if (pos < input.length) pos += 1 // the argument's `}`
    else balanced = false
  }

  /** Parse one argument; `pos` sits just after its opening `{`. */
  function parseArgument(): void {
    skipSpace()
    const name = readToken()
    const afterName = charAt(pos)
    if (afterName === undefined || afterName === '{') {
      balanced = false
      return
    }
    if (afterName === '}') {
      pos += 1
      args.push({ name, type: 'none', arms: [], usesNumber: false })
      return
    }

    pos += 1 // the `,` after the name
    skipSpace()
    const rawType = readToken().toLowerCase()
    const type = ICU_ARGUMENT_TYPES.includes(rawType) ? rawType as IcuArgumentType : 'none'
    const argument: IcuArgument = { name, type, arms: [], usesNumber: false }
    args.push(argument)

    if (isChoiceType(type)) {
      if (charAt(pos) === ',') {
        pos += 1
        parseArms(argument)
        return
      }
      if (charAt(pos) === '}') {
        pos += 1 // `{n, plural}` — no arms at all, caught by the parity rules
        return
      }
      balanced = false
      return
    }
    skipArgumentStyle()
  }

  /** Scan message text to the end of the input or to an unconsumed `}`.
   *  Returns whether a literal `#` appeared at this level. */
  function scanText(insideArm: boolean): boolean {
    let sawHash = false
    while (pos < input.length) {
      const char = charAt(pos)
      if (char === '\'') {
        skipApostrophe()
        continue
      }
      if (char === '}') {
        if (insideArm) return sawHash
        balanced = false // a `}` with no argument open
        pos += 1
        continue
      }
      if (char === '{') {
        pos += 1
        parseArgument()
        continue
      }
      // `#` only interpolates inside a plural arm; anywhere else it is text.
      if (char === '#') sawHash = true
      pos += 1
    }
    if (insideArm) balanced = false // the arm was never closed
    return sawHash
  }

  scanText(false)
  return { args, balanced }
}

interface IcuArgumentSummary {
  name: string
  types: Set<IcuArgumentType>
  arms: Set<string>
  usesNumber: boolean
}

/**
 * Merge the repeated mentions of one argument name. A `{gender, select, …}`
 * nested in a plural appears once per arm, and a bare `{count}` inside a
 * plural arm is the same argument as the plural that encloses it.
 */
function summariseIcuArguments(message: IcuMessage): Map<string, IcuArgumentSummary> {
  const byName = new Map<string, IcuArgumentSummary>()
  for (const argument of message.args) {
    let summary = byName.get(argument.name)
    if (!summary) {
      summary = { name: argument.name, types: new Set(), arms: new Set(), usesNumber: false }
      byName.set(argument.name, summary)
    }
    summary.types.add(argument.type)
    for (const arm of argument.arms) summary.arms.add(arm)
    if (argument.usesNumber) summary.usesNumber = true
  }
  // A typed mention wins over a bare reference to the same argument.
  for (const summary of byName.values()) {
    if (summary.types.size > 1) summary.types.delete('none')
  }
  return byName
}

/** The ICU structure of a source value, or undefined when the source is not
 *  ICU (or is too broken to compare against) and the fast path applies. */
function icuSourceStructure(value: string, format?: LocaleFileFormat): Map<string, IcuArgumentSummary> | undefined {
  // Laravel messages use `:param` and have no ICU convention.
  if (format === 'php-array') return undefined
  if (!ICU_TYPED_ARGUMENT.test(value)) return undefined
  const message = parseIcuMessage(value)
  // A source we cannot parse would turn every translation into a failure.
  if (!message.balanced) return undefined
  if (!message.args.some(argument => argument.type !== 'none')) return undefined
  return summariseIcuArguments(message)
}

function describeArgument(name: string, type?: IcuArgumentType): string {
  return type === undefined || type === 'none' ? `{${name}}` : `{${name}, ${type}}`
}

function describeArm(name: string, type: IcuArgumentType, arm: string): string {
  return `{${name}, ${type}, ${arm}}`
}

function pluralTypeOf(summary: IcuArgumentSummary): IcuArgumentType {
  return summary.types.has('selectordinal') ? 'selectordinal' : 'plural'
}

function validateIcuPlural(
  source: IcuArgumentSummary,
  candidate: IcuArgumentSummary,
): PlaceholderIssue | undefined {
  const type = pluralTypeOf(source)
  const missing: string[] = []

  // `other` is the only arm every language must have; the CLDR categories
  // (zero one two few many) are a property of the target language, so English
  // `one|other` becoming Polish `one|few|many|other` is correct, not a loss.
  if (!candidate.arms.has('other')) missing.push(describeArm(source.name, type, 'other'))
  // `=N` arms are exact-value matches, not categories — dropping one changes
  // the message for that value in every language.
  for (const arm of [...source.arms].sort()) {
    if (arm.startsWith('=') && !candidate.arms.has(arm)) missing.push(describeArm(source.name, type, arm))
  }

  if (missing.length > 0) {
    return {
      missing,
      extra: [],
      kind: 'plural-count',
      sourceVariants: source.arms.size,
      targetVariants: candidate.arms.size,
    }
  }

  // Losing the number itself leaves "items" where "3 items" was meant.
  if (source.usesNumber && !candidate.usesNumber) {
    return {
      missing: [describeArm(source.name, type, '#')],
      extra: [],
      kind: 'placeholder',
    }
  }

  return undefined
}

function validateIcuSelect(
  source: IcuArgumentSummary,
  candidate: IcuArgumentSummary,
): PlaceholderIssue | undefined {
  // Select keys are values the application passes in, not language
  // categories — they must survive translation exactly.
  const missing = [...source.arms].filter(arm => !candidate.arms.has(arm)).sort()
  const extra = [...candidate.arms].filter(arm => !source.arms.has(arm)).sort()
  if (missing.length === 0 && extra.length === 0) return undefined
  return {
    missing: missing.map(arm => describeArm(source.name, 'select', arm)),
    extra: extra.map(arm => describeArm(source.name, 'select', arm)),
    kind: 'plural-count',
    sourceVariants: source.arms.size,
    targetVariants: candidate.arms.size,
  }
}

/** Compare one candidate translation with the ICU structure of its source.
 *  Returns the first issue found — the reason codes are the same closed set
 *  the plain path uses, so the detail travels in `missing`/`extra`. */
function validateIcuValue(
  source: Map<string, IcuArgumentSummary>,
  value: string,
): PlaceholderIssue | undefined {
  const parsed = parseIcuMessage(value)
  if (!parsed.balanced) {
    return { missing: [UNBALANCED_BRACES], extra: [], kind: 'placeholder' }
  }
  const candidate = summariseIcuArguments(parsed)

  const missingNames = [...source.keys()].filter(name => !candidate.has(name)).sort()
  const extraNames = [...candidate.keys()].filter(name => !source.has(name)).sort()
  if (missingNames.length > 0 || extraNames.length > 0) {
    return {
      missing: missingNames.map(name => describeArgument(name)),
      extra: extraNames.map(name => describeArgument(name)),
      kind: 'placeholder',
    }
  }

  for (const sourceArgument of source.values()) {
    const candidateArgument = candidate.get(sourceArgument.name)
    if (!candidateArgument) continue

    if (sourceArgument.types.has('plural') || sourceArgument.types.has('selectordinal')) {
      const issue = validateIcuPlural(sourceArgument, candidateArgument)
      if (issue) return issue
      continue
    }
    if (sourceArgument.types.has('select')) {
      const issue = validateIcuSelect(sourceArgument, candidateArgument)
      if (issue) return issue
      continue
    }

    // `number`, `date`, `time`: the format has to survive, its style may not —
    // a target locale can prefer another date style.
    const lostTypes = [...sourceArgument.types].filter(type => type !== 'none' && !candidateArgument.types.has(type))
    if (lostTypes.length > 0) {
      return {
        missing: lostTypes.map(type => describeArgument(sourceArgument.name, type)).sort(),
        extra: [...candidateArgument.types].map(type => describeArgument(sourceArgument.name, type)).sort(),
        kind: 'placeholder',
      }
    }
  }

  return undefined
}

/** vue-i18n linked messages. ICU knows nothing about them, but a project can
 *  mix both, so they stay checked on the ICU path too. */
function extractLinkedRefs(value: string): string[] {
  const refs = new Set<string>()
  for (const match of value.matchAll(LINKED_REF)) refs.add(`@:${match[1]}`)
  return [...refs].sort()
}

function validateIcuLinkedRefs(
  sourceRefs: string[],
  value: string,
): PlaceholderIssue | undefined {
  const targetRefs = new Set(extractLinkedRefs(value))
  const missing = sourceRefs.filter(ref => !targetRefs.has(ref))
  const extra = [...targetRefs].filter(ref => !sourceRefs.includes(ref)).sort()
  if (missing.length === 0 && extra.length === 0) return undefined
  return { missing, extra, kind: 'placeholder' }
}

/* ── Public comparison ─────────────────────────────────────────────────── */

/**
 * Compare one source value with one translation of it. Knows nothing about
 * keys, locales or files, so a per-locale validation, a batch translate run
 * and a lint report can all build on the same answer.
 *
 * Returns one issue per token class that differs, so a caller can act on the
 * markup finding and the interpolation finding separately. Empty means the
 * translation carries everything the source declared.
 */
export function comparePlaceholders(
  sourceValue: string,
  targetValue: string,
  format?: LocaleFileFormat,
): PlaceholderIssue[] {
  // An ICU source is compared structurally instead: its `|` is literal text,
  // and its plural arms follow the target language, so neither the pipe split
  // nor the token comparison below would hold for it.
  const icuSource = icuSourceStructure(sourceValue, format)
  if (icuSource) {
    const issue = validateIcuValue(icuSource, targetValue)
      ?? validateIcuLinkedRefs(extractLinkedRefs(sourceValue), targetValue)
    return issue ? [issue] : []
  }

  const sourceVariants = splitVariants(sourceValue, format)
  // Arity is a rule only where the source itself declares variants. A target
  // that pluralises a source that does not is legitimate — Croatian needs a
  // form German has no use for, and vue-i18n picks it from the count the call
  // site passes — so those two values are compared whole instead.
  const targetVariants = sourceVariants.length > 1 ? splitVariants(targetValue, format) : [targetValue]
  if (sourceVariants.length !== targetVariants.length) {
    // Reported alone: with the variants misaligned, comparing them pairwise
    // would report the same shift again as invented and dropped placeholders.
    return [{
      missing: [],
      extra: [],
      kind: 'plural-count',
      sourceVariants: sourceVariants.length,
      targetVariants: targetVariants.length,
    }]
  }

  const issues: PlaceholderIssue[] = []
  for (const tokenClass of TOKEN_CLASSES) {
    const missing = new Map<string, number>()
    const extra = new Map<string, number>()
    // Per variant, not per value: a whole-value comparison lets one variant
    // drop `{count}` while another keeps it.
    for (const [index, sourceVariant] of sourceVariants.entries()) {
      const targetVariant = targetVariants[index]
      if (targetVariant === undefined) continue
      const diff = diffTokenCounts(
        countTokens(tokenClass.extract(sourceVariant, format)),
        countTokens(tokenClass.extract(targetVariant, format)),
      )
      addCounts(missing, diff.missing)
      addCounts(extra, diff.extra)
    }
    if (missing.size > 0 || extra.size > 0) {
      issues.push({
        missing: describeTokenCounts(missing),
        extra: describeTokenCounts(extra),
        kind: tokenClass.kind,
      })
    }
  }
  return issues
}

/** What the source declares, for a caller that reports or prompts with it.
 *  ICU argument names join the list because an ICU source's `{name}` never
 *  reaches the plain extractor. */
function sourcePlaceholderNames(sourceValue: string, format?: LocaleFileFormat): string[] {
  const placeholders = extractPlaceholders(sourceValue, format)
  const icuSource = icuSourceStructure(sourceValue, format)
  if (!icuSource) return placeholders
  return [...new Set([...placeholders, ...[...icuSource.keys()].map(name => `{${name}}`)])].sort()
}

export function validatePlaceholders(
  key: string,
  sourceValue: string,
  values: Array<{ locale: string, value: string }>,
  format?: LocaleFileFormat,
): PlaceholderValidationResult {
  const errors: PlaceholderValidationResult['errors'] = []
  for (const { locale, value } of values) {
    for (const issue of comparePlaceholders(sourceValue, value, format)) {
      errors.push({ locale, key, ...issue })
    }
  }

  return {
    ok: errors.length === 0,
    placeholders: sourcePlaceholderNames(sourceValue, format),
    errors,
  }
}

/** Map a validation issue to the translate fail reason it represents. Only
 *  plural arity has its own reason; every other class is a lost or invented
 *  token, which is what `placeholder-mismatch` means to a caller. */
export function failReasonForIssue(issue: PlaceholderIssue): 'placeholder-mismatch' | 'plural-mismatch' {
  return issue.kind === 'plural-count' ? 'plural-mismatch' : 'placeholder-mismatch'
}

const ISSUE_SUBJECT: Record<PlaceholderIssueKind, string> = {
  'placeholder': 'placeholder',
  'plural-count': 'plural variant',
  'html-tag': 'HTML tag',
  'html-entity': 'HTML entity',
  'printf': 'printf conversion',
}

/** One line naming what an issue found, for a warning list or a corrective
 *  instruction back to a model. */
export function describePlaceholderIssue(issue: PlaceholderIssue): string {
  if (issue.kind === 'plural-count') {
    return `plural variant count mismatch; expected ${issue.sourceVariants}, got ${issue.targetVariants}`
  }
  const subject = ISSUE_SUBJECT[issue.kind ?? 'placeholder']
  return `${subject} mismatch; missing: ${issue.missing.join(', ') || '-'}; extra: ${issue.extra.join(', ') || '-'}`
}

export function mergePlaceholderValidation(
  validations: PlaceholderValidationResult[],
): PlaceholderValidationResult | undefined {
  if (validations.length === 0) return undefined
  const placeholders = [...new Set(validations.flatMap(validation => validation.placeholders))].sort()
  const errors = validations.flatMap(validation => validation.errors)
  return { ok: errors.length === 0, placeholders, errors }
}
