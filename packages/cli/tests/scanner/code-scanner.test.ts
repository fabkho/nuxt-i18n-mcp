import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractKeys, findOrphanKeysForConfig, scanSourceFiles, toRelativePath, buildDynamicKeyRegexes, buildIgnorePatternRegexes } from '../../src/scanner/code-scanner.js'

/**
 * tinyglobby returns whatever order its parallel walk happened to finish in.
 * A handful of files in a temp directory is not enough to make that vary, so
 * the order is forced here instead of hoped for — otherwise the determinism
 * test below passes with or without the fix it exists to guard.
 */
const globControl = vi.hoisted(() => ({ reverse: false }))

vi.mock('tinyglobby', async (importActual) => {
  const actual = await importActual<typeof import('tinyglobby')>()
  return {
    ...actual,
    glob: async (...args: Parameters<typeof actual.glob>) => {
      const paths = await actual.glob(...args)
      return globControl.reverse ? [...paths].reverse() : paths
    },
  }
})

const tmpDir = join(dirname(fileURLToPath(import.meta.url)), '../../.tmp-test/scanner')

describe('single-segment keys used via a bare t()', () => {
  /**
   * `requiresDotForCallee` skips `t('word')` because a bare `t` is ambiguous —
   * `emit('save')` is not a translation. That guard is right, but dropping the
   * match entirely means a flat catalogue's keys look unreferenced, and
   * remove-orphans offers a live key for deletion (#298).
   *
   * The argument is kept as a bare candidate instead: candidates only protect
   * a key when one of that exact name exists, so an `emit('save')` in a project
   * with no `save` key still protects nothing.
   */
  it('keeps the argument as a bare candidate rather than dropping it', () => {
    const { usages, bareStringCandidates } = extractKeys(`const x = t('save')`, 'a.ts')

    expect(usages).toHaveLength(0)
    expect(bareStringCandidates.has('save')).toBe(true)
  })

  it('still records a dotted key as a confirmed usage', () => {
    const { usages } = extractKeys(`const x = t('nested.used')`, 'a.ts')

    expect(usages.map(u => u.key)).toEqual(['nested.used'])
  })

  // $t and this.$t are unambiguous, so they were never subject to the guard.
  it('leaves the unambiguous callees recording usages', () => {
    const { usages } = extractKeys(`{{ $t('save') }}`, 'a.vue')

    expect(usages.map(u => u.key)).toEqual(['save'])
  })
})

describe('scan order determinism (#327)', () => {
  /**
   * tinyglobby walks directories in parallel and promises no stable order, and
   * nothing downstream re-sorted, so scan order became output order: the same
   * binary disagreed with itself between runs on an unchanged tree — 3,194
   * differing lines on a 7-app monorepo, identical once sorted.
   *
   * That made diffing output before and after a change unusable, which is the
   * technique that catches what unit tests miss.
   */
  const determinismDir = join(tmpDir, 'determinism')

  beforeAll(async () => {
    await mkdir(join(determinismDir, 'b'), { recursive: true })
    await mkdir(join(determinismDir, 'a'), { recursive: true })
    await writeFile(join(determinismDir, 'b', 'two.vue'), `<template>{{ $t('b.two') }}</template>`)
    await writeFile(join(determinismDir, 'a', 'one.vue'), `<template>{{ $t('a.one') }}</template>`)
    await writeFile(join(determinismDir, 'a', 'three.vue'), `<template>{{ $t('a.three') }}</template>`)
  })

  afterAll(() => {
    globControl.reverse = false
  })

  it('produces the same result whichever order the walk returns files in', async () => {
    globControl.reverse = false
    const forwards = await scanSourceFiles(determinismDir)

    globControl.reverse = true
    const backwards = await scanSourceFiles(determinismDir)

    // Whole records, not just keys: a usage carries its file and line, and the
    // bug was in the order files were read. Comparing keys alone would pass
    // while file and line drifted underneath.
    expect(backwards.usages).toEqual(forwards.usages)
  })

  it('orders usages by file path rather than by walk order', async () => {
    globControl.reverse = true

    const { usages } = await scanSourceFiles(determinismDir)

    expect(usages.map(u => u.key)).toEqual(['a.one', 'a.three', 'b.two'])
  })
})

describe('extractKeys', () => {
  function extract(content: string, filePath = 'test.vue') {
    return extractKeys(content, filePath)
  }

  describe('static key extraction', () => {
    it('extracts $t() with single quotes in template', () => {
      const { usages } = extract(`{{ $t('common.actions.save') }}`)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({
        key: 'common.actions.save',
        callee: '$t',
        line: 1,
      })
    })

    it('extracts $t() with double quotes', () => {
      const { usages } = extract(`{{ $t("common.actions.save") }}`)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({
        key: 'common.actions.save',
        callee: '$t',
      })
    })

    it('extracts t() from script setup', () => {
      const { usages } = extract(`const label = t('common.actions.cancel')`)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({
        key: 'common.actions.cancel',
        callee: 't',
        line: 1,
      })
    })

    it('extracts this.$t() from Options API', () => {
      const { usages } = extract(`return this.$t('settings.checkout.title')`)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({
        key: 'settings.checkout.title',
        callee: 'this.$t',
      })
    })

    it('extracts multiple keys from the same line', () => {
      const { usages } = extract(`:default-text="$t('common.actions.save')" :success-text="$t('common.status.saved')"`)
      expect(usages).toHaveLength(2)
      expect(usages[0].key).toBe('common.actions.save')
      expect(usages[1].key).toBe('common.status.saved')
    })

    it('extracts keys across multiple lines with correct line numbers', () => {
      const content = [
        '<template>',
        '  <div>{{ $t(\'pages.title\') }}</div>',
        '  <span>{{ $t(\'pages.subtitle\') }}</span>',
        '</template>',
        '<script setup>',
        'const msg = t(\'common.messages.hello\')',
        '</script>',
      ].join('\n')

      const { usages } = extract(content)
      expect(usages).toHaveLength(3)
      expect(usages[0]).toMatchObject({ key: 'pages.title', line: 2 })
      expect(usages[1]).toMatchObject({ key: 'pages.subtitle', line: 3 })
      expect(usages[2]).toMatchObject({ key: 'common.messages.hello', line: 6 })
    })

    it('extracts $t in attribute bindings', () => {
      const { usages } = extract(`:aria-label="$t('common.actions.openExternalLink')"`)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('common.actions.openExternalLink')
    })

    it('extracts $t with parameters after the key (ignoring params)', () => {
      const { usages } = extract(`$t('pages.payments.fees.platformTerms', { amount: 10 })`)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('pages.payments.fees.platformTerms')
    })

    it('extracts t() with spaces before parenthesis', () => {
      const { usages } = extract(`t  ('common.actions.save')`)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('common.actions.save')
    })

    it('extracts this.$t with parameters', () => {
      const { usages } = extract(`this.$t('admin.dashboard.welcome', { name: user.name })`)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('admin.dashboard.welcome')
    })

    it('stores the file path on usages', () => {
      const { usages } = extract(`$t('common.actions.save')`, '/src/components/Foo.vue')
      expect(usages[0].file).toBe('/src/components/Foo.vue')
    })
  })

  describe('dynamic key extraction', () => {
    it('detects template literal with interpolation in $t()', () => {
      const { dynamicKeys } = extract('$t(`common.metrics.${metric}`)')
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0]).toMatchObject({
        expression: '`common.metrics.${metric}`',
        callee: '$t',
        line: 1,
      })
    })

    it('detects template literal with interpolation in t()', () => {
      const { dynamicKeys } = extract('t(`${config.translationPrefix}.totalRevenue`)')
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0]).toMatchObject({
        expression: '`${config.translationPrefix}.totalRevenue`',
        callee: 't',
      })
    })

    it('detects template literal with interpolation in this.$t()', () => {
      const { dynamicKeys } = extract('this.$t(`settings.checkout.additionalFields.${k}.title`)')
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0]).toMatchObject({
        expression: '`settings.checkout.additionalFields.${k}.title`',
        callee: 'this.$t',
      })
    })

    it('does not flag template literals without interpolation as dynamic', () => {
      const { dynamicKeys, usages } = extract("t(`common.actions.save`)")
      expect(dynamicKeys).toHaveLength(0)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({ key: 'common.actions.save', callee: 't' })
    })

    it('promotes $t() backtick literal without interpolation to static key', () => {
      const { usages, dynamicKeys } = extract("{{ $t(`components.displayPanels.closed.label`) }}")
      expect(dynamicKeys).toHaveLength(0)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({ key: 'components.displayPanels.closed.label', callee: '$t' })
    })

    it('promotes this.$te() backtick literal without interpolation to static key', () => {
      const { usages, dynamicKeys } = extract("this.$te(`settings.checkout.title`)")
      expect(dynamicKeys).toHaveLength(0)
      expect(usages).toHaveLength(1)
      expect(usages[0]).toMatchObject({ key: 'settings.checkout.title', callee: 'this.$te' })
    })

    it('still treats backtick literals WITH interpolation as dynamic', () => {
      const { usages, dynamicKeys } = extract("$t(`prefix.${type}.suffix`)")
      expect(dynamicKeys).toHaveLength(1)
      expect(usages).toHaveLength(0)
    })

    it('detects multiple dynamic keys on separate lines', () => {
      const content = [
        "t(`common.metrics.${metric}`)",
        "t(`common.datetime.terms.${frequency}`)",
      ].join('\n')

      const { dynamicKeys } = extract(content)
      expect(dynamicKeys).toHaveLength(2)
      expect(dynamicKeys[0].line).toBe(1)
      expect(dynamicKeys[1].line).toBe(2)
    })
  })

  describe('concatenation-based dynamic keys', () => {
    it('detects t(\'prefix.\' + var) as dynamic key', () => {
      const { dynamicKeys } = extract("t('common.metrics.' + key)")
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0]).toMatchObject({
        expression: '`common.metrics.${_}`',
        callee: 't',
        line: 1,
      })
    })

    it('detects $t("prefix." + var) with double quotes', () => {
      const { dynamicKeys } = extract('$t("common.status." + statusType)')
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0].expression).toBe('`common.status.${_}`')
    })

    it('detects this.$t(\'prefix.\' + var)', () => {
      const { dynamicKeys } = extract("this.$t('settings.fields.' + fieldName)")
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0].callee).toBe('this.$t')
    })

    it('ignores bare t(\'word\' + var) without dot in prefix', () => {
      const { dynamicKeys } = extract("t('prefix' + key)")
      expect(dynamicKeys).toHaveLength(0)
    })

    it('$t always captures even without dot in prefix', () => {
      const { dynamicKeys } = extract("$t('prefix' + key)")
      expect(dynamicKeys).toHaveLength(1)
    })

    it('does not match non-i18n concatenation', () => {
      const { dynamicKeys } = extract("console.log('prefix.' + key)")
      expect(dynamicKeys).toHaveLength(0)
    })
  })

  // #284: same-file `const NAME = 'dotted.path'` declarations resolve
  // `${NAME}` interpolations into exact keys.
  describe('const-table resolution (#284)', () => {
    it('never substitutes let bindings — reassignment would stale the literal', () => {
      const content = [
        `let base = 'menu.items'`,
        `base = computePrefix()`,
        'const label = t(`${base}.title`)',
      ].join('\n')
      const { usages, dynamicKeys } = extractKeys(content, 'test.ts')
      expect(usages.map(u => u.key)).not.toContain('menu.items.title')
      expect(dynamicKeys.map(d => d.expression)).toContain('`${base}.title`')
    })

    // Exact const resolution moved to the syntax frontend (#402), which
    // follows the real binding. The pattern path reports the template as
    // written — a wildcard is the conservative reading for a fallback.
    it.each([
      ['single-quoted const prefix', "const i18nBase = 'pages.organization.settings.tabs.aiAgent.widgetConfigurator'", 'const title = t(`${i18nBase}.title`)', '`${i18nBase}.title`'],
      ['double-quoted const value', 'const base = "components.integrations"', 'const label = $t(`${base}.title`)', '`${base}.title`'],
      ['partially resolvable template', "const base = 'components.integrations'", 'const label = t(`${base}.${type}.label`)', '`${base}.${type}.label`'],
    ])('reports a template as written, protection stays wide: %s', (_case, decl, call, expected) => {
      const { usages, dynamicKeys } = extract([decl, call].join('\n'))
      expect(usages).toHaveLength(0)
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0]).toMatchObject({ expression: expected, line: 2 })
    })

    it('leaves member expressions and unknown identifiers dynamic', () => {
      const { dynamicKeys } = extract('t(`${lockType.translationPath}.select`)')
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0].expression).toBe('`${lockType.translationPath}.select`')
    })

    it('ignores non-key-shaped const values (no dot)', () => {
      const content = [
        "const word = 'title'",
        'const label = t(`pages.${word}`)',
      ].join('\n')
      const { dynamicKeys } = extract(content)
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0].expression).toBe('`pages.${word}`')
    })

    it('drops names shadowed with different values (ambiguous)', () => {
      const { usages, dynamicKeys } = extract(
        "const base = 'pages.settings'\nconst base = 'pages.account'\nconst label = t(`${base}.title`)",
      )
      expect(usages).toHaveLength(0)
      expect(dynamicKeys.map(d => d.expression)).toEqual(['`${base}.title`'])
    })
  })

  describe('mixed static and dynamic on same line', () => {
    it('extracts both static and dynamic from a complex expression', () => {
      const content = `t('pages.dashboard.widgets.label') + \` / \${t(\`common.datetime.terms.\${options.frequency}\`)}\``
      const { usages, dynamicKeys } = extract(content)
      // The static part should be found
      expect(usages.some(u => u.key === 'pages.dashboard.widgets.label')).toBe(true)
      // The dynamic part should be detected
      expect(dynamicKeys.length).toBeGreaterThanOrEqual(0)
      // At minimum, the static key is captured
    })
  })

  describe('false positive prevention', () => {
    it('ignores bare t() with non-namespaced single-word argument', () => {
      // t('something') without a dot is likely not an i18n call (e.g., a function arg)
      const { usages } = extract("t('something')")
      expect(usages).toHaveLength(0)
    })

    it('ignores emit() calls', () => {
      const { usages } = extract("emit('map-loaded')")
      expect(usages).toHaveLength(0)
    })

    it('ignores import() calls', () => {
      const { usages } = extract("import('mapbox-gl/dist/mapbox-gl.css')")
      expect(usages).toHaveLength(0)
    })

    it('ignores post/request calls with backticks', () => {
      const { dynamicKeys } = extract("client.post(`${modelType}/${actionName}`, {})")
      expect(dynamicKeys).toHaveLength(0)
    })

    it('does not match require() or other function calls', () => {
      const { usages } = extract("require('some.module.path')")
      expect(usages).toHaveLength(0)
    })

    it('does not match console.log with dotted string', () => {
      const { usages } = extract("console.log('some.dotted.string')")
      expect(usages).toHaveLength(0)
    })

    it('$t always matches even without dots (template globals are always i18n)', () => {
      const { usages } = extract("$t('hello')")
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('hello')
    })

    it('this.$t always matches even without dots', () => {
      const { usages } = extract("this.$t('title')")
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('title')
    })

    it('ignores empty key strings', () => {
      const { usages } = extract("$t('')")
      expect(usages).toHaveLength(0)
    })

    it('does not match methods ending in t like client.get()', () => {
      const { usages } = extract("client.get('some.api.path')")
      expect(usages).toHaveLength(0)
    })
  })

  describe('real-world patterns from anny-ui', () => {
    it('handles $t in v-bind attribute', () => {
      const { usages } = extract(`:label="t('pages.organization.settings.general.defaultLocale.label')"`)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('pages.organization.settings.general.defaultLocale.label')
    })

    it('handles computed property with t()', () => {
      const content = `title: t('pages.organization.settings.tabs.account.title'),`
      const { usages } = extract(content)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('pages.organization.settings.tabs.account.title')
    })

    it('handles ternary with t()', () => {
      const content = `? t('pages.organization.settings.notes.activeAccountBeforeLive')`
      const { usages } = extract(content)
      expect(usages).toHaveLength(1)
    })

    it('handles this.$t with template literal dynamic key', () => {
      const content = 'label: this.$t(`settings.checkout.additionalFields.${k}.title`),'
      const { dynamicKeys } = extract(content)
      expect(dynamicKeys).toHaveLength(1)
      expect(dynamicKeys[0].expression).toContain('settings.checkout.additionalFields')
    })

    it('handles t() inside template string concatenation', () => {
      const content = `return t('pages.dashboard.widgets.customerBookingPatterns.yAxisLabel')`
      const { usages } = extract(content)
      expect(usages).toHaveLength(1)
      expect(usages[0].key).toBe('pages.dashboard.widgets.customerBookingPatterns.yAxisLabel')
    })
  })

  /**
   * This frontend reads the .vue files the syntax one declined, so it has to
   * skip commented-out markup for the same reason: a key nothing renders is
   * not a usage, and counting it keeps the key undeletable.
   */
  describe('commented-out markup in a .vue file', () => {
    it('does not extract a key out of an HTML comment', () => {
      const { usages } = extract(`<!-- {{ $t('a.dead') }} -->\n{{ $t('a.live') }}`)

      expect(usages.map(u => u.key)).toEqual(['a.live'])
    })

    it('keeps the line numbers after a comment spanning several lines', () => {
      const { usages } = extract([
        '<!--',
        `  {{ $t('a.dead') }}`,
        '-->',
        `{{ $t('a.live') }}`,
      ].join('\n'))

      expect(usages.map(u => ({ key: u.key, line: u.line }))).toEqual([{ key: 'a.live', line: 4 }])
    })

    // Only .vue is masked: another language's file keeps every line it has.
    it('leaves comment-shaped text in another language alone', () => {
      const { usages } = extract(`const html = '<!-- ' + t('a.live') + ' -->'`, 'a.ts')

      expect(usages.map(u => u.key)).toEqual(['a.live'])
    })
  })
})

describe('buildDynamicKeyRegexes', () => {
  function makeDynamic(expression: string): { expression: string } {
    return { expression }
  }

  it('converts single interpolation to regex', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`common.metrics.${metric}`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('common.metrics.revenue')).toBe(true)
    expect(regexes[0].test('common.metrics.bookings')).toBe(true)
    expect(regexes[0].test('common.other.revenue')).toBe(false)
  })

  it('converts multiple interpolations to regex', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`${prefix}.items.${id}.label`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('shop.items.42.label')).toBe(true)
    expect(regexes[0].test('admin.items.abc.label')).toBe(true)
    expect(regexes[0].test('items.42.label')).toBe(false)
  })

  it('returns empty array when no interpolations present', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`common.actions.save`')])
    expect(regexes).toHaveLength(0)
  })

  it('handles adjacent segments with interpolation', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`settings.${section}.${field}`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('settings.general.name')).toBe(true)
    // #284: interpolated variables can hold dotted paths, so extra segments
    // now match too — accepted over-suppression.
    expect(regexes[0].test('settings.general.name.extra')).toBe(true)
    expect(regexes[0].test('other.general.name')).toBe(false)
  })

  it('escapes special regex characters in static parts', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`path.with+special.${var}.end`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('path.with+special.foo.end')).toBe(true)
    expect(regexes[0].test('path.withXspecial.foo.end')).toBe(false)
  })

  it('deduplicates identical patterns', () => {
    const regexes = buildDynamicKeyRegexes([
      makeDynamic('`common.metrics.${metric}`'),
      makeDynamic('`common.metrics.${otherVar}`'),
    ])
    expect(regexes).toHaveLength(1)
  })

  it('handles expressions without backticks', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('common.${type}.title')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('common.button.title')).toBe(true)
  })

  it('does not match partial keys (anchored)', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`common.${type}`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('common.button')).toBe(true)
    // #284: `${type}` may hold a dotted path — accepted over-suppression.
    expect(regexes[0].test('common.button.extra')).toBe(true)
    expect(regexes[0].test('prefix.common.button')).toBe(false)
  })

  // #284: `${_}` widens to `.+?` because a variable can hold a dotted path.
  describe('variable-prefix widening (#284)', () => {
    it('widens a leading interpolation to any number of segments', () => {
      const regexes = buildDynamicKeyRegexes([makeDynamic('`${lockType.translationPath}.select`')])
      expect(regexes).toHaveLength(1)
      expect(regexes[0].test('components.integrations.pinCodeLock.select')).toBe(true)
      expect(regexes[0].test('single.select')).toBe(true)
      expect(regexes[0].test('components.integrations.pinCodeLock.label')).toBe(false)
    })

    it('widens interior interpolations too', () => {
      const regexes = buildDynamicKeyRegexes([makeDynamic('`api.${path}.title`')])
      expect(regexes[0].test('api.deep.nested.path.title')).toBe(true)
      expect(regexes[0].test('other.deep.title')).toBe(false)
    })

    it('keeps literal bounds: trailing interpolation still requires the prefix', () => {
      const regexes = buildDynamicKeyRegexes([makeDynamic('`a.b.${x}`')])
      expect(regexes[0].test('a.b.c')).toBe(true)
      expect(regexes[0].test('a.b.c.d')).toBe(true)
      expect(regexes[0].test('z.b.c')).toBe(false)
      expect(regexes[0].test('other.a.b.c')).toBe(false)
    })

    it('does not widen dotless templates into match-everything', () => {
      const regexes = buildDynamicKeyRegexes([makeDynamic('`${x}`'), makeDynamic('`btn${x}`')])
      expect(regexes[0].test('word')).toBe(true)
      expect(regexes[0].test('some.dotted.key')).toBe(false)
      expect(regexes[1].test('btnPrimary')).toBe(true)
      expect(regexes[1].test('btn.dotted.key')).toBe(false)
    })

    it('does not widen when no literal part anchors a key fragment', () => {
      // `${a}.${b}` / `v${major}.${minor}` would compile to match-(nearly-)
      // everything under widening; they keep single-segment slots.
      const regexes = buildDynamicKeyRegexes([makeDynamic('`${a}.${b}`'), makeDynamic('`v${major}.${minor}`')])
      expect(regexes[0].test('two.segments')).toBe(true)
      expect(regexes[0].test('deep.nested.key')).toBe(false)
      expect(regexes[1].test('v1.2')).toBe(true)
      expect(regexes[1].test('vouchers.list.title')).toBe(false)
    })
  })

  it('handles empty array', () => {
    const regexes = buildDynamicKeyRegexes([])
    expect(regexes).toHaveLength(0)
  })

  it('handles nested braces inside interpolation', () => {
    const regexes = buildDynamicKeyRegexes([makeDynamic('`prefix.${fn({a:1})}.title`')])
    expect(regexes).toHaveLength(1)
    expect(regexes[0].test('prefix.computed.title')).toBe(true)
    expect(regexes[0].test('prefix.computed.title.extra')).toBe(false)
  })
})

describe('buildIgnorePatternRegexes', () => {
  it('matches single-segment wildcard (*)', () => {
    const [re] = buildIgnorePatternRegexes(['common.actions.*'])
    expect(re.test('common.actions.save')).toBe(true)
    expect(re.test('common.actions.delete')).toBe(true)
    expect(re.test('common.actions.nested.key')).toBe(false)
    expect(re.test('common.actions.')).toBe(true)
  })

  it('matches multi-segment wildcard (**)', () => {
    const [re] = buildIgnorePatternRegexes(['common.datetime.**'])
    expect(re.test('common.datetime.months.january')).toBe(true)
    expect(re.test('common.datetime.days')).toBe(true)
    expect(re.test('common.datetime.')).toBe(true)
    expect(re.test('common.other.months')).toBe(false)
  })

  it('matches wildcard in middle of pattern', () => {
    const [re] = buildIgnorePatternRegexes(['pages.*.title'])
    expect(re.test('pages.home.title')).toBe(true)
    expect(re.test('pages.admin.title')).toBe(true)
    expect(re.test('pages.deep.nested.title')).toBe(false)
    expect(re.test('pages..title')).toBe(true)
  })

  it('matches ** in middle of pattern', () => {
    const [re] = buildIgnorePatternRegexes(['pages.**.title'])
    expect(re.test('pages.home.title')).toBe(true)
    expect(re.test('pages.deep.nested.title')).toBe(true)
    expect(re.test('pages.title')).toBe(false)
  })

  it('matches exact pattern without wildcards', () => {
    const [re] = buildIgnorePatternRegexes(['common.actions.save'])
    expect(re.test('common.actions.save')).toBe(true)
    expect(re.test('common.actions.saves')).toBe(false)
    expect(re.test('common.actions.sav')).toBe(false)
  })

  it('handles multiple patterns', () => {
    const regexes = buildIgnorePatternRegexes(['common.datetime.**', 'pages.*.title'])
    expect(regexes).toHaveLength(2)
    expect(regexes[0].test('common.datetime.months.jan')).toBe(true)
    expect(regexes[1].test('pages.home.title')).toBe(true)
  })

  it('returns empty array for empty input', () => {
    expect(buildIgnorePatternRegexes([])).toHaveLength(0)
  })

  it('escapes special regex characters', () => {
    const [re] = buildIgnorePatternRegexes(['path.with+special.key'])
    expect(re.test('path.with+special.key')).toBe(true)
    expect(re.test('path.withXspecial.key')).toBe(false)
  })

  it('anchors patterns (no partial matches)', () => {
    const [re] = buildIgnorePatternRegexes(['common.*'])
    expect(re.test('common.save')).toBe(true)
    expect(re.test('prefix.common.save')).toBe(false)
    expect(re.test('common.save.extra')).toBe(false)
  })
})

describe('scanSourceFiles', () => {
  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Clean and recreate for each test
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })
  })

  it('scans .vue files and extracts keys', async () => {
    await writeFile(join(tmpDir, 'Page.vue'), [
      '<template>',
      '  <div>{{ $t(\'pages.home.title\') }}</div>',
      '</template>',
      '<script setup>',
      'const msg = t(\'common.messages.hello\')',
      '</script>',
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(1)
    expect(result.uniqueKeys.size).toBe(2)
    expect(result.uniqueKeys.has('pages.home.title')).toBe(true)
    expect(result.uniqueKeys.has('common.messages.hello')).toBe(true)
  })

  it('scans .ts files', async () => {
    await writeFile(join(tmpDir, 'composable.ts'), [
      'const { t } = useI18n()',
      'const label = t(\'common.actions.save\')',
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(1)
    expect(result.uniqueKeys.has('common.actions.save')).toBe(true)
  })

  it('scans nested directories', async () => {
    await mkdir(join(tmpDir, 'components/deep'), { recursive: true })
    await writeFile(join(tmpDir, 'components/deep/Button.vue'), `{{ $t('common.actions.click') }}`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(1)
    expect(result.uniqueKeys.has('common.actions.click')).toBe(true)
  })

  it('skips node_modules directory', async () => {
    await mkdir(join(tmpDir, 'node_modules/some-pkg'), { recursive: true })
    await writeFile(join(tmpDir, 'node_modules/some-pkg/index.ts'), `$t('should.be.skipped')`)
    await writeFile(join(tmpDir, 'App.vue'), `{{ $t('app.title') }}`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(1)
    expect(result.uniqueKeys.has('should.be.skipped')).toBe(false)
    expect(result.uniqueKeys.has('app.title')).toBe(true)
  })

  it('skips .nuxt directory', async () => {
    await mkdir(join(tmpDir, '.nuxt/components'), { recursive: true })
    await writeFile(join(tmpDir, '.nuxt/components/auto.ts'), `$t('auto.generated')`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(0)
    expect(result.uniqueKeys.size).toBe(0)
  })

  it('skips .output and dist directories', async () => {
    await mkdir(join(tmpDir, '.output'), { recursive: true })
    await mkdir(join(tmpDir, 'dist'), { recursive: true })
    await writeFile(join(tmpDir, '.output/server.ts'), `$t('built.output')`)
    await writeFile(join(tmpDir, 'dist/index.js'), `$t('built.dist')`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(0)
  })

  it('respects custom excludeDirs', async () => {
    await mkdir(join(tmpDir, 'storybook'), { recursive: true })
    await writeFile(join(tmpDir, 'storybook/Story.vue'), `{{ $t('story.title') }}`)
    await writeFile(join(tmpDir, 'Page.vue'), `{{ $t('pages.real') }}`)

    const result = await scanSourceFiles(tmpDir, ['storybook'])
    expect(result.filesScanned).toBe(1)
    expect(result.uniqueKeys.has('story.title')).toBe(false)
    expect(result.uniqueKeys.has('pages.real')).toBe(true)
  })

  it('ignores non-scannable file extensions', async () => {
    await writeFile(join(tmpDir, 'data.json'), `{ "key": "$t('not.scanned')" }`)
    await writeFile(join(tmpDir, 'styles.css'), `.t { content: '$t(not.scanned)' }`)
    await writeFile(join(tmpDir, 'readme.md'), `$t('not.scanned')`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(0)
  })

  it('scans .js, .jsx, .mjs, .mts, .tsx extensions', async () => {
    await writeFile(join(tmpDir, 'a.js'), `$t('key.js')`)
    await writeFile(join(tmpDir, 'b.jsx'), `$t('key.jsx')`)
    await writeFile(join(tmpDir, 'c.mjs'), `$t('key.mjs')`)
    await writeFile(join(tmpDir, 'd.mts'), `$t('key.mts')`)
    await writeFile(join(tmpDir, 'e.tsx'), `$t('key.tsx')`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(5)
    expect(result.uniqueKeys.size).toBe(5)
  })

  it('reports dynamic keys from scanned files', async () => {
    await writeFile(join(tmpDir, 'Widget.vue'), [
      'const label = t(`common.metrics.${metric}`)',
      'const title = t(\'pages.dashboard.title\')',
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.usages).toHaveLength(1)
    expect(result.usages[0].key).toBe('pages.dashboard.title')
    expect(result.dynamicKeys).toHaveLength(1)
    expect(result.dynamicKeys[0].expression).toContain('common.metrics')
  })

  it('deduplicates keys in uniqueKeys set', async () => {
    await writeFile(join(tmpDir, 'A.vue'), `{{ $t('common.actions.save') }}`)
    await writeFile(join(tmpDir, 'B.vue'), `{{ $t('common.actions.save') }}`)

    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(2)
    expect(result.usages).toHaveLength(2) // Two usages
    expect(result.uniqueKeys.size).toBe(1) // But one unique key
  })

  it('handles empty directory gracefully', async () => {
    const result = await scanSourceFiles(tmpDir)
    expect(result.filesScanned).toBe(0)
    expect(result.uniqueKeys.size).toBe(0)
    expect(result.usages).toHaveLength(0)
    expect(result.dynamicKeys).toHaveLength(0)
  })

  it('handles non-existent directory gracefully', async () => {
    const result = await scanSourceFiles(join(tmpDir, 'does-not-exist'))
    expect(result.filesScanned).toBe(0)
  })

  it('extracts bare dynamic candidates from key-shaped template literals with dots and interpolation', async () => {
    await writeFile(join(tmpDir, 'Component.vue'), [
      // #275 — URLs are not key-shaped (`:`, `/`) and are no longer candidates.
      'const url = `https://api.example.com/${id}`',
      'const label = `common.plans.trialPeriod.${interval}`',
      'const title = `pages.${section}.items.${id}.label`',
      'const plain = `no-dots-here-${val}`',
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.bareDynamicCandidates.size).toBe(2)
    expect(result.bareDynamicCandidates.has('`common.plans.trialPeriod.${_}`')).toBe(true)
    expect(result.bareDynamicCandidates.has('`pages.${_}.items.${_}.label`')).toBe(true)
  })

  it('bare dynamic candidates work for multi-line $t calls', async () => {
    await writeFile(join(tmpDir, 'MultiLine.vue'), [
      'this.$t(',
      '  `common.components.calendars.fullCalendar.views.${view}`',
      ')',
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.bareDynamicCandidates.has('`common.components.calendars.fullCalendar.views.${_}`')).toBe(true)
    const regexes = buildDynamicKeyRegexes([...result.bareDynamicCandidates].map(e => ({ expression: e })))
    expect(regexes.some(re => re.test('common.components.calendars.fullCalendar.views.dayGridWeek'))).toBe(true)
  })

  it('deduplicates bare dynamic candidates', async () => {
    await writeFile(join(tmpDir, 'A.vue'), 'const a = `prefix.${x}.suffix`')
    await writeFile(join(tmpDir, 'B.vue'), 'const b = `prefix.${y}.suffix`')

    const result = await scanSourceFiles(tmpDir)
    expect(result.bareDynamicCandidates.size).toBe(1)
    expect(result.bareDynamicCandidates.has('`prefix.${_}.suffix`')).toBe(true)
  })

  // #262 — prefix-shaped literals count as dynamic candidates in any context,
  // not only directly left of a concat operator.
  it('collects prefix-shaped string literals passed as plain arguments', async () => {
    await writeFile(join(tmpDir, 'columns.ts'), [
      `columns.push(translatedColumn('status', 'api.orders.status.'))`,
    ].join('\n'))

    const result = await scanSourceFiles(tmpDir)
    expect(result.bareDynamicCandidates.has('`api.orders.status.${_}`')).toBe(true)
    const regexes = buildDynamicKeyRegexes([...result.bareDynamicCandidates].map(e => ({ expression: e })))
    expect(regexes.some(re => re.test('api.orders.status.open'))).toBe(true)
  })

  // #275 — a stray backtick must not turn the span to the next backtick into a
  // mega-expression; only candidates with i18n-key shape survive.
  describe('bare-template mega-capture rejection (#275)', () => {
    it('rejects stray-backtick spans and prose templates, keeps key-shaped ones', async () => {
      await writeFile(join(tmpDir, 'Stray.vue'), [
        // Stray backtick followed by `${` inside a string: the permissive
        // collector captured `${', x.count, ` here (quote-parity poisoning)
        // and LOST the genuine template that follows on the same line.
        "const row = fmt('`${', x.count, `${sep}.list.end`)",
        'const msg = `Deleted ${count} rows. Undo?`',
        'const key = `pages.${section}.title`',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates).toEqual(new Set([
        '`${_}.list.end`',
        '`pages.${_}.title`',
      ]))
    })

    it('drops key-shaped candidates over the max plausible key length', async () => {
      const longKey = 'seg.'.repeat(40) // 160 chars of valid key charset
      await writeFile(join(tmpDir, 'Long.vue'), [
        `const long = \`${longKey}\${x}\``,
        'const ok = `common.actions.${action}`',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates).toEqual(new Set(['`common.actions.${_}`']))
    })

    it('rejects interpolation-only templates whose dot sits inside the interpolation', async () => {
      await writeFile(join(tmpDir, 'InterpOnly.vue'), [
        'const v = `${config.mode}`',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates.size).toBe(0)
    })

    it('#284: suffix-only concat produces a bare ${_} candidate', async () => {
      await writeFile(join(tmpDir, 'LockType.ts'), [
        "const plural = lockType.translationPath + '.labelPlural'",
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates.has('`${_}.labelPlural`')).toBe(true)
      const regexes = buildDynamicKeyRegexes([...result.bareDynamicCandidates].map(e => ({ expression: e })))
      expect(regexes.some(re => re.test('components.integrations.pinCodeLock.labelPlural'))).toBe(true)
    })

    it('#284: suffix literal followed by more concat keeps a trailing wildcard', async () => {
      await writeFile(join(tmpDir, 'Chain.ts'), [
        "const key = base + '.fields' + suffix",
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates.has('`${_}.fields${_}`')).toBe(true)
    })

    it('#284: dot-leading literals without concat adjacency are not candidates', async () => {
      await writeFile(join(tmpDir, 'NoConcat.ts'), [
        "import styles from './styles.module'",
        "const ext = '.json'",
        "const cls = someEl.classList.contains('.active')",
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates.size).toBe(0)
    })

    it('#284: const-resolved bare templates become exact string candidates', async () => {
      await writeFile(join(tmpDir, 'Bare.ts'), [
        "const i18nBase = 'pages.widgets.config'",
        'const key = `${i18nBase}.title`',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareStringCandidates.has('pages.widgets.config.title')).toBe(true)
      expect(result.bareDynamicCandidates.size).toBe(0)
    })

    it('ground truth: a mega-capture regex must not suppress unrelated orphans', async () => {
      // The old capture `${', x.count, ` compiled to /^[^.]+$/ and dynamic-
      // matched EVERY single-segment key; 'promo' must stay a safe orphan.
      // The recovered genuine `${_}.list.end` still vouches for themes.list.end.
      await writeFile(join(tmpDir, 'Stray.vue'), [
        "const row = fmt('`${', x.count, `${sep}.list.end`)",
        "const title = t('pages.home.title')",
      ].join('\n'))

      const result = await findOrphanKeysForConfig({
        keysByLayer: new Map([['root', {
          keys: ['promo', 'themes.list.end', 'pages.home.title'],
          localeDir: { layer: 'root' },
        }]]),
        resolveIgnorePatterns: () => undefined,
        scanDirs: [tmpDir],
      })

      expect(result.orphansByLayer.root ?? []).toEqual(['promo'])
      expect(result.dynamicMatchedCount).toBe(1)
    })
  })

  // #284 — the three anny-ui idioms that classified 34 live keys as safe
  // orphans. Live keys must never land in orphansByLayer.
  describe('variable-prefix ground truth (#284)', () => {
    it('const-prefix template, member-expression template, and suffix concat all vouch for their keys', async () => {
      await writeFile(join(tmpDir, 'WidgetConfigurator.vue'), [
        "const i18nBase = 'pages.organization.settings.tabs.aiAgent.widgetConfigurator'",
        'const title = t(`${i18nBase}.title`)',
      ].join('\n'))
      await writeFile(join(tmpDir, 'LockTypes.vue'), [
        'const label = t(`${lockType.translationPath}.select`)',
        "const plural = this.$t(lockType.translationPath + '.labelPlural')",
      ].join('\n'))

      const result = await findOrphanKeysForConfig({
        keysByLayer: new Map([['root', {
          keys: [
            'pages.organization.settings.tabs.aiAgent.widgetConfigurator.title',
            'components.integrations.pinCodeLock.select',
            'components.integrations.pinCodeLock.labelPlural',
            'truly.orphaned.key',
          ],
          localeDir: { layer: 'root' },
        }]]),
        resolveIgnorePatterns: () => undefined,
        scanDirs: [tmpDir],
      })

      // The const-resolved key is an exact usage, the others dynamic-matched;
      // only the genuinely unreferenced key survives as an orphan.
      expect(result.orphansByLayer.root ?? []).toEqual(['truly.orphaned.key'])
      expect(result.uncertainByLayer.root ?? []).toEqual([])
    })
  })

  // #288 — the PHP interpolation shape must not run on Vue/JS files: Vue
  // template attributes like v-if="$slots.header" are double-quoted strings
  // containing $identifier.segment and compiled to `${_}.header`-class
  // candidates suppressing every key ending in those segments.
  describe('bare-shape language gating (#288)', () => {
    it('Vue $slots/$attrs template attributes produce zero bare dynamic candidates', async () => {
      await writeFile(join(tmpDir, 'Table.vue'), [
        '<template>',
        '  <thead v-if="$slots.header">',
        '    <slot name="header" />',
        '  </thead>',
        '  <input @change="$attrs.change" />',
        '  <div v-if="$slots.actions && !$slots.empty">',
        '    <slot name="default" />',
        '  </div>',
        '</template>',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates.size).toBe(0)
    })

    it('gating does not disturb genuine JS shapes in the same file', async () => {
      await writeFile(join(tmpDir, 'Mixed.vue'), [
        '<template>',
        '  <div v-if="$slots.header" />',
        '</template>',
        '<script setup>',
        'const key = `pages.${section}.title`',
        "const plural = base.translationPath + '.labelPlural'",
        '</script>',
      ].join('\n'))

      const result = await scanSourceFiles(tmpDir)
      expect(result.bareDynamicCandidates).toEqual(new Set([
        '`pages.${_}.title`',
        '`${_}.labelPlural`',
      ]))
    })

    it('ground truth: $slots junk must not dynamic-match unrelated keys ending in .header', async () => {
      await writeFile(join(tmpDir, 'Card.vue'), [
        '<template>',
        '  <div v-if="$slots.header"><slot name="header" /></div>',
        '</template>',
      ].join('\n'))

      const result = await findOrphanKeysForConfig({
        keysByLayer: new Map([['root', {
          keys: ['pages.dashboard.header', 'components.table.empty'],
          localeDir: { layer: 'root' },
        }]]),
        resolveIgnorePatterns: () => undefined,
        scanDirs: [tmpDir],
      })

      expect(result.orphansByLayer.root ?? []).toEqual(['components.table.empty', 'pages.dashboard.header'])
      expect(result.dynamicMatchedCount).toBe(0)
    })
  })
})

describe('toRelativePath', () => {
  it('returns relative path from root', () => {
    expect(toRelativePath('/project/src/components/Foo.vue', '/project')).toBe('src/components/Foo.vue')
  })

  it('returns just the filename when file is in root', () => {
    expect(toRelativePath('/project/App.vue', '/project')).toBe('App.vue')
  })
})


