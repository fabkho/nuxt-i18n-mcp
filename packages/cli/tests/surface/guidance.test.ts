import { describe, it, expect } from 'vitest'
import { applyGuidance } from '../../src/surface/guidance.js'

/**
 * The next step each result implies, asserted against hand-built results.
 *
 * Built by hand rather than run: what the guidance says is a function of the
 * result alone, and stating the state inline is what makes each branch legible
 * — a fixture producing 41 orphans would say less about why the sentence
 * appears than `orphanCount: 41` does.
 */

/** The message a result ended up carrying, wherever it carries it. */
function messageOf(result: Record<string, unknown>): string | undefined {
  const summary = result.summary as Record<string, unknown> | undefined
  const message = summary?.message ?? result.message
  return typeof message === 'string' ? message : undefined
}

describe('orphans', () => {
  it('names the flag that deletes and the tool that moves', () => {
    const result = { orphanKeys: {}, summary: { orphanCount: 41, totalKeys: 900, filesScanned: 12 } }
    applyGuidance('orphans', result, 'mcp')

    expect(messageOf(result)).toBe(
      '41 orphan key(s). Re-run with remove: true after reviewing candidateOnlyKeys, '
      + 'uncertainKeys and misplacedUsages, or move_translation_key the misplaced usages.',
    )
  })

  it('says the same thing in the terminal\'s words', () => {
    const result = { orphanKeys: {}, summary: { orphanCount: 41 } }
    applyGuidance('orphans', result, 'cli')

    expect(messageOf(result)).toContain('Re-run with `--remove`')
    expect(messageOf(result)).toContain('`move`')
  })

  it('mentions the linked keys a removal would not touch', () => {
    const result = { orphanKeys: {}, summary: { orphanCount: 41, linkedCount: 7 } }
    applyGuidance('orphans', result, 'mcp')

    expect(messageOf(result)).toContain('7 key(s) another message links to with @: are protected')
  })

  it('says nothing about a run that already removed them', () => {
    const result = { removed: { root: ['a.b'] }, summary: { orphanCount: 41, removedCount: 41 } }
    applyGuidance('orphans', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })

  it('says nothing about a usage report, which answers the other question', () => {
    const result = { usages: {}, summary: { orphanCount: 0, uniqueKeysFound: 3 } }
    applyGuidance('orphans', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })

  it('says nothing when nothing is orphaned', () => {
    const result = { orphanKeys: {}, summary: { orphanCount: 0 } }
    applyGuidance('orphans', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })
})

describe('check', () => {
  it('adds the fix behind the finding, keeping the message the scan wrote', () => {
    const result = { summary: { undefinedCount: 3, message: '3 key(s) render as raw keys at runtime.' } }
    applyGuidance('check', result, 'mcp')

    expect(messageOf(result)).toBe(
      '3 key(s) render as raw keys at runtime. 3 key(s) render raw. write_translations to define them, '
      + 'or find_undefined_keys with write: true to seed empty values, then translate_missing.',
    )
  })

  it('points a terminal at the flag that seeds them', () => {
    const result = { summary: { undefinedCount: 3 } }
    applyGuidance('check', result, 'cli')

    expect(messageOf(result)).toBe(
      '3 key(s) render raw. `write` to define them, or `check --write` to seed empty values, then `translate`.',
    )
  })

  it('says nothing when every used key resolves', () => {
    const result = { summary: { undefinedCount: 0, message: 'All statically referenced keys resolve.' } }
    applyGuidance('check', result, 'mcp')

    expect(messageOf(result)).toBe('All statically referenced keys resolve.')
  })
})

describe('missing', () => {
  it('names the operation that fills them', () => {
    const result = { missing: {}, truncated: false, summary: { totalMissingKeys: 812 } }
    applyGuidance('missing', result, 'mcp')

    expect(messageOf(result)).toBe('translate_missing fills these.')
  })

  it('adds where to continue when the list was capped', () => {
    const result = { missing: {}, truncated: true, nextOffset: 100, summary: { totalMissingKeys: 812 } }
    applyGuidance('missing', result, 'mcp')

    expect(messageOf(result)).toBe(
      'translate_missing fills these. Result truncated at limit; pass offset=100 for more, or narrow the query.',
    )
  })

  it('says nothing about a complete project', () => {
    const result = { missing: {}, truncated: false, summary: { totalMissingKeys: 0 } }
    applyGuidance('missing', result, 'cli')

    expect(messageOf(result)).toBeUndefined()
  })
})

describe('find-duplicates', () => {
  it('names the operation that consolidates, and leaves the decision with a human', () => {
    const result = { collisions: [{ key: 'a.b' }], summary: { totalCollisions: 1, divergentCount: 1 } }
    applyGuidance('find-duplicates', result, 'mcp')

    expect(messageOf(result)).toBe(
      'move_translation_key to hoist or consolidate; divergent values need a human decision.',
    )
  })

  it('says nothing when no key is defined twice', () => {
    const result = { collisions: [], summary: { totalCollisions: 0 } }
    applyGuidance('find-duplicates', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })
})

describe('write', () => {
  it('points at the locales the call left out', () => {
    const result = { written: ['auth.login.title', 'auth.login.subtitle'], skipped: [] }
    applyGuidance('write', result, 'mcp')

    expect(messageOf(result)).toBe('Wrote 2 key(s). translate_missing fills the locales this call left out.')
  })

  it('says nothing about a dry run, which wrote nothing to fill in behind', () => {
    const result = { dryRun: true, wouldWrite: [{ key: 'a.b' }], skipped: [], summary: { keysWritten: 1, message: 'Call again with dryRun: false to apply these changes.' } }
    applyGuidance('write', result, 'cli')

    expect(messageOf(result)).toBe('Call again with dryRun: false to apply these changes.')
  })
})

describe('remove and move', () => {
  it('reports the keys a removal did not find, and where to look for them', () => {
    const result = { removed: ['a.b'], notFound: ['a.c', 'a.d'], filesWritten: 2 }
    applyGuidance('remove', result, 'mcp')

    expect(messageOf(result)).toBe(
      '2 requested key(s) were not defined in this layer and were left alone. '
      + 'search_translations finds where they live.',
    )
  })

  it('says nothing about a removal that found everything', () => {
    const result = { removed: ['a.b'], notFound: [], filesWritten: 2 }
    applyGuidance('remove', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })

  it('explains a move that wrote nothing because the destination disagreed', () => {
    const result = { conflictsInLocales: ['de', 'fr'], summary: { localesAffected: 0, message: 'Nothing was moved.' } }
    applyGuidance('move', result, 'mcp')

    expect(messageOf(result)).toContain('2 locale(s) already hold the destination key with a different value')
  })

  it('reports the locales a move left alone', () => {
    const result = { movedLocales: ['de'], notFoundInLocales: ['fr'], summary: { localesAffected: 1, message: 'Moved.' } }
    applyGuidance('move', result, 'cli')

    expect(messageOf(result)).toBe('Moved. 1 locale(s) do not define this key in the source layer; they were left alone.')
  })

  it('says nothing about a clean move', () => {
    const result = { movedLocales: ['de', 'fr'], summary: { localesAffected: 2, message: 'Moved.' } }
    applyGuidance('move', result, 'mcp')

    expect(messageOf(result)).toBe('Moved.')
  })
})

describe('the capped reads', () => {
  it.each(['search', 'get', 'list-namespaces'])('tells %s where the next page starts', (id) => {
    const result = { truncated: true, nextOffset: 100 }
    applyGuidance(id, result, 'mcp')

    expect(messageOf(result)).toBe('Result truncated at limit; pass offset=100 for more, or narrow the query.')
  })

  it('says nothing about a read that returned everything', () => {
    const result = { truncated: false, totalMatches: 3 }
    applyGuidance('search', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })

  it('leaves an operation it knows nothing about alone', () => {
    const result = { config: {}, written: ['x'] }
    applyGuidance('init', result, 'mcp')

    expect(messageOf(result)).toBeUndefined()
  })
})
