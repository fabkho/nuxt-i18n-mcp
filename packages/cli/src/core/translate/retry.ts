/**
 * The provider request loop shared by translate_missing and translate_key:
 * one attempt plus one retry, with the two outcomes that must never be
 * retried — an auth failure (fatal for the whole run) and a truncated
 * response (the same token budget would truncate again).
 */

import { log } from '../../utils/logger.js'
import { ToolError, toErrorMessage } from '../../utils/errors.js'
import { TranslateProviderError } from '../../llm/providers.js'

import type { TranslateFn, TranslateRequest } from '../types.js'

/** One initial attempt plus one retry. */
const MAX_ATTEMPTS = 2

/** Backoff before attempt n: 4s before the single retry. */
function backoffMs(attempt: number): number {
  return 2000 * 2 ** attempt
}

/**
 * Cooperative abort flag shared by the locales of one run. Set when a request
 * fails authentication: every sibling request would fail the same way, so they
 * stop issuing requests and their results are discarded.
 */
export interface TranslateRunState {
  aborted: boolean
}

export interface RequestContext<T> {
  /**
   * Turn a response body into the caller's shape. Throwing counts as a failed
   * attempt and is retried, so parse errors and transport errors share one
   * retry budget.
   *
   * `truncated` says the provider stopped at the token limit, which makes the
   * tail of the body untrustworthy — a parser that salvages needs to know.
   */
  parse: (responseText: string, truncated: boolean) => T
  /** Identifies the request in warnings, e.g. `batch of 12 key(s) in en` or `en`. */
  label: string
  /** Report the responding model — batched runs log it per response. */
  logModel?: boolean
  runState?: TranslateRunState
}

/**
 * `failed` covers every attempt throwing as well as an abort observed before
 * a request went out; the caller maps it to its own fail reason.
 *
 * `partial` is a truncated response that still carried usable content: the
 * value holds only what provably arrived, so the caller must account for
 * everything it asked for and did not get back as cut off, not as omitted.
 */
export type RequestOutcome<T>
  = | { status: 'ok', value: T, model?: string }
    | { status: 'partial', value: T, model?: string }
    | { status: 'truncated', model?: string }
    | { status: 'failed', model?: string }

/** Nothing survived the cut: nullish, or an object without a single entry. */
function carriesNothing(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** How much a salvaged value recovered, for the truncation warning. */
function recoveredCount(value: unknown): number {
  return value !== null && typeof value === 'object' ? Object.keys(value).length : 1
}

/**
 * Issue one translate request, retrying once on failure. `model` reports the
 * last responding model even for a truncated or unparsable response, so
 * callers can attribute a partially failed run.
 */
export async function requestWithRetry<T>(
  translateFn: TranslateFn,
  req: TranslateRequest,
  ctx: RequestContext<T>,
): Promise<RequestOutcome<T>> {
  let model: string | undefined

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, backoffMs(attempt)))
    }
    // A sibling locale may have aborted the run while this attempt waited.
    if (ctx.runState?.aborted) break

    try {
      const response = await translateFn(req)

      model = response.model
      if (ctx.logModel) log.info(`Translation model: ${response.model}`)

      if (response.truncated) {
        // The response was cut off at the token limit — retrying with the same
        // budget would truncate again, so fail fast. What arrived before the
        // cut is still worth keeping: discarding it loses a whole batch over
        // its last key.
        let salvaged: T | undefined
        try {
          const parsed = ctx.parse(response.text, true)
          if (!carriesNothing(parsed)) salvaged = parsed
        }
        catch {
          // Nothing parseable arrived; reported as a plain truncation below.
        }
        if (salvaged !== undefined) {
          log.warn(
            `Translate response truncated for ${ctx.label}: provider hit the token limit — `
            + `kept ${recoveredCount(salvaged)} complete translation(s), the rest did not arrive.`,
          )
          return { status: 'partial', value: salvaged, model }
        }
        log.warn(`Translate response truncated for ${ctx.label}: provider hit the token limit before anything usable arrived.`)
        return { status: 'truncated', model }
      }
      if (response.text.trim() === '') {
        throw new TranslateProviderError('Provider returned an empty response', 'provider')
      }

      return { status: 'ok', value: ctx.parse(response.text, false), model }
    } catch (error) {
      if (error instanceof TranslateProviderError && error.kind === 'auth') {
        // Auth failures affect every request — abort the whole run instead of
        // failing key by key through retries.
        if (ctx.runState) ctx.runState.aborted = true
        throw new ToolError(
          `Provider authentication failed: ${error.message}. Verify your API key (config apiKey or the provider's environment variable).`,
          'PROVIDER_AUTH_ERROR',
        )
      }
      const errMsg = toErrorMessage(error)
      if (attempt === 0) {
        log.warn(`Translate request failed for ${ctx.label}: ${errMsg}. Retrying (attempt 2)`)
      } else {
        log.warn(`Translate retry failed for ${ctx.label}: ${errMsg}`)
      }
    }
  }

  return { status: 'failed', model }
}
