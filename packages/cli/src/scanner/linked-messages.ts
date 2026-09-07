/**
 * vue-i18n linked messages: a locale *value* that names another key —
 * `"period_reference_field": "@:components.exports.form.referenceField"`.
 *
 * The link is a reference like any call site — the message table resolves it
 * when the message renders — but it lives in a locale file, so no amount of
 * source scanning can see it. Uncollected, the target of every link is an
 * orphan and `orphans --remove` deletes it.
 */

/**
 * Every spelling vue-i18n v9+ accepts: a bare dotted path, an optional
 * modifier (`@.upper:key`), and the two bracketed forms — `@:(key)` and
 * `@:{'key'}` — that let a target carry characters the bare path ends at.
 * The target is whichever group matched.
 */
const LINKED_MESSAGE = /@(?:\.[a-z]+)?:(?:\(([^)]+)\)|\{\s*['"]([^'"]+)['"]\s*\}|([A-Za-z0-9_.-]+))/g

/** Matches the leaf-key walk's limit; a self-referential object cannot loop the walk. */
const MAX_DEPTH = 200

/**
 * Add every key named by a link in `value` — a whole locale object, one of its
 * nested objects, or a single leaf — to `into`.
 *
 * Deliberately over-inclusive: a collected target that names no key protects
 * nothing, while a missed one gets a live key deleted.
 */
export function collectLinkedTargets(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH) return

  if (typeof value === 'string') {
    readLinks(value, into)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectLinkedTargets(item, into, depth + 1)
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectLinkedTargets(item, into, depth + 1)
  }
}

function readLinks(text: string, into: Set<string>): void {
  for (const [, parenthesised, listed, bare] of text.matchAll(LINKED_MESSAGE)) {
    const target = parenthesised ?? listed ?? bare
    if (!target) continue
    into.add(target)
    // "Siehe @:legal.terms." ends a sentence, not a key path: the bare form
    // swallows the period, so the path without it is protected as well.
    const withoutTrailingDots = target.replace(/\.+$/, '')
    if (withoutTrailingDots && withoutTrailingDots !== target) into.add(withoutTrailingDots)
  }
}
