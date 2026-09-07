import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server'
import type { McpHttpHandler, McpServer } from '@modelcontextprotocol/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { clearConfigCache, descriptors, outputSchema } from '@the-i18n-kit/cli'
import type { TranslateFn } from '@the-i18n-kit/cli'

/**
 * Transport-level tests: a linked client/server pair over the SDK's in-memory
 * transport, against a real temp project resolved by the CLI's generic
 * adapter. Covers both translation modes: agent (no backend configured) and
 * provider (a TranslateFn injected through the test-only createServer seam).
 *
 * Dual-era coverage drives createMcpHandler in-process through its fetch
 * function (the SDK's documented no-socket seam for 2026-07-28 behavior);
 * InMemoryTransport pairs connect 2025-era instances only. The production
 * stdio entry (serveStdio) pins the era per connection from the same
 * createServer factory exercised here.
 */

let projectDir: string
let client: Client

async function makeProject(extraConfig: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-mcp-test-'))
  const localesDir = join(dir, 'i18n', 'locales')
  await mkdir(localesDir, { recursive: true })
  await writeFile(join(dir, '.i18n-mcp.json'), JSON.stringify({
    localeDirs: [{ path: 'i18n/locales', layer: 'root' }],
    defaultLocale: 'de',
    locales: ['de', 'en'],
    ...extraConfig,
  }))
  await writeFile(join(localesDir, 'de.json'), JSON.stringify({
    greeting: 'Hallo {name}',
    actions: { save: 'Speichern' },
  }))
  await writeFile(join(localesDir, 'en.json'), '{}\n')
  return dir
}

async function connectClient(server: McpServer): Promise<Client> {
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    c.connect(clientTransport),
  ])
  return c
}

async function callToolOn(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string, text: string }>)[0]?.text ?? ''
  return { result, json: result.isError ? undefined : JSON.parse(text) as Record<string, any>, text }
}

async function callTool(name: string, args: Record<string, unknown>) {
  return callToolOn(client, name, args)
}

/**
 * The schema the server advertises for a tool, built from the same descriptor
 * the tool was registered from. Nothing is transcribed here: a tool whose
 * result stopped matching its declaration fails against the declaration.
 */
const OUTPUT_SCHEMAS = new Map(
  descriptors
    .filter(descriptor => descriptor.mcp !== null)
    .map(descriptor => [descriptor.mcp?.name ?? '', outputSchema(descriptor)] as const),
)

/**
 * Assert a call answered with a typed result its advertised schema accepts.
 *
 * The SDK validates `structuredContent` itself and turns a failure into a tool
 * error, so this is belt and braces — but it is the half that names the field
 * that drifted, and it fails on a missing structured result rather than on the
 * error text that follows from one.
 */
function expectStructured(name: string, result: { structuredContent?: unknown }): Record<string, unknown> {
  expect(result.structuredContent, `${name} returned no structuredContent`).toBeDefined()
  const parsed = OUTPUT_SCHEMAS.get(name)?.safeParse(result.structuredContent)
  expect(parsed?.success, `${name}: ${JSON.stringify(parsed?.error?.issues, null, 2)}`).toBe(true)
  return result.structuredContent as Record<string, unknown>
}

/** A well-behaved fake backend: translates every key in the request batch. */
const fakeTranslateFn: TranslateFn = async ({ userMessage }) => {
  const line = userMessage.split('\n').find(l => l.trimStart().startsWith('{"'))
  if (!line) throw new Error(`No batch JSON found in user message:\n${userMessage}`)
  const batch = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)) as Record<string, string>
  const out = Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, `[t] ${v}`]))
  return { text: JSON.stringify(out), model: 'fake-model' }
}

beforeAll(async () => {
  projectDir = await makeProject()

  // Guard against provider config leaking in from the host environment —
  // this file's default client must run in agent mode.
  delete process.env.I18N_PROVIDER
  delete process.env.I18N_MODEL

  // The server captures its default project dir from the environment at
  // module load — set it before importing so resources can self-resolve.
  process.env.I18N_PROJECT_DIR = projectDir
  const { createServer } = await import('../src/server.js')
  client = await connectClient(await createServer())
})

afterAll(async () => {
  await client.close()
  await rm(projectDir, { recursive: true, force: true })
})

describe('the-i18n-mcp server over in-memory transport', () => {
  it('lists all registered tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()

    expect(names).toEqual([
      'discover',
      'find_duplicate_keys',
      'find_orphan_keys',
      'find_undefined_keys',
      'get_missing_translations',
      'get_translation_status',
      'get_translations',
      'list_namespaces',
      'move_translation_key',
      'remove_translations',
      'scaffold_locale',
      'search_translations',
      'translate_key',
      'translate_missing',
      'write_translations',
    ])
  })

  /**
   * Every advertised tool, called through the transport with the smallest
   * argument set its schema accepts.
   *
   * Most of the suite below drives the tools whose behaviour is interesting,
   * which left a third of the surface advertised but never once invoked — a
   * handler that throws on its own happy path would ship. Each case gets its
   * own project so the mutating ones cannot decide what the next one sees.
   */
  const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
    'discover': {},
    'list_namespaces': {},
    'get_translations': { layer: 'root', locale: 'de', keys: ['greeting'] },
    'write_translations': { layer: 'root', translations: { 'actions.undo': { de: 'Rückgängig' } } },
    'get_missing_translations': {},
    'get_translation_status': {},
    'search_translations': { query: 'Hallo' },
    'remove_translations': { layer: 'root', keys: ['actions.save'] },
    'move_translation_key': { layer: 'root', key: 'greeting', newKey: 'common.greeting' },
    'translate_missing': {},
    'translate_key': { layer: 'root', key: 'greeting', sourceLocale: 'de' },
    'find_undefined_keys': {},
    'find_orphan_keys': {},
    'find_duplicate_keys': {},
    'scaffold_locale': {},
  }

  it('advertises no tool the smoke table has forgotten', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(Object.keys(MINIMAL_ARGS).sort())
  })

  it.each(Object.entries(MINIMAL_ARGS))('%s answers a minimal call', async (name, args) => {
    const dir = await makeProject()
    try {
      const { result, text } = await callTool(name, { ...args, projectDir: dir })
      expect(result.isError, `${name}: ${text}`).not.toBe(true)
      // Both are sent — the typed result for a host that reads structured data,
      // the text for one that reads only content — and they say the same thing.
      expect(expectStructured(name, result)).toEqual(JSON.parse(text))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The diverted answer is the other half of what a reporting tool can return,
   * and the SDK rejects a structured result its schema does not cover — so a
   * union that forgot the stand-in would fail every diverted call.
   */
  it.each(descriptors
    .filter(descriptor => descriptor.mcp !== null && descriptor.report !== undefined)
    .map(descriptor => descriptor.mcp?.name ?? ''))(
    '%s returns a typed summary when the result is diverted to a file',
    async (name) => {
      const dir = await makeProject()
      try {
        const outputFile = join(dir, 'report.json')
        const { result, text } = await callTool(name, { ...MINIMAL_ARGS[name], projectDir: dir, outputFile })

        expect(result.isError, `${name}: ${text}`).not.toBe(true)
        const structured = expectStructured(name, result)
        expect(Object.keys(structured).sort()).toEqual(['reportFile', 'summary'])
        expect(structured.reportFile).toBe(outputFile)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it('exposes no sampling wording in the translate tool descriptions', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.description?.toLowerCase()).not.toContain('sampling')
      expect(tool.description?.toLowerCase()).not.toContain('host llm')
    }
  })

  it('reads a locale resource with a cold cache — no prior discover call', async () => {
    clearConfigCache()
    const result = await client.readResource({ uri: 'i18n:///root/de' })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toMatchObject({ greeting: 'Hallo {name}' })
  })

  // The flat layer list discover returned could not answer where a new key
  // belongs, so an agent had to guess from layer names — the heuristic the
  // layer-graph module was written to replace (#342).
  it('discover carries the layer graph, not just a flat layer list', async () => {
    const { json } = await callTool('discover', { projectDir })

    expect(json?.layerGraph.canonical).toContain('root')
    // Every canonical layer is a key, so "no consumers" and "not computed"
    // cannot be confused for one another by whatever reads this.
    for (const layer of json?.layerGraph.canonical as string[]) {
      expect(json?.layerGraph.consumers[layer]).toBeInstanceOf(Array)
    }
    expect(json?.layerGraph.shared).toBeInstanceOf(Array)
    expect(json?.layerGraph.aliases).toBeInstanceOf(Object)
  })

  // Empty values are not missing keys — they are present in the file and
  // render as nothing, so the coverage report counts them separately, and
  // listEmpty names the keys behind that count.
  it('get_translation_status lists the keys that exist but have no value', async () => {
    const dir = await makeProject()
    await writeFile(join(dir, 'i18n', 'locales', 'en.json'), JSON.stringify({
      greeting: '',
      actions: { save: 'Save' },
    }))

    const { json } = await callTool('get_translation_status', { projectDir: dir, listEmpty: true })

    expect(json?.summary.emptyKeys).toBe(1)
    expect(json?.empty).toEqual({ en: { root: ['greeting'] } })
  })

  it('get_translation_status counts empty values without listing them by default', async () => {
    const dir = await makeProject()
    await writeFile(join(dir, 'i18n', 'locales', 'en.json'), JSON.stringify({ greeting: '' }))

    const { json } = await callTool('get_translation_status', { projectDir: dir })

    expect(json?.summary.emptyKeys).toBe(1)
    expect(json).not.toHaveProperty('empty')
  })

  // One row per key, however many locales and layers hold it: the per-locale
  // rows are most of what an agent spent its context on when all it asked was
  // whether a translation for this text already exists.
  it('search_translations answers with one row per key, and per-locale rows on request', async () => {
    const grouped = await callTool('search_translations', {
      projectDir,
      query: 'Speichern',
      searchIn: 'values',
    })

    expect(grouped.json?.matches).toEqual([
      { key: 'actions.save', layers: ['root'], value: 'Speichern', locale: 'de', localeCount: 1 },
    ])
    expect(grouped.json?.totalMatches).toBe(1)

    const detailed = await callTool('search_translations', {
      projectDir,
      query: 'Speichern',
      searchIn: 'values',
      includeLocales: true,
    })

    expect(detailed.json?.matches).toEqual([
      { layer: 'root', locale: 'de', key: 'actions.save', value: 'Speichern' },
    ])
  })

  it('search_translations matches a value past its case and punctuation in fuzzy mode', async () => {
    const args = { projectDir, query: '  speichern! ', searchIn: 'values' }

    // Unchanged by default: the substring is not in the value as written.
    expect((await callTool('search_translations', args)).json?.totalMatches).toBe(0)

    const { json } = await callTool('search_translations', { ...args, matchMode: 'fuzzy' })

    expect(json?.matches).toEqual([
      { key: 'actions.save', layers: ['root'], value: 'Speichern', locale: 'de', localeCount: 1 },
    ])
  })

  it('discover returns the project configuration and the agent translation mode', async () => {
    const { json, result } = await callTool('discover', { projectDir })

    // discover is the one result the server adds to — the translation mode is
    // the process's own state — so its schema has to cover that too.
    expect(expectStructured('discover', result).translationMode).toBe('agent')
    expect(json?.defaultLocale).toBe('de')
    expect(json?.locales).toEqual([
      expect.objectContaining({ code: 'de' }),
      expect.objectContaining({ code: 'en' }),
    ])
    expect(json?.layers).toEqual([
      expect.objectContaining({ layer: 'root' }),
    ])
    expect(json?.translationMode).toBe('agent')
    expect(json?.translationProvider).toBeUndefined()
    expect(json?.translationModel).toBeUndefined()
    expect(json?.protectedLocales).toEqual([])
  })

  it('discover without a projectDir argument defaults to I18N_PROJECT_DIR', async () => {
    // Tools must honor the env default, not the test process cwd (issue #264).
    const { result, json } = await callTool('discover', {})

    expect(result.isError).toBeFalsy()
    expect(json?.defaultLocale).toBe('de')
    expect(json?.layers).toEqual([
      expect.objectContaining({ layer: 'root' }),
    ])
  })

  it('discover surfaces protectedLocales resolved to canonical codes', async () => {
    // Refs may use any accepted form (here a file name and an unknown entry);
    // discover resolves them to canonical codes and drops unknown entries.
    const dir = await makeProject({ protectedLocales: ['en.json', 'xx-nope'] })
    try {
      const { json } = await callTool('discover', { projectDir: dir })

      expect(json?.protectedLocales).toEqual(['en'])
      // The raw config refs remain visible under projectConfig.
      expect(json?.projectConfig?.protectedLocales).toEqual(['en.json', 'xx-nope'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('translate_missing without a translation backend returns fallback contexts', async () => {
    const { json, result } = await callTool('translate_missing', { layer: 'root', projectDir })

    // The agent-mode guidance is added to the result after the operation ran,
    // so the schema has to cover the decorated shape and not just the plain one.
    const structured = expectStructured('translate_missing', result)
    expect((structured.summary as { message?: string }).message).toBeDefined()
    expect(json?.summary.mode).toBe('agent')
    expect(json?.summary.totalSkipped).toBe(2)
    expect(json?.summary.message).toContain('write_translations')
    expect(json?.fallbackContexts?.en?.keysToTranslate).toMatchObject({
      'greeting': 'Hallo {name}',
      'actions.save': 'Speichern',
    })
  })

  it('translate_missing keeps fallback contexts in compact mode', async () => {
    const { json } = await callTool('translate_missing', { layer: 'root', compact: true, projectDir })

    expect(json?.fallbackContexts?.en).toBeDefined()
    expect(json?.summary.message).toContain('write_translations')
    expect(json?.summary.byLocale).toEqual([
      expect.objectContaining({ locale: 'en', mode: 'agent', missing: 2, skipped: 2 }),
    ])
    expect(json?.results).toBeUndefined()
  })

  // #301: stderr is the server's own log, so an MCP caller can only learn
  // that a locale ref was dropped if the result itself says so.
  it('write_translations reports an unresolvable locale ref in the result', async () => {
    const { json } = await callTool('write_translations', {
      projectDir,
      layer: 'root',
      translations: { 'actions.cancel': { de: 'Abbrechen', 'de-DE-formal': 'Brechen Sie ab' } },
    })

    expect(json?.unresolvedLocales).toEqual([
      expect.objectContaining({ ref: 'de-DE-formal', keys: ['actions.cancel'] }),
    ])
    // The trap this guards: the key IS written, for the locale that resolved.
    expect(json?.written).toContain('actions.cancel')
    expect(json?.filesWritten).toBe(1)
  })

  it('write_translations leaves the result shape untouched when every ref resolves', async () => {
    const { json } = await callTool('write_translations', {
      projectDir,
      layer: 'root',
      translations: { 'actions.close': { de: 'Schliessen', en: 'Close' } },
    })

    expect(json).not.toHaveProperty('unresolvedLocales')
    expect(json).not.toHaveProperty('ambiguousLocales')
    expect(json?.filesWritten).toBe(2)
  })

  // All-layers mode nests fallbackContexts per layer, so a top-level check
  // skipped the agent-mode guidance in exactly the mode layered projects use.
  it('translate_missing still returns agent guidance without a layer argument', async () => {
    const { json } = await callTool('translate_missing', { projectDir })

    expect(json?.layers).toBeDefined()
    expect(json?.summary.mode).toBe('agent')
    expect(json?.summary.message).toContain('write_translations')
  })

  it('get_translation_status reports coverage in one call', async () => {
    const { json } = await callTool('get_translation_status', { projectDir })

    // The fixture has de fully populated and en empty, so en is 0%.
    expect(json?.summary.completionPercent).toBeDefined()
    expect(json?.summary.referenceLocale.code).toBe('de')
    expect(json?.locales).toBeDefined()
    expect(json?.layers).toBeDefined()
  })

  // The diversion is the registrar's, not the operation's: the tool handler
  // applies it to whatever the operation returned.
  it('get_missing_translations writes the full result to outputFile and returns the summary', async () => {
    const outputFile = join(projectDir, 'missing.json')
    const { json } = await callTool('get_missing_translations', { projectDir, outputFile })

    expect(Object.keys(json ?? {}).sort()).toEqual(['reportFile', 'summary'])
    expect(json?.reportFile).toBe(outputFile)
    expect(json?.summary.totalMissingKeys).toBeGreaterThan(0)

    const report = JSON.parse(await readFile(outputFile, 'utf-8')) as Record<string, unknown>
    expect(report.tool).toBe('get_missing_translations')
    expect(report.missing).toBeDefined()
  })

  it('get_translation_status marks protected locales as excluded', async () => {
    const dir = await makeProject({ protectedLocales: ['en'] })
    const { json } = await callTool('get_translation_status', { projectDir: dir })

    expect(json?.summary.protectedLocales).toEqual(['en'])
    expect(json?.locales?.[0]).toMatchObject({ code: 'en', excludedFromOverall: true })
    await rm(dir, { recursive: true, force: true })
  })

  it('find_duplicate_keys returns a valid empty result for a single-layer project', async () => {
    const { json } = await callTool('find_duplicate_keys', { projectDir })

    // One app, one layer — no (shared, child) pairs exist to check.
    expect(json?.collisions).toEqual([])
    expect(json?.summary.totalCollisions).toBe(0)
    expect(json?.summary.divergentCount).toBe(0)
    expect(json?.summary.pairsChecked).toBe(0)
    expect(json?.summary.locale).toBe('de')
    expect(json?.summary.message).toBeDefined()
    expect(json?.guidance).toBeDefined()
  })

  it('find_undefined_keys returns a clean result for a project without code usage', async () => {
    const { json } = await callTool('find_undefined_keys', { projectDir })

    expect(json?.undefinedKeys).toEqual([])
    expect(json?.uncertainKeys).toEqual([])
    expect(json?.summary.undefinedCount).toBe(0)
    expect(json?.summary.usedKeysChecked).toBe(0)
    expect(json?.summary.locale).toBe('de')
    expect(json?.limitation).toContain('line-based')
  })

  it('find_undefined_keys reports an undefined key and an uncertain dynamic usage', async () => {
    const dir = await makeProject()
    try {
      await mkdir(join(dir, 'components'), { recursive: true })
      await writeFile(join(dir, 'components/Page.vue'), [
        `{{ $t('actions.save') }}`,
        `{{ $t('missing.key') }}`,
        'const label = t(`dyn.${variant}`)',
      ].join('\n'))

      const { json } = await callTool('find_undefined_keys', { projectDir: dir })

      expect(json?.undefinedKeys).toEqual([
        expect.objectContaining({
          key: 'missing.key',
          searchedLayers: ['root'],
          usages: [{ file: join('components', 'Page.vue'), line: 2 }],
        }),
      ])
      expect(json?.uncertainKeys).toEqual([
        expect.objectContaining({
          key: '`dyn.${variant}`',
          usages: [{ file: join('components', 'Page.vue'), line: 3 }],
          reason: expect.stringContaining('dynamically built key'),
        }),
      ])
      expect(json?.summary.undefinedCount).toBe(1)
      expect(json?.summary.uncertainCount).toBe(1)
      expect(json?.summary.searchedLayersByApp).toEqual({ default: ['root'] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Promoting a key is the operation the layer graph's answer leads to (#341,
  // #342): discover names the shared layer, this moves the key into it. Needs
  // two layers, which the shared single-layer fixture does not have.
  it('move_translation_key promotes a key between layers', async () => {
    const twoLayer = await mkdtemp(join(tmpdir(), 'i18n-mcp-move-'))
    try {
      for (const [dir, data] of [
        ['app-admin/i18n/locales', { admin: { dashboard: { title: 'Übersicht' } } }],
        ['i18n/locales', {}],
      ] as const) {
        await mkdir(join(twoLayer, dir), { recursive: true })
        await writeFile(join(twoLayer, dir, 'de.json'), JSON.stringify(data))
      }
      await writeFile(join(twoLayer, '.i18n-mcp.json'), JSON.stringify({
        localeDirs: [
          { path: 'i18n/locales', layer: 'root' },
          { path: 'app-admin/i18n/locales', layer: 'app-admin' },
        ],
        defaultLocale: 'de',
        locales: ['de'],
      }))

      const { json } = await callTool('move_translation_key', {
        layer: 'app-admin',
        toLayer: 'root',
        key: 'admin.dashboard.title',
        newKey: 'common.dashboard.title',
        projectDir: twoLayer,
      })

      expect(json?.movedLocales).toEqual(['de'])
      expect(json?.filesWritten).toBe(2)
      expect(JSON.parse(await readFile(join(twoLayer, 'i18n/locales/de.json'), 'utf-8')))
        .toEqual({ common: { dashboard: { title: 'Übersicht' } } })
      expect(JSON.parse(await readFile(join(twoLayer, 'app-admin/i18n/locales/de.json'), 'utf-8')))
        .toEqual({})
    } finally {
      await rm(twoLayer, { recursive: true, force: true })
    }
  })

  // The same tool without a toLayer, which is the half that used to be a tool
  // of its own — an agent had to know which of the two to reach for before it
  // knew whether the key was changing layers.
  it('move_translation_key renames in place when no other layer is named', async () => {
    const dir = await makeProject()
    try {
      const { json } = await callTool('move_translation_key', {
        layer: 'root',
        key: 'actions.save',
        newKey: 'actions.store',
        projectDir: dir,
      })

      expect(json?.renamed).toEqual(['de'])
      expect(JSON.parse(await readFile(join(dir, 'i18n/locales/de.json'), 'utf-8')))
        .toMatchObject({ actions: { store: 'Speichern' } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Without `remove` the tool is a report, and that has to hold through the
  // transport rather than only in the core defaults.
  it('find_orphan_keys deletes nothing unless remove is set', async () => {
    const dir = await makeProject()
    try {
      const before = await readFile(join(dir, 'i18n/locales/de.json'), 'utf-8')
      const { json } = await callTool('find_orphan_keys', { projectDir: dir })

      expect(json?.summary.orphanCount).toBe(2)
      expect(json?.removed).toBeUndefined()
      expect(await readFile(join(dir, 'i18n/locales/de.json'), 'utf-8')).toBe(before)

      const removal = await callTool('find_orphan_keys', { projectDir: dir, remove: true })
      expect(removal.json?.summary).toMatchObject({ dryRun: false, removedCount: 2 })
      expect(JSON.parse(await readFile(join(dir, 'i18n/locales/de.json'), 'utf-8'))).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The scan reads every source file of every app, which is many seconds on a
   * monorepo. A caller that passes a progress token gets told where it is —
   * and, because the reporter counts the notifications it sends, the last one
   * has to land exactly on the total announced before the first.
   */
  it('find_orphan_keys reports progress against a total set before the first notification', async () => {
    const dir = await makeProject()
    try {
      await mkdir(join(dir, 'components'), { recursive: true })
      for (let i = 0; i < 6; i++) {
        await writeFile(join(dir, `components/C${i}.vue`), `{{ $t('greeting') }}`)
      }

      const notifications: Array<{ progress: number, total?: number, message?: string }> = []
      const result = await client.callTool(
        { name: 'find_orphan_keys', arguments: { projectDir: dir } },
        { onprogress: p => void notifications.push({ progress: p.progress, total: p.total, message: p.message }) },
      )
      const json = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any>

      expect(result.isError).toBeFalsy()
      expect(notifications.length).toBeGreaterThan(0)
      // A notification sent before onProgressTotal would carry no total at all.
      const total = notifications[0]?.total
      expect(total).toBe(json.summary.filesScanned)
      expect(notifications.every(n => n.total === total)).toBe(true)
      expect(notifications.map(n => n.progress)).toEqual([...Array(total).keys()].map(i => i + 1))
      // Where the scan is, not just how far along it is.
      expect(notifications.at(-1)?.message).toContain('.vue')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid tool input via schema validation', async () => {
    const { result } = await callTool('write_translations', {
      layer: 'root',
      // invalid: values must be locale maps, not plain strings
      translations: { 'some.key': 'plain string' },
      projectDir,
    })

    expect(result.isError).toBe(true)
  })

  it('reports tool-level errors as MCP error responses', async () => {
    const { result, text } = await callTool('get_translations', {
      layer: 'no-such-layer',
      locale: 'de',
      keys: ['greeting'],
      projectDir,
    })

    expect(result.isError).toBe(true)
    expect(text).toContain('no-such-layer')
  })
})

describe('provider mode via injected TranslateFn', () => {
  let providerProjectDir: string
  let providerClient: Client

  beforeAll(async () => {
    providerProjectDir = await makeProject()
    const { createServer } = await import('../src/server.js')
    providerClient = await connectClient(await createServer({ translateFn: fakeTranslateFn }))
  })

  afterAll(async () => {
    await providerClient.close()
    await rm(providerProjectDir, { recursive: true, force: true })
  })

  it('discover reports provider translation mode', async () => {
    const { json } = await callToolOn(providerClient, 'discover', { projectDir: providerProjectDir })

    expect(json?.translationMode).toBe('provider')
  })

  it('translate_missing translates through the backend and writes the target locale file', async () => {
    const { json } = await callToolOn(providerClient, 'translate_missing', {
      layer: 'root',
      projectDir: providerProjectDir,
    })

    expect(json?.summary.mode).toBe('provider')
    expect(json?.summary.totalTranslated).toBe(2)
    expect(json?.summary.totalFailed).toBe(0)
    expect(json?.fallbackContexts).toBeUndefined()
    expect(json?.results.en).toMatchObject({
      mode: 'provider',
      model: 'fake-model',
      failed: [],
      skipped: [],
    })

    const en = JSON.parse(
      await readFile(join(providerProjectDir, 'i18n', 'locales', 'en.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect(en).toMatchObject({
      greeting: '[t] Hallo {name}',
      actions: { save: '[t] Speichern' },
    })
  })
})

describe('partial provider env config', () => {
  let partialProjectDir: string
  let partialClient: Client
  let stderrOutput: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(async () => {
    partialProjectDir = await makeProject()

    // Provider named, but no model and no API key — must warn at startup and
    // serve agent mode.
    for (const name of ['I18N_PROVIDER', 'I18N_MODEL', 'OPENAI_API_KEY']) {
      savedEnv[name] = process.env[name]
    }
    process.env.I18N_PROVIDER = 'openai'
    delete process.env.I18N_MODEL
    delete process.env.OPENAI_API_KEY

    stderrOutput = ''
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk)
      return true
    })
    try {
      const { createServer } = await import('../src/server.js')
      partialClient = await connectClient(await createServer())
    } finally {
      stderrSpy.mockRestore()
    }
  })

  afterAll(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await partialClient.close()
    await rm(partialProjectDir, { recursive: true, force: true })
  })

  it('logs a startup warning to stderr', () => {
    expect(stderrOutput).toContain('Partial provider config')
    expect(stderrOutput).toContain('agent mode')
  })

  it('discover reports agent mode', async () => {
    const { json } = await callToolOn(partialClient, 'discover', { projectDir: partialProjectDir })

    expect(json?.translationMode).toBe('agent')
  })

  it('translate_missing falls back to agent mode with fallback contexts', async () => {
    const { json } = await callToolOn(partialClient, 'translate_missing', {
      layer: 'root',
      projectDir: partialProjectDir,
    })

    expect(json?.summary.mode).toBe('agent')
    expect(json?.fallbackContexts?.en).toBeDefined()
  })
})

describe('dual-era serving through one factory', () => {
  // ttlMs/cacheScope are wire-level fields hidden from the public result
  // types but kept on the runtime objects — readable via this cast only.
  type CacheStamped = { ttlMs?: number, cacheScope?: string }

  let handler: McpHttpHandler
  let modernClient: Client

  const inProcessTransport = () =>
    new StreamableHTTPClientTransport(new URL('http://in-process.test/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    })

  beforeAll(async () => {
    const { createServer } = await import('../src/server.js')
    handler = createMcpHandler(() => createServer())
    modernClient = new Client(
      { name: 'modern-client', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    )
    await modernClient.connect(inProcessTransport())
  })

  afterAll(async () => {
    await modernClient.close()
    await handler.close()
  })

  it('negotiates the modern era via server/discover and serves tool calls', async () => {
    expect(modernClient.getProtocolEra()).toBe('modern')

    const { tools } = await modernClient.listTools()
    expect(tools.map(t => t.name)).toContain('discover')

    const { json } = await callToolOn(modernClient, 'discover', { projectDir })
    expect(json?.defaultLocale).toBe('de')
    expect(json?.translationMode).toBe('agent')
  })

  it('advertises server identity and capabilities on server/discover', () => {
    expect(modernClient.getServerVersion()).toMatchObject({ name: 'the-i18n-mcp' })

    const discover = modernClient.getDiscoverResult()
    expect(discover?.supportedVersions).toContain('2026-07-28')
    expect(discover?.capabilities?.tools).toBeDefined()
    expect(discover?.capabilities?.resources).toBeDefined()
    expect(discover?.capabilities?.prompts).toBeDefined()
  })

  it('stamps the configured cache hints on modern-era cacheable results', async () => {
    const discover = modernClient.getDiscoverResult() as CacheStamped | undefined
    expect(discover?.ttlMs).toBe(3_600_000)
    expect(discover?.cacheScope).toBe('private')

    const toolList = await modernClient.listTools() as CacheStamped
    expect(toolList.ttlMs).toBe(3_600_000)
    expect(toolList.cacheScope).toBe('private')

    // Resources deliberately have no configured hint: locale data must never
    // be cache-stale after a write tool ran. The SDK stamps ttlMs 0
    // (do-not-cache) on unconfigured cacheable results.
    const resourceRead = await modernClient.readResource({ uri: 'i18n:///root/de' }) as CacheStamped
    expect(resourceRead.ttlMs).toBe(0)
  })

  it('a resource read directly after a write returns the fresh content', async () => {
    await callToolOn(modernClient, 'write_translations', {
      layer: 'root',
      translations: { 'cache.probe': { de: 'frisch' } },
      projectDir,
    })

    const result = await modernClient.readResource({ uri: 'i18n:///root/de' })
    const content = result.contents[0] as { text: string }
    expect(JSON.parse(content.text)).toMatchObject({ cache: { probe: 'frisch' } })
  })

  it('serves a legacy-only client from the same entry point', async () => {
    const legacyClient = new Client({ name: 'legacy-client', version: '0.0.0' })
    await legacyClient.connect(inProcessTransport())
    try {
      expect(legacyClient.getProtocolEra()).toBe('legacy')

      const toolList = await legacyClient.listTools()
      expect(toolList.tools.map(t => t.name)).toContain('discover')
      expect((toolList as CacheStamped).ttlMs).toBeUndefined()

      const { json } = await callToolOn(legacyClient, 'discover', { projectDir })
      expect(json?.defaultLocale).toBe('de')
    } finally {
      await legacyClient.close()
    }
  })
})
