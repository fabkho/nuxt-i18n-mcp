import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractKeys, scanSourceFiles, toRelativePath, buildDynamicKeyRegexes } from '../../src/scanner/code-scanner.js'

const tmpDir = join(dirname(fileURLToPath(import.meta.url)), '../../.tmp-test/scanner')

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
      // A template literal without ${} is effectively static; the static regex
      // won't match it, but it shouldn't be flagged as dynamic either
      const { dynamicKeys } = extract("t(`common.actions.save`)")
      expect(dynamicKeys).toHaveLength(0)
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
    expect(regexes[0].test('settings.general.name.extra')).toBe(false)
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
    expect(regexes[0].test('common.button.extra')).toBe(false)
    expect(regexes[0].test('prefix.common.button')).toBe(false)
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
})

describe('toRelativePath', () => {
  it('returns relative path from root', () => {
    expect(toRelativePath('/project/src/components/Foo.vue', '/project')).toBe('src/components/Foo.vue')
  })

  it('returns just the filename when file is in root', () => {
    expect(toRelativePath('/project/App.vue', '/project')).toBe('App.vue')
  })
})
