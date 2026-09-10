import { describe, expect, it } from 'vitest'

import { localesWithFailures } from '../../src/surface/guidance.js'
import { resolveExitCode } from '../../src/commands/_shared.js'
import type { TranslateMissingOutcome } from '../../src/core/translate/run.js'

/**
 * A translate run that writes most keys and loses the rest exits 0: exit 1 is
 * reserved for a run that translated nothing (isTotalFailure). That is why the
 * partial case needs its own opt-in gate — without it, 141 lost keys out of 936
 * are indistinguishable from a clean run, and the partial result is committed.
 */

const failedGate = {
  name: 'fail-on-failed',
  counter: 'totalFailed',
  direction: 'above' as const,
  threshold: 0,
}

describe('the --fail-on-failed gate', () => {
  it('trips on a partial failure, which no other signal reports', () => {
    const partial = { summary: { totalTranslated: 795, totalFailed: 141 } }

    // The shape of the anny-ui run: green pipeline, 141 keys unwritten.
    expect(resolveExitCode(partial, []).code).toBe(0)
    expect(resolveExitCode(partial, [failedGate]).code).toBe(2)
  })

  it('names the observed count against the threshold when it trips', () => {
    const decision = resolveExitCode(
      { summary: { totalTranslated: 795, totalFailed: 141 } },
      [failedGate],
    )

    expect(decision.tripped).toEqual([{ ...failedGate, observed: 141 }])
  })

  it('stays quiet on a clean run', () => {
    const decision = resolveExitCode(
      { summary: { totalTranslated: 936, totalFailed: 0 } },
      [failedGate],
    )

    expect(decision.code).toBe(0)
    expect(decision.tripped).toEqual([])
  })

  // A total failure is a broken run, not a findings gate — CI must tell them
  // apart, so exit 1 outranks exit 2.
  it('yields to a total failure rather than reporting a gate', () => {
    const decision = resolveExitCode(
      { summary: { totalTranslated: 0, totalFailed: 141 } },
      [failedGate],
      true,
    )

    expect(decision.code).toBe(1)
    expect(decision.tripped).toEqual([])
  })
})

describe('naming the locales that lost keys', () => {
  it('reads the all-layers shape, deduplicating across layers', () => {
    const result = {
      layers: {
        'app-admin': {
          results: {
            'da-DK': { failed: [{ key: 'a' }, { key: 'b' }] },
            'fr-FR': { failed: [{ key: 'c' }] },
            'en-GB': { failed: [] },
          },
          summary: {},
        },
        'app-shop': {
          results: {
            'da-DK': { failed: [{ key: 'd' }] },
            'uk-UA': { failed: [{ key: 'e' }] },
          },
          summary: {},
        },
      },
      summary: { totalFailed: 5 },
    } as unknown as TranslateMissingOutcome

    expect(localesWithFailures(result)).toEqual(['da-DK', 'fr-FR', 'uk-UA'])
  })

  it('reads the single-layer shape', () => {
    const result = {
      results: {
        de: { failed: [] },
        lv: { failed: [{ key: 'x' }] },
      },
      summary: { totalFailed: 1 },
    } as unknown as TranslateMissingOutcome

    expect(localesWithFailures(result)).toEqual(['lv'])
  })

  // Compact mode returns counts in summary.byLocale instead of `results`, so
  // reading only one of the two would report no locales for half the runs.
  it('reads the compact shape, where failures are counts rather than lists', () => {
    const result = {
      summary: {
        totalFailed: 3,
        byLocale: [
          { locale: 'nb', failed: 0 },
          { locale: 'ga', failed: 3 },
        ],
      },
    } as unknown as TranslateMissingOutcome

    expect(localesWithFailures(result)).toEqual(['ga'])
  })

  it('returns nothing when no locale failed', () => {
    const result = {
      results: { de: { failed: [] } },
      summary: { totalFailed: 0 },
    } as unknown as TranslateMissingOutcome

    expect(localesWithFailures(result)).toEqual([])
  })
})
