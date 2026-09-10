/**
 * Placeholder and plural-variant parity between a source string and its
 * translations. Pure — no config loading, no IO, no logging — so it stays
 * cheap to call per key and easy to extend with further message-format rules.
 *
 * Two message shapes are covered. Plain interpolations (`{name}`, vue-i18n
 * `@:linked.refs` and pipe plurals, Laravel `:param`) are compared as sets per
 * plural variant. ICU MessageFormat sources (`{n, plural, …}`) are compared
 * structurally instead: their arms are language-dependent, so a set
 * comparison would report mismatches for perfectly good translations.
 */

import type { LocaleFileFormat } from '../../io/formats.js'

import type { PlaceholderValidationIssue, PlaceholderValidationResult } from '../types.js'

function extractPlaceholders(value: string, format?: LocaleFileFormat): string[] {
  const placeholders = new Set<string>()

  if (format === 'php-array') {
    for (const match of value.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      placeholders.add(`:${match[1]}`)
    }
  } else {
    for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      placeholders.add(`{${match[1]}}`)
    }
    for (const match of value.matchAll(/@:([A-Za-z0-9_.-]+)/g)) {
      placeholders.add(`@:${match[1]}`)
    }
  }

  return [...placeholders].sort()
}

/** vue-i18n plural variant separator: space-pipe-space. A bare `|` inside a
 *  word (e.g. "A|B") is NOT a plural separator. */
const PLURAL_SEPARATOR = ' | '

/** Split a vue-i18n message into plural variants. Only meaningful for the
 *  json/vue format — PHP-style messages have no pipe plurals. */
function splitPluralVariants(value: string): string[] {
  return value.split(PLURAL_SEPARATOR)
}

function diffPlaceholders(
  sourcePlaceholders: string[],
  targetValue: string,
  format?: LocaleFileFormat,
): { missing: string[], extra: string[] } {
  const sourceSet = new Set(sourcePlaceholders)
  const targetSet = new Set(extractPlaceholders(targetValue, format))
  return {
    missing: sourcePlaceholders.filter(placeholder => !targetSet.has(placeholder)),
    extra: [...targetSet].filter(placeholder => !sourceSet.has(placeholder)).sort(),
  }
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
  key: string,
  locale: string,
  source: IcuArgumentSummary,
  candidate: IcuArgumentSummary,
): PlaceholderValidationIssue | undefined {
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
      locale,
      key,
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
      locale,
      key,
      missing: [describeArm(source.name, type, '#')],
      extra: [],
      kind: 'placeholder',
    }
  }

  return undefined
}

function validateIcuSelect(
  key: string,
  locale: string,
  source: IcuArgumentSummary,
  candidate: IcuArgumentSummary,
): PlaceholderValidationIssue | undefined {
  // Select keys are values the application passes in, not language
  // categories — they must survive translation exactly.
  const missing = [...source.arms].filter(arm => !candidate.arms.has(arm)).sort()
  const extra = [...candidate.arms].filter(arm => !source.arms.has(arm)).sort()
  if (missing.length === 0 && extra.length === 0) return undefined
  return {
    locale,
    key,
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
  key: string,
  locale: string,
  source: Map<string, IcuArgumentSummary>,
  value: string,
): PlaceholderValidationIssue | undefined {
  const parsed = parseIcuMessage(value)
  if (!parsed.balanced) {
    return { locale, key, missing: [UNBALANCED_BRACES], extra: [], kind: 'placeholder' }
  }
  const candidate = summariseIcuArguments(parsed)

  const missingNames = [...source.keys()].filter(name => !candidate.has(name)).sort()
  const extraNames = [...candidate.keys()].filter(name => !source.has(name)).sort()
  if (missingNames.length > 0 || extraNames.length > 0) {
    return {
      locale,
      key,
      missing: missingNames.map(name => describeArgument(name)),
      extra: extraNames.map(name => describeArgument(name)),
      kind: 'placeholder',
    }
  }

  for (const sourceArgument of source.values()) {
    const candidateArgument = candidate.get(sourceArgument.name)
    if (!candidateArgument) continue

    if (sourceArgument.types.has('plural') || sourceArgument.types.has('selectordinal')) {
      const issue = validateIcuPlural(key, locale, sourceArgument, candidateArgument)
      if (issue) return issue
      continue
    }
    if (sourceArgument.types.has('select')) {
      const issue = validateIcuSelect(key, locale, sourceArgument, candidateArgument)
      if (issue) return issue
      continue
    }

    // `number`, `date`, `time`: the format has to survive, its style may not —
    // a target locale can prefer another date style.
    const lostTypes = [...sourceArgument.types].filter(type => type !== 'none' && !candidateArgument.types.has(type))
    if (lostTypes.length > 0) {
      return {
        locale,
        key,
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
  for (const match of value.matchAll(/@:([A-Za-z0-9_.-]+)/g)) refs.add(`@:${match[1]}`)
  return [...refs].sort()
}

function validateIcuLinkedRefs(
  key: string,
  locale: string,
  sourceRefs: string[],
  value: string,
): PlaceholderValidationIssue | undefined {
  const targetRefs = new Set(extractLinkedRefs(value))
  const missing = sourceRefs.filter(ref => !targetRefs.has(ref))
  const extra = [...targetRefs].filter(ref => !sourceRefs.includes(ref)).sort()
  if (missing.length === 0 && extra.length === 0) return undefined
  return { locale, key, missing, extra, kind: 'placeholder' }
}

export function validatePlaceholders(
  key: string,
  sourceValue: string,
  values: Array<{ locale: string, value: string }>,
  format?: LocaleFileFormat,
): PlaceholderValidationResult {
  const sourcePlaceholders = extractPlaceholders(sourceValue, format)
  const errors: PlaceholderValidationResult['errors'] = []

  // An ICU source is compared structurally instead: its `|` is literal text,
  // and its plural arms follow the target language, so neither the pipe split
  // nor the whole-value set comparison below would hold for it.
  const icuSource = icuSourceStructure(sourceValue, format)
  if (icuSource) {
    const sourceRefs = extractLinkedRefs(sourceValue)
    for (const { locale, value } of values) {
      const issue = validateIcuValue(key, locale, icuSource, value)
        ?? validateIcuLinkedRefs(key, locale, sourceRefs, value)
      if (issue) errors.push(issue)
    }
    const placeholders = [...new Set([
      ...sourcePlaceholders,
      ...[...icuSource.keys()].map(name => `{${name}}`),
    ])].sort()
    return { ok: errors.length === 0, placeholders, errors }
  }

  // Per-variant validation only applies to vue-i18n pipe plurals (json/vue
  // format). PHP arrays have no pipe plural convention.
  const sourceVariants = format === 'php-array' ? [sourceValue] : splitPluralVariants(sourceValue)
  const isPlural = sourceVariants.length > 1

  for (const { locale, value } of values) {
    if (isPlural) {
      const targetVariants = splitPluralVariants(value)
      if (targetVariants.length !== sourceVariants.length) {
        errors.push({
          locale,
          key,
          missing: [],
          extra: [],
          kind: 'plural-count',
          sourceVariants: sourceVariants.length,
          targetVariants: targetVariants.length,
        })
        continue
      }
      // Each variant's placeholder set must match its source counterpart —
      // a whole-value set comparison lets a variant drop {count} while
      // another keeps it.
      const missing = new Set<string>()
      const extra = new Set<string>()
      for (const [index, sourceVariant] of sourceVariants.entries()) {
        const targetVariant = targetVariants[index]
        if (targetVariant === undefined) continue
        const variantPlaceholders = extractPlaceholders(sourceVariant, format)
        const diff = diffPlaceholders(variantPlaceholders, targetVariant, format)
        for (const placeholder of diff.missing) missing.add(placeholder)
        for (const placeholder of diff.extra) extra.add(placeholder)
      }
      if (missing.size || extra.size) {
        errors.push({ locale, key, missing: [...missing].sort(), extra: [...extra].sort(), kind: 'placeholder' })
      }
    } else {
      const { missing, extra } = diffPlaceholders(sourcePlaceholders, value, format)
      if (missing.length || extra.length) {
        errors.push({ locale, key, missing, extra, kind: 'placeholder' })
      }
    }
  }

  return {
    ok: errors.length === 0,
    placeholders: sourcePlaceholders,
    errors,
  }
}

/** Map a validation issue to the translate fail reason it represents. */
export function failReasonForIssue(issue: PlaceholderValidationResult['errors'][number]): 'placeholder-mismatch' | 'plural-mismatch' {
  return issue.kind === 'plural-count' ? 'plural-mismatch' : 'placeholder-mismatch'
}

export function mergePlaceholderValidation(
  validations: PlaceholderValidationResult[],
): PlaceholderValidationResult | undefined {
  if (validations.length === 0) return undefined
  const placeholders = [...new Set(validations.flatMap(validation => validation.placeholders))].sort()
  const errors = validations.flatMap(validation => validation.errors)
  return { ok: errors.length === 0, placeholders, errors }
}
