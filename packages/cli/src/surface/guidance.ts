/**
 * The next step a result implies, in the words of the surface that asked for it.
 *
 * This is the caller's prose, not the operation's: a terminal is told to pass
 * `--provider`, a host is told to translate the fallback contexts inline and
 * write them back. Both live here, side by side, because they describe the same
 * state — as two texts in two packages they said different things about it, and
 * the all-layers case was covered on one surface only.
 *
 * The step follows from what the run found, never from what it was asked, so
 * everything below reads the result alone — the one thing both surfaces hold.
 */

import type {
  TranslateKeyResult,
  TranslateMissingOutcome,
  TranslateMissingResult,
} from '../core/translate/run.js'
import type { Surface } from './types.js'

const NO_PROVIDER_CLI = 'No provider configured — nothing was translated. Pass --provider and --model '
  + '(API key via --apiKey or the OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY env vars) '
  + 'to translate automatically.'

const AGENT_MODE_MCP = 'Agent mode — no provider configured on the server. Use the fallbackContexts to translate '
  + 'inline, then call write_translations (mode: "upsert") to write the results. To enable '
  + 'provider mode, set I18N_PROVIDER, I18N_MODEL, and the provider API key env on the server process.'

const AGENT_MODE_KEY_MCP = 'Agent mode — no provider configured on the server. Use the fallbackContext to '
  + 'translate inline, then call write_translations (mode: "upsert") to write the results. To enable '
  + 'provider mode, set I18N_PROVIDER, I18N_MODEL, and the provider API key env on the server process.'

/**
 * Locales that lost at least one key, sorted for a stable message.
 * A bare `totalFailed: 141` says nothing about which languages shipped
 * incomplete — this is what makes the count actionable in a CI log.
 * Reads the full and the compact shapes, since either may reach here.
 */
export function localesWithFailures(result: TranslateMissingOutcome): string[] {
  const perLayer: TranslateMissingResult[] = 'layers' in result
    ? Object.values(result.layers)
    : [result]

  const locales = new Set<string>()
  for (const layer of perLayer) {
    for (const [locale, entry] of Object.entries(layer.results ?? {})) {
      if (entry.failed.length > 0) locales.add(locale)
    }
    for (const entry of layer.summary.byLocale ?? []) {
      if (entry.failed > 0) locales.add(entry.locale)
    }
  }
  return [...locales].sort()
}

/** True when any layer of the outcome carries fallback contexts to translate by hand. */
function hasFallbackContexts(result: TranslateMissingOutcome): boolean {
  // All-layers mode nests the fallback contexts per layer, so checking only the
  // top level would skip the guidance in exactly the case a layered project
  // hits by default.
  return 'layers' in result
    ? Object.values(result.layers).some(layer => layer.fallbackContexts)
    : Boolean(result.fallbackContexts)
}

export function applyTranslateMissingGuidance(
  result: TranslateMissingOutcome,
  surface: Surface,
): void {
  if (surface === 'mcp') {
    if (hasFallbackContexts(result) && result.summary) {
      (result.summary as Record<string, unknown>).message = AGENT_MODE_MCP
    }
    return
  }

  // Single-layer and all-layers results both carry summary.mode, so this needs
  // no narrowing.
  if (result.summary.mode === 'agent') {
    result.summary.message = NO_PROVIDER_CLI
    return
  }

  if (result.summary.totalFailed > 0) {
    // A partial failure exits 0 unless --failOnFailed was passed, so without
    // this the only trace of it is a count nobody reads. Re-running is the fix:
    // the keys are still missing, so the next run retries them.
    const affected = localesWithFailures(result)
    result.summary.message = `${result.summary.totalFailed} key(s) failed to translate`
      + (affected.length > 0 ? ` (locales: ${affected.join(', ')})` : '')
      + '. Those keys remain missing — re-run to retry them. '
      + 'Pass --fail-on-failed to make this exit 2 in CI.'
  }
}

export function applyTranslateKeyGuidance(result: TranslateKeyResult, surface: Surface): void {
  if (surface === 'mcp') {
    if (result.fallbackContext) result.message = AGENT_MODE_KEY_MCP
    return
  }

  // At a terminal, agent mode means exactly one thing: no provider was given.
  if (result.mode === 'agent' && result.skipped.some(skip => skip.reason === 'no-provider')) {
    result.message = NO_PROVIDER_CLI
  }
}

// ─── next steps, per operation ───────────────────────────────────

/**
 * What each surface calls the things a next step points at. The same state has
 * one answer at a terminal and another over MCP — `--remove` against
 * `remove: true`, `translate` against `translate_missing` — and naming both
 * here keeps them one decision instead of two texts that drift.
 */
const NAMES = {
  cli: {
    write: '`write`',
    translate: '`translate`',
    move: '`move`',
    search: '`search`',
    seedEmpty: '`check --write`',
    remove: '`--remove`',
  },
  mcp: {
    write: 'write_translations',
    translate: 'translate_missing',
    move: 'move_translation_key',
    search: 'search_translations',
    seedEmpty: 'find_undefined_keys with write: true',
    remove: 'remove: true',
  },
} as const satisfies Record<Surface, Record<string, string>>

type OperationNames = (typeof NAMES)[Surface]

/**
 * Attach the next step an operation's result implies, if it implies one.
 *
 * Called for every operation, so an agent is told what to do next whatever it
 * ran — the translating tools used to be the only ones that said anything, and
 * a caller reading `orphanCount: 41` had to know the flag that acts on it.
 */
export function applyGuidance(descriptorId: string, result: unknown, surface: Surface): void {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return

  const record = result as Record<string, unknown>
  const step = nextStep(descriptorId, record, NAMES[surface])
  if (step === undefined) return

  // Never a replacement: several operations write a message of their own, and
  // what is added here is the step after it.
  const target = summaryRecord(record) ?? record
  const existing = target.message
  target.message = typeof existing === 'string' && existing.length > 0
    ? `${existing} ${step}`
    : step
}

function nextStep(
  descriptorId: string,
  result: Record<string, unknown>,
  names: OperationNames,
): string | undefined {
  const summary = summaryRecord(result)

  switch (descriptorId) {
    case 'orphans':
      return orphanStep(result, summary, names)
    case 'check': {
      const undefinedCount = numberAt(summary, 'undefinedCount')
      if (undefinedCount === 0) return undefined
      return `${undefinedCount} key(s) render raw. ${names.write} to define them, `
        + `or ${names.seedEmpty} to seed empty values, then ${names.translate}.`
    }
    case 'missing': {
      if (numberAt(summary, 'totalMissingKeys') === 0) return undefined
      return join(`${names.translate} fills these.`, truncationStep(result))
    }
    case 'find-duplicates':
      return numberAt(summary, 'totalCollisions') === 0
        ? undefined
        : `${names.move} to hoist or consolidate; divergent values need a human decision.`
    case 'write':
      return writeStep(result, names)
    case 'remove':
      return removeStep(result, names)
    case 'move':
      return moveStep(result)
    case 'search':
    case 'get':
    case 'list-namespaces':
      return truncationStep(result)
    default:
      return undefined
  }
}

function orphanStep(
  result: Record<string, unknown>,
  summary: Record<string, unknown> | undefined,
  names: OperationNames,
): string | undefined {
  // A usage report answers the inverted question, and a removal run has already
  // done the thing this step would ask for.
  if ('usages' in result || 'removed' in result || summary?.removedCount !== undefined) return undefined

  const orphanCount = numberAt(summary, 'orphanCount')
  if (orphanCount === 0) return undefined

  const linked = numberAt(summary, 'linkedCount')
  return `${orphanCount} orphan key(s). Re-run with ${names.remove} after reviewing candidateOnlyKeys, `
    + `uncertainKeys and misplacedUsages, or ${names.move} the misplaced usages.`
    + (linked > 0
      ? ` ${linked} key(s) another message links to with @: are protected and never deleted.`
      : '')
}

function writeStep(result: Record<string, unknown>, names: OperationNames): string | undefined {
  // A dry run wrote nothing, so there is nothing to fill in behind it.
  if (result.dryRun === true) return undefined

  const written = lengthAt(result, 'written')
  if (written === 0) return undefined
  return `Wrote ${written} key(s). ${names.translate} fills the locales this call left out.`
}

function removeStep(result: Record<string, unknown>, names: OperationNames): string | undefined {
  const notFound = lengthAt(result, 'notFound')
  if (notFound === 0) return undefined
  return `${notFound} requested key(s) were not defined in this layer and were left alone. `
    + `${names.search} finds where they live.`
}

function moveStep(result: Record<string, unknown>): string | undefined {
  const conflicts = lengthAt(result, 'conflictsInLocales')
  if (conflicts > 0) {
    return `Nothing was written: ${conflicts} locale(s) already hold the destination key with a `
      + 'different value. Resolve those by hand, or pick another destination.'
  }

  const notFound = lengthAt(result, 'notFoundInLocales')
  return notFound === 0
    ? undefined
    : `${notFound} locale(s) do not define this key in the source layer; they were left alone.`
}

/** What a capped read leaves a caller to do. Silent when nothing was cut off. */
function truncationStep(result: Record<string, unknown>): string | undefined {
  if (result.truncated !== true) return undefined
  const nextOffset = result.nextOffset
  return `Result truncated at limit; pass offset=${typeof nextOffset === 'number' ? nextOffset : 'nextOffset'} `
    + 'for more, or narrow the query.'
}

function summaryRecord(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary = result.summary
  return summary !== null && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : undefined
}

function numberAt(record: Record<string, unknown> | undefined, field: string): number {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function lengthAt(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  return Array.isArray(value) ? value.length : 0
}

function join(...parts: Array<string | undefined>): string {
  return parts.filter(part => part !== undefined && part.length > 0).join(' ')
}
