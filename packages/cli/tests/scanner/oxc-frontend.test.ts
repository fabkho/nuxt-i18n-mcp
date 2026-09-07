import { describe, expect, it } from 'vitest'

import { createOxcFrontend } from '../../src/scanner/frontends/oxc.js'
import { interpret, ambiguousCalleeNeedsDot } from '../../src/scanner/rules.js'

/**
 * The AST frontend (#332). It exists to answer the one question a regex
 * cannot: is this `t` the translation function, or someone's `emit`?
 *
 * Tests go through the frontend and the rules together, because neither means
 * anything alone — the frontend reports what it saw, the rules decide what it
 * means, and the seam between them is what makes a language pluggable.
 */

const frontend = createOxcFrontend()

async function scan(source: string, filePath = 'a.ts') {
  const sites = await frontend.read(source, filePath)
  if (!sites) return null

  return interpret(sites, { filePath, ambiguousCalleeNeedsDot })
}

/** Not a usage, but net-protected — the #298 posture for ambiguity. */
function expectProtectedOnly(evidence: Awaited<ReturnType<typeof scan>>, key: string) {
  expect(evidence?.usages).toEqual([])
  expect(evidence?.bareStringCandidates.has(key)).toBe(true)
}

describe('resolving what t is bound to', () => {
  // The #298 case. A regex has to guess from the dot; this knows.
  it('counts a dotless key as used when t came from useI18n', async () => {
    const evidence = await scan(`
      import { useI18n } from 'vue-i18n'
      const { t } = useI18n()
      const label = t('save')
    `)

    expect(evidence?.usages.map(u => u.key)).toEqual(['save'])
    expect(evidence?.bareStringCandidates.has('save')).toBe(false)
  })

  it('does not count a dotless key from a t it cannot place', async () => {
    // Protected rather than dropped: a key of that name still exists (#298).
    expectProtectedOnly(await scan(`const label = t('save')`), 'save')
  })

  it('ignores a call that is not a translation, however its argument looks', async () => {
    const evidence = await scan(`
      const client = axios.get('/api/v1.0/bookings')
      const mod = require('node:fs.promises')
    `)

    expect(evidence?.usages).toEqual([])
  })

  it('does not let a local t vouch for an unrelated member call', async () => {
    // `client.t` shares a property name with the binding, nothing more.
    expectProtectedOnly(await scan(`
      import { useI18n } from 'vue-i18n'
      const { t } = useI18n()
      client.t('save')
    `), 'save')
  })

  it('resolves t on a receiver that is itself an i18n binding', async () => {
    const evidence = await scan(`
      import { useI18n } from 'vue-i18n'
      const i18n = useI18n()
      const label = i18n.t('save')
    `)

    expect(evidence?.usages.map(u => u.key)).toEqual(['save'])
  })

  it('treats $t as resolved on any receiver', async () => {
    const evidence = await scan(`const label = this.$t('save')`)

    expect(evidence?.usages.map(u => u.key)).toEqual(['save'])
  })

  it('follows a factory imported under another name', async () => {
    const evidence = await scan(`
      import { useI18n as useTranslations } from 'vue-i18n'
      const { t: translate } = useTranslations()
      const label = translate('save')
    `)

    expect(evidence?.usages.map(u => u.key)).toEqual(['save'])
  })
})

describe('reading the argument', () => {
  it('resolves a template built from a constant into the key it names', async () => {
    const evidence = await scan(`
      const base = 'pages.settings'
      const label = t(\`\${base}.title\`)
    `)

    expect(evidence?.usages.map(u => u.key)).toEqual(['pages.settings.title'])
    expect(evidence?.dynamicKeys).toEqual([])
  })

  it('does not resolve a template through a name bound to two values', async () => {
    const evidence = await scan(`
      function a() { const base = 'pages.settings'; return t(\`\${base}.title\`) }
      function b() { const base = 'pages.profile'; return t(\`\${base}.title\`) }
    `)

    // Name-keyed collection cannot tell the scopes apart, so neither call may
    // claim a static key — both stay dynamic.
    expect(evidence?.usages).toEqual([])
    expect(evidence?.dynamicKeys).toHaveLength(2)
  })

  it('reports a template it cannot resolve as a dynamic key, spelled as written', async () => {
    const evidence = await scan('const label = t(`common.metrics.${metric}`)')

    expect(evidence?.usages).toEqual([])
    // The original interpolation text, not a normalised slot: reports must be
    // byte-identical with the pattern scanner's for unchanged code.
    expect(evidence?.dynamicKeys[0]?.expression).toBe('`common.metrics.${metric}`')
  })

  it('bounds a concatenation by its literal prefix', async () => {
    const evidence = await scan("const label = t('common.actions.' + name)")

    expect(evidence?.dynamicKeys[0]?.expression).toBe('`common.actions.${_}`')
  })

  it('reports nothing for an argument it cannot read', async () => {
    const evidence = await scan('const label = t(someKey)')

    expect(evidence?.usages).toEqual([])
    expect(evidence?.dynamicKeys).toEqual([])
  })

  it('treats a backtick string with no slots as a plain key', async () => {
    const evidence = await scan('const label = t(`common.save`)')

    expect(evidence?.usages.map(u => u.key)).toEqual(['common.save'])
  })
})

describe('Vue single-file components', () => {
  it('finds keys in the template as well as the script', async () => {
    const evidence = await scan(
      `<template><p>{{ $t('common.hello') }}</p></template>\n`
      + `<script setup>const label = $t('common.bye')</script>`,
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key).sort()).toEqual(['common.bye', 'common.hello'])
  })

  // An SFC is one scope split across blocks: the template uses what the script
  // declared, and collecting per block leaves the template's keys unresolvable.
  it('resolves a template key from a constant declared in the script', async () => {
    const evidence = await scan(
      `<template><p>{{ t(\`\${base}.title\`) }}</p></template>\n`
      + `<script setup>\nimport { useI18n } from 'vue-i18n'\nconst { t } = useI18n()\nconst base = 'pages.settings'\n</script>`,
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key)).toContain('pages.settings.title')
  })

  it('reads a single-quoted attribute binding', async () => {
    const evidence = await scan(
      `<template><Btn :label='$t("a.b")' /></template>`,
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key)).toEqual(['a.b'])
  })

  it('does not let one block\'s constant resolve through another\'s', async () => {
    const evidence = await scan(
      `<template><p>{{ t(\`\${base}.title\`) }}</p></template>\n`
      + `<script>const base = 'pages.profile'</script>\n`
      + `<script setup>\nimport { useI18n } from 'vue-i18n'\nconst { t } = useI18n()\nconst base = 'pages.settings'\n</script>`,
      'A.vue',
    )

    expect(evidence?.usages).toEqual([])
    expect(evidence?.dynamicKeys[0]?.expression).toBe('`\${base}.title`')
  })

  it('reports the line a key was used on, not the line of its block', async () => {
    const evidence = await scan(
      `<template>\n  <p>{{ $t('a.b') }}</p>\n</template>\n<script setup>\n\nconst x = $t('c.d')\n</script>`,
      'A.vue',
    )

    const cd = evidence?.usages.find(u => u.key === 'c.d')
    expect(cd?.line).toBe(6)
  })

  it('keeps lines right when the opening tag spans several lines', async () => {
    const evidence = await scan(
      `<script\n  setup\n  lang="ts"\n>\nconst x = $t('c.d')\n</script>`,
      'A.vue',
    )

    expect(evidence?.usages.find(u => u.key === 'c.d')?.line).toBe(5)
  })
})

/**
 * The template regex reads the whole SFC, so everything in it that is not
 * template has to be taken out first. Commented-out markup is the case that
 * costs: counted as a usage it keeps a dead key alive forever, and under
 * `check --write` it writes keys back out of code nobody runs.
 */
describe('what is not template', () => {
  it('does not read a key out of an HTML comment', async () => {
    const evidence = await scan(
      `<template>\n  <p>{{ $t('a.live') }}</p>\n  <!-- <div :title="$t('a.dead')" /> -->\n</template>`,
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key)).toEqual(['a.live'])
  })

  it('does not read a key out of a style block', async () => {
    const evidence = await scan(
      `<template><p>{{ $t('a.live') }}</p></template>\n<style>/* :label="$t('a.styled')" */</style>`,
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key)).toEqual(['a.live'])
  })

  // Masking keeps every newline, so removing a comment cannot shift what
  // follows it onto another line.
  it('reports the real line of a usage that follows a comment several lines long', async () => {
    const evidence = await scan(
      [
        '<template>',
        '  <!--',
        `    <div :title="$t('a.dead')" />`,
        '  -->',
        `  <p>{{ $t('a.live') }}</p>`,
        '</template>',
      ].join('\n'),
      'A.vue',
    )

    expect(evidence?.usages.map(u => ({ key: u.key, line: u.line }))).toEqual([{ key: 'a.live', line: 5 }])
  })

  // A script is masked whole, so a `<!--` in one of its strings never opens a
  // comment that would swallow the template after it. The script block itself
  // is read from the unmasked source and must still report its key.
  it('leaves a script block alone when a string in it looks like a comment', async () => {
    const evidence = await scan(
      [
        '<script setup>',
        `const raw = '<!-- placeholder -->'`,
        `const label = $t('a.script')`,
        '</script>',
        `<template><p>{{ $t('a.template') }}</p></template>`,
      ].join('\n'),
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key).sort()).toEqual(['a.script', 'a.template'])
  })

  it('reads a nested template block, which is template like its parent', async () => {
    const evidence = await scan(
      [
        '<template>',
        '  <Table>',
        '    <template #default>',
        `      <span>{{ $t('a.cell') }}</span>`,
        '    </template>',
        '  </Table>',
        '</template>',
      ].join('\n'),
      'A.vue',
    )

    expect(evidence?.usages.map(u => u.key)).toEqual(['a.cell'])
  })
})

describe('declining a file', () => {
  // Declining sends the file to the pattern matcher. Returning nothing would
  // silently drop every key it contains, which is the direction that deletes
  // someone's translations.
  it('declines a file it cannot parse rather than reporting it as empty', async () => {
    expect(await frontend.read('const = = =', 'broken.ts')).toBeNull()
  })

  it('declines a .vue file with neither a template nor a script tag', async () => {
    // Not an SFC at all — bare statements the block splitter cannot see into.
    // Declining hands the whole file to the fallback; reading only fragments
    // would silently drop the keys outside them.
    const sites = await frontend.read(
      `{{ $t('a.b') }}
const label = t(\`admin.dyn.\${variant}\`)`,
      'A.vue',
    )

    expect(sites).toBeNull()
  })

  it('declines an SFC with no block it recognises', async () => {
    expect(await frontend.read("const label = t('a.b')", 'odd.vue')).toBeNull()
  })

  it('reads only the languages it claims', () => {
    expect(frontend.handles('a.ts')).toBe(true)
    expect(frontend.handles('a.tsx')).toBe(true)
    expect(frontend.handles('a.js')).toBe(true)
    expect(frontend.handles('a.jsx')).toBe(true)
    expect(frontend.handles('a.vue')).toBe(true)
    expect(frontend.handles('a.php')).toBe(false)
    expect(frontend.handles('a.blade.php')).toBe(false)
  })
})
