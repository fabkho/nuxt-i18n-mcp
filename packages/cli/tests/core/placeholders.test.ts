import { describe, it, expect } from 'vitest'
import {
  validatePlaceholders,
  comparePlaceholders,
  describePlaceholderIssue,
  failReasonForIssue,
} from '../../src/core/translate/placeholders.js'
import type { LocaleFileFormat } from '../../src/adapters/types.js'

/**
 * Parity for everything a plain (non-ICU) message carries: interpolations,
 * pipe plurals, markup and printf conversions. `translate` discards a value
 * that trips one of these rules and `write` warns about it, so the cases that
 * must NOT be reported — prose that merely looks like a placeholder — matter
 * as much as the ones that must.
 */

function validate(source: string, target: string, format?: LocaleFileFormat) {
  return validatePlaceholders('key', source, [{ locale: 'de', value: target }], format)
}

function kinds(source: string, target: string, format?: LocaleFileFormat) {
  return comparePlaceholders(source, target, format).map(issue => issue.kind)
}

describe('Laravel :param in every format', () => {
  it('reports a dropped :param in JSON and YAML, not only in a PHP array', () => {
    for (const format of ['json', 'yaml', 'php-array'] as const) {
      expect(validate('Welcome back, :name', 'Willkommen zurück, :name', format).ok).toBe(true)
      expect(validate('Welcome back, :name', 'Willkommen zurück', format).errors[0])
        .toMatchObject({ kind: 'placeholder', missing: [':name'], extra: [] })
    }
  })

  it('reports an invented :param', () => {
    expect(validate('Welcome back', 'Willkommen zurück, :name').errors[0])
      .toMatchObject({ kind: 'placeholder', missing: [], extra: [':name'] })
  })

  it('reads :param at the start of a value and after an opening bracket', () => {
    expect(validate(':count selected', 'Ausgewählt').errors[0]).toMatchObject({ missing: [':count'] })
    expect(validate('Total (:count)', 'Gesamt').errors[0]).toMatchObject({ missing: [':count'] })
  })

  it('does not read a time, a URL or a Vue binding as a :param', () => {
    // Every colon here follows a word character, a slash or an `=` binding —
    // none of them is a parameter, and a translation may move or drop them.
    expect(validate('Daily at 12:30 — see https://anny.co/help', 'Täglich um 09:00').ok).toBe(true)
    expect(validate('Open <a :href="url">here</a>', 'Hier <a :href="url">öffnen</a>').ok).toBe(true)
    expect(validate('Format HH:mm:ss', 'Format HH:mm').ok).toBe(true)
  })

  it('does not read a German gender colon, a link or an ordinal suffix as a :param', () => {
    expect(validate('Für unsere Kund:innen', 'For our customers').ok).toBe(true)
    expect(validate('See @:common.help', 'Siehe @:common.help').ok).toBe(true)
    // Swedish `{n}:e` and Finnish `%:n` attach a suffix to the token before them.
    expect(validate('The {n}:e time', 'Das {n}:e Mal').ok).toBe(true)
    expect(validate('{percent} %:n alennus', '{percent} % Rabatt').ok).toBe(true)
  })
})

describe('vue-i18n curly interpolation', () => {
  it('compares list indices like {0}', () => {
    expect(validate('{0} bookings', '{0} Buchungen').ok).toBe(true)
    expect(validate('{0} bookings', 'Buchungen').errors[0]).toMatchObject({ missing: ['{0}'], extra: [] })
    expect(validate('bookings', '{0} Buchungen').errors[0]).toMatchObject({ missing: [], extra: ['{0}'] })
  })

  it('treats { name } and {name} as the same placeholder', () => {
    // vue-i18n resolves both to the same argument.
    expect(validate('Hello {name}', 'Hallo { name }').ok).toBe(true)
    expect(validate('Hello { name }', 'Hallo {name}').ok).toBe(true)
    expect(validate('Hello { name }', 'Hallo').errors[0]).toMatchObject({ missing: ['{name}'] })
    expect(validate('Hello { name }', 'Hallo').placeholders).toEqual(['{name}'])
  })
})

describe('vue-i18n plural arity', () => {
  it('splits on a bare pipe, so Tag|Tage is two variants', () => {
    const result = validate('Tag|Tage', 'Day')

    expect(result.errors[0]).toMatchObject({ kind: 'plural-count', sourceVariants: 2, targetVariants: 1 })
    expect(failReasonForIssue(result.errors[0]!)).toBe('plural-mismatch')
    expect(validate('Tag|Tage', 'day|days').ok).toBe(true)
  })

  it('does not fail a translation over the spacing around the pipe', () => {
    // `a |b`, `a| b` and `a | b` are the same two variants to vue-i18n.
    expect(validate('one | many', 'eins |viele').ok).toBe(true)
    expect(validate('one | many', 'eins| viele').ok).toBe(true)
    expect(validate('{n} day | {n} days', '{n} Tag|{n} Tage').ok).toBe(true)
  })

  it('still compares each variant against its own counterpart', () => {
    expect(validate('one item | {count} items', 'ein Artikel|Artikel').errors[0])
      .toMatchObject({ kind: 'placeholder', missing: ['{count}'] })
  })

  it('leaves a target that pluralises a non-plural source alone', () => {
    // Croatian needs a form German has no use for; vue-i18n picks it from the
    // count the call site passes, so this is not an arity error.
    expect(validate('{n} selected', 'Én valgt | {n} valgt').ok).toBe(true)
  })

  it('treats a pipe in a PHP array message as text', () => {
    expect(validate('Tag|Tage', 'Day', 'php-array').ok).toBe(true)
  })
})

describe('HTML tags', () => {
  it('reports a dropped and an invented tag by name', () => {
    expect(validate('A <b>bold</b> move', 'Ein mutiger Schritt').errors[0])
      .toMatchObject({ kind: 'html-tag', missing: ['</b>', '<b>'], extra: [] })
    expect(validate('A bold move', 'Ein <b>mutiger</b> Schritt').errors[0])
      .toMatchObject({ kind: 'html-tag', missing: [], extra: ['</b>', '<b>'] })
  })

  it('compares tags as a multiset and names the count', () => {
    expect(validate('<b>a</b> and <b>b</b>', '<b>a</b> und b').errors[0])
      .toMatchObject({ kind: 'html-tag', missing: ['</b>', '<b>'] })
    expect(validate('<li>a</li><li>b</li><li>c</li>', '<li>a</li>').errors[0])
      .toMatchObject({ kind: 'html-tag', missing: ['</li> ×2', '<li> ×2'] })
  })

  it('accepts the self-closing and case variants of the same tag', () => {
    expect(validate('one<br>two', 'eins<br/>zwei').ok).toBe(true)
    expect(validate('one<br>two', 'eins<br />zwei').ok).toBe(true)
    expect(validate('one<br>two', 'eins<BR>zwei').ok).toBe(true)
  })

  it('ignores attributes — a link may point at a localised page', () => {
    expect(validate('<a href="/en/terms">Terms</a>', '<a href="/de/agb" target="_blank">AGB</a>').ok).toBe(true)
  })

  it('does not treat a bare < as markup', () => {
    expect(validate('< 1 minute', '< 1 Minute').ok).toBe(true)
    expect(validate('< 1 minute', 'unter 1 Minute').ok).toBe(true)
    expect(validate('a < b and b > a', 'a < b und b > a').ok).toBe(true)
  })
})

describe('HTML entities', () => {
  it('reports an entity the translation dropped or invented', () => {
    expect(validate('Bed &amp; Breakfast', 'Bed & Breakfast').errors[0])
      .toMatchObject({ kind: 'html-entity', missing: ['&amp;'], extra: [] })
    expect(validate('10&nbsp;€', '10 €').errors[0])
      .toMatchObject({ kind: 'html-entity', missing: ['&nbsp;'], extra: [] })
    expect(validate('10 €', '10&nbsp;€').errors[0])
      .toMatchObject({ kind: 'html-entity', missing: [], extra: ['&nbsp;'] })
  })

  it('counts repeated entities', () => {
    expect(validate('Settings &gt; API &gt; Tokens', 'Nastavenia > API > Tokeny').errors[0])
      .toMatchObject({ kind: 'html-entity', missing: ['&gt; ×2'] })
  })

  it('does not treat an unterminated & as an entity', () => {
    expect(validate('R&D at anny', 'F&E bei anny').ok).toBe(true)
  })
})

describe('printf conversions', () => {
  it('reports a dropped and an invented conversion', () => {
    expect(validate('Hello %s, you have %d messages', 'Hallo %s').errors[0])
      .toMatchObject({ kind: 'printf', missing: ['%d'], extra: [] })
    expect(validate('Hello there', 'Hallo %s').errors[0])
      .toMatchObject({ kind: 'printf', missing: [], extra: ['%s'] })
  })

  it('compares positional conversions and counts repeats', () => {
    expect(validate('%1$s invited %2$s', '%2$s wurde eingeladen').errors[0])
      .toMatchObject({ kind: 'printf', missing: ['%1$s'] })
    expect(validate('%s, %s and %s', '%s und %s').errors[0])
      .toMatchObject({ kind: 'printf', missing: ['%s'] })
  })

  it('does not read a percentage in prose as a conversion', () => {
    expect(validate('100%ige Rückerstattung bei 0% MwSt.', '100% refund at 0% tax').ok).toBe(true)
  })
})

describe('issue shape', () => {
  it('names the token in every class, never just a count', () => {
    const source = 'Hi {name}, :count <b>new</b> &amp; %d unread'
    const target = 'Hallo, neu und ungelesen'
    const issues = comparePlaceholders(source, target)

    expect(issues.map(issue => issue.kind)).toEqual(['placeholder', 'html-tag', 'html-entity', 'printf'])
    expect(issues.flatMap(issue => issue.missing)).toEqual(
      [':count', '{name}', '</b>', '<b>', '&amp;', '%d'],
    )
    for (const issue of issues) expect(describePlaceholderIssue(issue)).toContain(issue.missing[0])
  })

  it('reports one issue per class so a caller can filter', () => {
    expect(kinds('<b>{name}</b>', '{name}')).toEqual(['html-tag'])
    expect(kinds('<b>{name}</b>', '<b>Name</b>')).toEqual(['placeholder'])
    expect(kinds('<b>{name}</b>', 'Name')).toEqual(['placeholder', 'html-tag'])
  })

  it('reports plural arity alone — the variants are no longer aligned', () => {
    expect(kinds('<b>{n}</b> day | <b>{n}</b> days', '{n} Tage')).toEqual(['plural-count'])
  })

  it('maps every non-arity class to the placeholder-mismatch fail reason', () => {
    for (const [source, target] of [['<b>a</b>', 'a'], ['&amp;', '&'], ['%s', 'x'], ['{a}', 'b']]) {
      const issue = comparePlaceholders(source!, target!)[0]!
      expect(failReasonForIssue(issue)).toBe('placeholder-mismatch')
    }
  })

  it('compares two values without a key or a locale', () => {
    expect(comparePlaceholders('Hi {name}', 'Hallo {name}')).toEqual([])
    expect(comparePlaceholders('Hi {name}', 'Hallo')).toEqual([
      { kind: 'placeholder', missing: ['{name}'], extra: [] },
    ])
  })
})
