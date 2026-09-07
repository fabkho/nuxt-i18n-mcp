/**
 * Batch planning for provider requests. A request is bounded by two things:
 * the number of keys the caller allows and the model's output token budget.
 * Counting keys alone respects only the first, so a batch of long values in a
 * script that tokenises badly overruns the budget and the response comes back
 * cut off. Planning against estimated output size keeps most batches inside it;
 * the run splits reactively for the ones the estimate gets wrong.
 */

/**
 * Fixed maxTokens budget for a translate request. Deliberately independent of
 * batch size — models simply stop when the JSON object is closed.
 */
export const TRANSLATE_MAX_TOKENS = 16384

/** Source characters one output token carries for a Latin-script response. */
export const CHARS_PER_TOKEN = 3.5

/**
 * Share of the token budget a planned batch may fill. The rest absorbs what a
 * character estimate cannot see: JSON escaping of quotes and newlines, values
 * that expand far past their script's average, and any preamble the model emits
 * before the object.
 */
export const BUDGET_UTILISATION = 0.6

/** Estimated output characters one request may produce. */
export const TRANSLATE_BUDGET_CHARS = Math.floor(TRANSLATE_MAX_TOKENS * CHARS_PER_TOKEN * BUDGET_UTILISATION)

/** Per-entry JSON scaffolding in the response: two quoted strings, colon, comma. */
export const JSON_OVERHEAD_CHARS = 8

/**
 * Token-equivalents per source character, relative to a Latin-script target.
 * Characters are not tokens: Cyrillic and Greek text costs a tokeniser two to
 * three times what the same text costs in Latin script, and CJK output is short
 * in characters while each character is its own token or worse. The factor
 * answers "what is one source character worth in the target's output budget",
 * not "how much longer does the translation read".
 */
const EXPANSION_BY_LANGUAGE: Record<string, number> = {
  // Latin script. The source is German, which is long — its translations do not
  // grow on average, so a Latin target costs what the source costs.
  en: 1.0,
  fr: 1.0,
  es: 1.0,
  it: 1.0,
  pt: 1.0,
  nl: 1.0,
  pl: 1.0,
  cs: 1.0,
  sv: 1.0,
  da: 1.0,
  nb: 1.0,
  no: 1.0,
  fi: 1.0,
  hu: 1.0,
  ro: 1.0,
  tr: 1.0,
  // Cyrillic and Greek: fewer characters per token than Latin.
  ru: 1.4,
  uk: 1.4,
  ua: 1.4,
  be: 1.4,
  bg: 1.4,
  sr: 1.4,
  mk: 1.4,
  kk: 1.4,
  el: 1.4,
  // CJK: fewer characters than the source, but expensive per character.
  ja: 1.5,
  zh: 1.5,
  ko: 1.5,
  // Right-to-left scripts, with their own tokeniser penalty.
  ar: 1.3,
  he: 1.3,
  fa: 1.3,
  ur: 1.3,
  // Thai writes without word breaks and Devanagari splits into many subword
  // tokens — the two worst cases in the table.
  th: 1.6,
  hi: 1.6,
}

/** Unlisted targets: assuming Latin would under-budget every non-Latin script. */
const DEFAULT_EXPANSION = 1.2

/** Base language subtag, the granularity of the expansion table: `pt-BR` → `pt`. */
function baseSubtag(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? ''
}

/**
 * The output-budget weight of one source character translated into this locale.
 * `code` is what a project configures; `language` is consulted when the code is
 * a project-local alias the table does not know (`ua` vs `uk-UA`).
 */
export function expansionFor(locale: { code: string, language?: string }): number {
  const byCode = EXPANSION_BY_LANGUAGE[baseSubtag(locale.code)]
  if (byCode !== undefined) return byCode
  const byLanguage = locale.language === undefined ? undefined : EXPANSION_BY_LANGUAGE[baseSubtag(locale.language)]
  return byLanguage ?? DEFAULT_EXPANSION
}

/** One key and the source value to translate, in reference-locale order. */
export type KeyEntry = [key: string, value: string]

export interface BatchPlanOptions {
  /** Hard cap on keys per request — the caller's `batchSize`. */
  maxKeys: number
  /** Estimated output characters a request may produce. */
  budgetChars: number
  /** Script weight of the target locale; 1 treats output as Latin-sized. */
  expansion?: number
}

/** Estimated output characters for one key/value pair, JSON scaffolding included. */
export function estimateOutputChars(key: string, value: string, expansion: number): number {
  return Math.ceil((key.length + value.length) * expansion) + JSON_OVERHEAD_CHARS
}

/**
 * Group entries into batches no larger than `maxKeys` keys and no heavier than
 * `budgetChars` of estimated output.
 *
 * Input order is preserved within and across batches: key accounting, progress
 * and the determinism of a run all read the result in reference-locale order.
 * An entry heavier than the whole budget still gets a batch of its own — losing
 * a key is never an option, and a request that truncates anyway is the caller's
 * to split or fail.
 */
export function planBatches(entries: readonly KeyEntry[], opts: BatchPlanOptions): KeyEntry[][] {
  const expansion = opts.expansion ?? 1
  const batches: KeyEntry[][] = []
  let current: KeyEntry[] = []
  let currentChars = 0

  for (const entry of entries) {
    const chars = estimateOutputChars(entry[0], entry[1], expansion)
    const overflows = current.length >= opts.maxKeys || currentChars + chars > opts.budgetChars
    if (current.length > 0 && overflows) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(entry)
    currentChars += chars
  }
  if (current.length > 0) batches.push(current)

  return batches
}
