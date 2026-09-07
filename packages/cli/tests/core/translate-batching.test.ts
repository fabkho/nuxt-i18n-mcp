import { describe, it, expect } from 'vitest'
import {
  planBatches,
  expansionFor,
  estimateOutputChars,
  TRANSLATE_MAX_TOKENS,
  TRANSLATE_BUDGET_CHARS,
  CHARS_PER_TOKEN,
  BUDGET_UTILISATION,
  JSON_OVERHEAD_CHARS,
} from '../../src/core/translate/batching.js'
import type { KeyEntry } from '../../src/core/translate/batching.js'

/**
 * Unit contract of batch planning. A batch too heavy for the model's output
 * budget comes back cut off, so the plan is what keeps most requests whole —
 * the seam tests cover what the run does with the ones it gets wrong.
 */

/** `n` entries named k0…k(n-1), each carrying `value`. */
function entries(n: number, value: string): KeyEntry[] {
  return Array.from({ length: n }, (_, i) => [`k${i}`, value] as KeyEntry)
}

const keysOf = (batches: KeyEntry[][]): string[] => batches.flat().map(([key]) => key)

describe('planBatches', () => {
  it('never puts more than maxKeys entries in a batch', () => {
    const batches = planBatches(entries(10, 'kurz'), { maxKeys: 3, budgetChars: 1_000_000 })

    expect(batches.map(b => b.length)).toEqual([3, 3, 3, 1])
  })

  it('cuts a batch before the entry that would overrun the character budget', () => {
    // Each entry estimates at 2 + 30 + 8 = 40 characters with expansion 1.
    const value = 'x'.repeat(30)
    const batches = planBatches(entries(6, value), { maxKeys: 50, budgetChars: 100 })

    // Two entries (80) fit, a third (120) does not.
    expect(batches.map(b => b.length)).toEqual([2, 2, 2])
  })

  it('gives an entry heavier than the whole budget a batch of its own rather than dropping it', () => {
    const input: KeyEntry[] = [
      ['small.before', 'kurz'],
      ['huge', 'x'.repeat(5000)],
      ['small.after', 'kurz'],
    ]

    const batches = planBatches(input, { maxKeys: 50, budgetChars: 100 })

    expect(batches.map(b => b.map(([key]) => key))).toEqual([
      ['small.before'],
      ['huge'],
      ['small.after'],
    ])
  })

  it('preserves input order within and across batches', () => {
    const input = entries(25, 'Ein etwas längerer Wert für die Schätzung')

    const batches = planBatches(input, { maxKeys: 4, budgetChars: 300, expansion: 1.4 })

    expect(keysOf(batches)).toEqual(input.map(([key]) => key))
    expect(batches.every(b => b.length > 0)).toBe(true)
  })

  it('loses no entry, whatever the limits', () => {
    const input = entries(37, 'Speichern und schließen')

    for (const maxKeys of [1, 5, 50]) {
      for (const budgetChars of [1, 200, TRANSLATE_BUDGET_CHARS]) {
        const batches = planBatches(input, { maxKeys, budgetChars })
        expect(keysOf(batches)).toEqual(input.map(([key]) => key))
        expect(batches.every(b => b.length <= maxKeys)).toBe(true)
      }
    }
  })

  it('plans more batches for a script that weighs more per source character', () => {
    const input = entries(60, 'Ein Hilfetext, der ein paar Zeilen lang ist und entsprechend wiegt.')
    const opts = { maxKeys: 50, budgetChars: 2000 }

    const latin = planBatches(input, { ...opts, expansion: expansionFor({ code: 'fr' }) })
    const greek = planBatches(input, { ...opts, expansion: expansionFor({ code: 'el' }) })

    expect(greek.length).toBeGreaterThan(latin.length)
    // Weight only ever makes a batch smaller — maxKeys stays the hard cap.
    expect(Math.max(...greek.map(b => b.length))).toBeLessThanOrEqual(opts.maxKeys)
  })

  it('estimates an entry as key plus value, scaled by the script weight, plus JSON scaffolding', () => {
    expect(estimateOutputChars('abc', 'Hallo', 1)).toBe(8 + JSON_OVERHEAD_CHARS)
    expect(estimateOutputChars('abc', 'Hallo', 1.5)).toBe(12 + JSON_OVERHEAD_CHARS)
  })
})

describe('expansionFor', () => {
  it('treats a Latin-script target as costing what the German source costs', () => {
    expect(expansionFor({ code: 'en' })).toBe(1)
    expect(expansionFor({ code: 'fr', language: 'fr-FR' })).toBe(1)
    expect(expansionFor({ code: 'pt-BR', language: 'pt-BR' })).toBe(1)
  })

  it('weighs the scripts that tokenise worse than Latin above it', () => {
    expect(expansionFor({ code: 'uk' })).toBe(1.4)
    expect(expansionFor({ code: 'ru-RU' })).toBe(1.4)
    expect(expansionFor({ code: 'el' })).toBe(1.4)
    expect(expansionFor({ code: 'ja' })).toBe(1.5)
    expect(expansionFor({ code: 'zh-Hans' })).toBe(1.5)
    expect(expansionFor({ code: 'ar' })).toBe(1.3)
    expect(expansionFor({ code: 'th' })).toBe(1.6)
    expect(expansionFor({ code: 'hi' })).toBe(1.6)
  })

  it('reads the language tag when the configured code is a project-local alias', () => {
    expect(expansionFor({ code: 'ukrainisch', language: 'uk-UA' })).toBe(1.4)
  })

  it('falls back above Latin for an unknown target, which may be any script', () => {
    expect(expansionFor({ code: 'xx' })).toBe(1.2)
    expect(expansionFor({ code: 'xx', language: 'xx-XX' })).toBe(1.2)
  })
})

describe('the request character budget', () => {
  it('is the token budget in Latin characters, at the planned utilisation', () => {
    expect(TRANSLATE_BUDGET_CHARS).toBe(Math.floor(TRANSLATE_MAX_TOKENS * CHARS_PER_TOKEN * BUDGET_UTILISATION))
    expect(TRANSLATE_MAX_TOKENS).toBe(16384)
    expect(TRANSLATE_BUDGET_CHARS).toBe(34406)
  })

  it('leaves headroom under the raw token budget for what the estimate cannot see', () => {
    expect(BUDGET_UTILISATION).toBeLessThan(1)
    expect(TRANSLATE_BUDGET_CHARS).toBeLessThan(TRANSLATE_MAX_TOKENS * CHARS_PER_TOKEN)
  })
})
