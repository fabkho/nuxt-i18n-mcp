/**
 * Shared shapes only; an operation's own result lives beside it.
 *
 * A result, preview or ref type used by exactly one operation is declared in
 * the `ops-*.ts` / `translate/*.ts` module that produces it, so that reading
 * the operation shows what it answers with. What survives here is what two or
 * more of those modules speak in — a locale ref, a mutation outcome, the
 * placeholder verdict, the translation-backend callbacks — plus the config
 * types every module re-exports through this path.
 *
 * These are plain objects — no MCP content wrappers.
 */

import type { LocaleRefAmbiguity } from './shared.js'

export type { I18nConfig } from '../config/types.js'
export type { LocaleRefAmbiguity } from './shared.js'

// ─── Locale refs ─────────────────────────────────────────────────

/**
 * How a result names one locale: the canonical code plus whichever of the
 * other refs the project defines for it.
 */
export interface LocaleRefInfo {
  code: string
  language?: string
  file?: string
  name?: string
}

/**
 * A locale ref in the request that matched no known locale. Its values were
 * not written; the keys still appear in `written` because other locales
 * succeeded, so this field is the only signal the write did less than asked.
 */
export interface UnresolvedLocaleRef {
  ref: string
  /** Keys whose value for this ref was dropped. */
  keys: string[]
  /** "Did you mean …?", when a near match exists. */
  suggestion?: string
}

// ─── Placeholder validation ──────────────────────────────────────

/**
 * Which parity rule an issue came from, so a caller can filter or route them.
 * The interpolation family — `{name}`, `{0}`, `@:linked.key`, `:param` — shares
 * the single `placeholder` kind: one value mixes them freely and every one of
 * them means the same thing to a reader, "an argument the message needs".
 * Markup and printf conversions get their own kinds because a report may want
 * to treat losing `<b>` differently from losing `{count}`.
 */
export type PlaceholderIssueKind =
  | 'placeholder'
  | 'plural-count'
  | 'html-tag'
  | 'html-entity'
  | 'printf'

/** What comparing one source value with one translation of it found, with no
 *  record of which values those were — the unit a per-locale validation and a
 *  lint-style report share. */
export interface PlaceholderIssue {
  /** Tokens the source has that the translation dropped, each named. A token
   *  dropped more than once carries the count, as `<b> ×2`. */
  missing: string[]
  /** Tokens the translation has that the source does not, named the same way. */
  extra: string[]
  /** What failed: placeholder set mismatch (default) or one of the other
   *  parity rules. Optional for backwards compatibility. */
  kind?: PlaceholderIssueKind
  /** Present for kind 'plural-count': variant counts of source and target. */
  sourceVariants?: number
  targetVariants?: number
}

export interface PlaceholderValidationIssue extends PlaceholderIssue {
  locale: string
  key: string
}

export interface PlaceholderValidationResult {
  ok: boolean
  placeholders: string[]
  errors: PlaceholderValidationIssue[]
}

// ─── Mutations ───────────────────────────────────────────────────

export interface MutationPreview {
  locale: string
  key: string
  value: string
}

/** What every locale-file mutation reports, before a caller shapes it. */
export interface MutationResult {
  applied: string[]
  skipped: string[]
  warnings: string[]
  filesWritten: number
  preview?: MutationPreview[]
  placeholderValidation?: PlaceholderValidationResult
  /** Present only when a ref resolved to nothing. */
  unresolvedLocales?: UnresolvedLocaleRef[]
  /** Present only when a ref matched several locales and precedence picked one. */
  ambiguousLocales?: LocaleRefAmbiguity[]
}

// ─── Translation backend callback types ──────────────────────────

export interface TranslateRequest {
  systemPrompt: string
  userMessage: string
  maxTokens: number
}

export interface TranslateResponse {
  text: string
  model: string
  /** True when the provider stopped early (finish/stop reason = token limit).
   *  The response text is incomplete and must not be parsed as a full batch. */
  truncated?: boolean
}

export type TranslateFn = (opts: TranslateRequest) => Promise<TranslateResponse>
export type ProgressFn = (message: string) => Promise<void>
