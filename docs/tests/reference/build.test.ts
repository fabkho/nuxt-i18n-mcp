/**
 * Contract tests for the reference builder, driven entirely by fixture sources.
 *
 * Nothing here touches the filesystem: the builder takes already-loaded sources
 * and returns a map of output path to page content, so a fixture is a plain
 * object. These tests cover the rules the builder applies — the shared/specific
 * flag split, alias folding — independently of what the CLI happens to register
 * today.
 */

import { describe, expect, it } from 'vitest'
import { CONFIG_REFERENCE_ROUTE } from '../../generate/reference/config-pages.js'
import { buildReference } from '../../generate/reference/build.js'
import type { CliCommandEntry, ReferenceSources } from '../../generate/reference/types.js'
import {
  UNPAIRED_TOOL,
  FIXTURE_SCHEMA,
  fixtureConfigSource,
  SCAN_ENTRY,
  TRANSLATE_ALIAS_ENTRY,
  TRANSLATE_ENTRY,
  TRANSLATE_MISSING_TOOL,
  fixtureActionSource,
  fixtureCliSource,
  fixtureMcpSource,
  fixtureSources,
} from './fixtures.js'
import {
  CLI_DIR,
  configPage,
  documentedFields,
  documentedNames,
  renderedText,
  MCP_DIR,
  actionPage,
  commandPage,
  documentedFlags,
  mcpOverview,
  overview,
  pagedCommands,
  pagedTools,
  rowNames,
  section,
  tableRow,
  toolPage,
} from './helpers.js'

function build(overrides: Partial<ReferenceSources> = {}) {
  return buildReference(fixtureSources(overrides))
}

describe('buildReference', () => {
  it('returns page content keyed by content-relative path and touches no disk', () => {
    const output = build()
    for (const [path, content] of output) {
      expect(path).toMatch(/^[\w.\-/]+\.md$/)
      expect(path.startsWith('/')).toBe(false)
      expect(content.endsWith('\n')).toBe(true)
    }
  })

  it('gives every registered command a page, and every page a title and description', () => {
    const output = build()
    expect(pagedCommands(output)).toEqual(new Set(['scan', 'translate']))

    for (const entry of [SCAN_ENTRY, TRANSLATE_ENTRY]) {
      const markdown = commandPage(output, entry.name)
      expect(markdown).toContain(`title: '${entry.name}'`)
      expect(markdown).toContain(entry.def.meta?.description)
    }
  })

  it('documents each command-specific flag on its own command page', () => {
    const output = build()
    expect(documentedFlags(commandPage(output, 'scan'))).toEqual(
      new Set(['keys', 'outputFile']),
    )
    expect(documentedFlags(commandPage(output, 'translate'))).toEqual(
      new Set(['layer', 'provider', 'failOnFailed']),
    )
  })

  it('renders flags shared by every command once on the overview, never per command', () => {
    const output = build()
    expect(documentedFlags(overview(output))).toContain('json')
    expect(documentedFlags(overview(output))).toContain('projectDir')

    for (const name of pagedCommands(output)) {
      const flags = documentedFlags(commandPage(output, name))
      expect(flags).not.toContain('json')
      expect(flags).not.toContain('projectDir')
    }
  })

  it('carries each command description into the overview table verbatim', () => {
    const markdown = overview(build())
    for (const entry of [SCAN_ENTRY, TRANSLATE_ENTRY]) {
      expect(markdown).toContain(entry.def.meta?.description)
    }
  })

  it('folds an alias into the command it aliases instead of emitting a second page', () => {
    const output = build()
    expect(output.has(`${CLI_DIR}/${TRANSLATE_ALIAS_ENTRY.name}.md`)).toBe(false)

    const markdown = commandPage(output, 'translate')
    expect(markdown).toContain(TRANSLATE_ALIAS_ENTRY.name)
    expect(markdown).toContain(TRANSLATE_ALIAS_ENTRY.def.meta?.description)
    expect(overview(output)).toContain(TRANSLATE_ALIAS_ENTRY.name)
  })

  it('documents every exit code the CLI can set, and the gate flags that reach code 2', () => {
    const cli = fixtureCliSource({ exitCodes: { success: 0, runFailed: 3, gateTripped: 4 } })
    const markdown = overview(buildReference(fixtureSources({ cli })))

    // Read from the source rather than hard-coded, so a renumbering shows up as
    // a documentation change rather than a passing test.
    expect(markdown).toMatch(/\|\s*3\s*\|/)
    expect(markdown).toMatch(/\|\s*4\s*\|/)
    expect(documentedFlags(markdown)).toContain('failOnFailed')
  })

  it('escapes a pipe inside a flag description so the table row survives', () => {
    const markdown = commandPage(build(), 'translate')
    expect(markdown).not.toMatch(/openai\|anthropic\|google/)
    expect(markdown).toContain('openai\\|anthropic\\|google')
  })

  it('produces a complete page for a newly registered command with no other change', () => {
    const added: CliCommandEntry = {
      name: 'find-unused',
      def: {
        meta: { name: 'find-unused', description: 'Report keys with no usage evidence' },
        args: {
          ...(SCAN_ENTRY.def.args ?? {}),
          strict: { type: 'boolean', description: 'Treat uncertain keys as unused', default: false },
        },
        run: () => Promise.resolve(),
      },
    }
    const cli = fixtureCliSource({
      entries: [...fixtureCliSource().entries, added],
    })
    const output = buildReference(fixtureSources({ cli }))

    const markdown = commandPage(output, 'find-unused')
    expect(markdown).toContain('Report keys with no usage evidence')
    expect(documentedFlags(markdown)).toContain('strict')
    expect(overview(output)).toContain('find-unused')
  })

  it('lists every generated reference on the section landing page', () => {
    const markdown = build().get('9.reference/index.md')
    expect(markdown).toBeDefined()
    expect(markdown).toContain('/reference/cli')
    expect(markdown).toContain('/reference/mcp')
    expect(markdown).toContain('/reference/action')
    expect(markdown).toContain(CONFIG_REFERENCE_ROUTE)
  })
})

describe('the MCP tool reference, from a fixture listing', () => {
  function buildMcp(mcp = fixtureMcpSource()) {
    return buildReference(fixtureSources({ mcp }))
  }

  it('gives every advertised tool a page, and links each from the overview', () => {
    const output = buildMcp()
    expect(pagedTools(output)).toEqual(new Set(['list_namespaces', 'translate_missing']))

    const markdown = mcpOverview(output)
    for (const name of pagedTools(output)) {
      expect(markdown).toContain(`(/reference/mcp/${name})`)
    }
  })

  it('carries the advertised description onto the tool page unaltered', () => {
    const markdown = toolPage(buildMcp(), TRANSLATE_MISSING_TOOL.name)
    expect(markdown).toContain(TRANSLATE_MISSING_TOOL.description)
  })

  it('documents every parameter of the input schema, and which are required', () => {
    const markdown = toolPage(buildMcp(), TRANSLATE_MISSING_TOOL.name)
    const params = section(markdown, '## Parameters')
    const advertised = Object.keys(TRANSLATE_MISSING_TOOL.inputSchema.properties ?? {})

    expect([...rowNames(params)].sort()).toEqual([...advertised].sort())
    expect(tableRow(params, 'layer')).toContain('yes')
    expect(tableRow(params, 'dryRun')).toContain('no')
  })

  it('names each parameter type as a caller has to pass it', () => {
    const params = section(toolPage(buildMcp(), TRANSLATE_MISSING_TOOL.name), '## Parameters')
    expect(tableRow(params, 'keys')).toContain('`string[]`')
    expect(tableRow(params, 'mode')).toContain('`"add" \\| "update" \\| "upsert"`')
    expect(tableRow(params, 'targetLocales')).toContain('`"all" \\| string[]`')
    expect(tableRow(params, 'translations')).toContain('`Record<string, Record<string, string>>`')
  })

  it('tabulates the top-level fields of a result, across every shape it can take', () => {
    // A tool that diverts to a file answers with one of two shapes, and both are
    // its result — so `reportFile` belongs in the same table as `results`.
    const result = section(toolPage(buildMcp(), 'translate_missing'), '## Result')

    expect([...rowNames(result)].sort()).toEqual(['reportFile', 'results', 'summary'])
    expect(tableRow(result, 'results')).toContain('Full per-locale results.')
  })

  it('names the type of a result that is a map rather than a set of fields', () => {
    // A table of one row called "every layer" would say less than the type does.
    const result = section(toolPage(buildMcp(), 'list_namespaces'), '## Result')

    expect(result).toContain('`Record<string, Record<string, unknown>>`')
    expect(result).toContain('the key tree of that layer')
    expect(rowNames(result).size).toBe(0)
  })

  it('states how a result reaches a host once, on the overview', () => {
    const markdown = mcpOverview(buildMcp())

    expect(markdown).toContain('`outputSchema`')
    expect(markdown).toContain('`structuredContent`')
    // Repeating it on fifteen tool pages is how the READMEs came to disagree.
    expect(toolPage(buildMcp(), 'translate_missing')).not.toContain('`structuredContent`')
  })

  it('documents a tool that advertises no output schema without an empty section', () => {
    const schemaless = { ...UNPAIRED_TOOL, outputSchema: undefined }

    const markdown = toolPage(buildMcp(fixtureMcpSource({ tools: [schemaless] })), UNPAIRED_TOOL.name)

    expect(() => section(markdown, '## Result')).toThrow()
  })

  it('reports the behaviour hints a host reads, and nothing when a tool sends none', () => {
    const output = buildMcp()
    expect(section(toolPage(output, 'translate_missing'), '## Behavior Hints'))
      .toContain('readOnlyHint')
    expect(() => section(toolPage(output, 'list_namespaces'), '## Behavior Hints')).toThrow()
  })

  it('links a paired tool to the command page instead of restating its flags', () => {
    const markdown = toolPage(buildMcp(), 'translate_missing')
    expect(markdown).toContain('(/reference/cli/translate)')
    expect(documentedFlags(markdown).size).toBe(0)
  })

  it('documents a tool with no paired command without inventing one', () => {
    const markdown = toolPage(buildMcp(), 'list_namespaces')
    expect(markdown).not.toContain('/reference/cli/')
  })

  it('refuses to build a pairing whose command the CLI does not register', () => {
    // Otherwise the page ships a link to a command page that was never
    // generated, and the site build fails far from the cause.
    const cli = fixtureCliSource({ entries: [SCAN_ENTRY] })
    expect(() => buildReference(fixtureSources({ cli }))).toThrow(/translate_missing/)
  })

  it('produces a complete page for a newly advertised tool with no other change', () => {
    const added = {
      name: 'find_stale_translations',
      title: 'Find Stale Translations',
      description: 'Find target values older than their source value.',
      inputSchema: {
        type: 'object',
        properties: { layer: { type: 'string', description: 'Layer name' } },
        required: ['layer'],
      },
    }
    const output = buildMcp(fixtureMcpSource({ tools: [UNPAIRED_TOOL, added] }))

    const markdown = toolPage(output, added.name)
    expect(markdown).toContain(added.description)
    expect(rowNames(section(markdown, '## Parameters'))).toContain('layer')
    expect(mcpOverview(output)).toContain(`(/reference/mcp/${added.name})`)
  })

  it('states a parameter every tool accepts once on the overview', () => {
    const markdown = mcpOverview(buildMcp())
    expect(markdown).toContain('`projectDir`')
  })

  it('names the tools that can divert a large result to a file', () => {
    const markdown = mcpOverview(buildMcp())
    expect(markdown).toContain('`outputFile`')
    expect(markdown).toContain('(/reference/mcp/translate_missing)')
  })

  it('writes tool pages under the MCP directory alone', () => {
    for (const path of pagedTools(buildMcp())) {
      expect(`${MCP_DIR}/${path}.md`.startsWith(MCP_DIR)).toBe(true)
    }
  })
})

describe('the GitHub Action reference, from a fixture manifest', () => {
  function buildAction(action = fixtureActionSource()) {
    return actionPage(buildReference(fixtureSources({ action })))
  }

  it('documents every input with its required status and its default', () => {
    const source = fixtureActionSource()
    const inputs = section(buildAction(source), '## Inputs')

    expect([...rowNames(inputs)].sort()).toEqual(source.inputs.map(input => input.name).sort())
    for (const input of source.inputs) {
      const row = tableRow(inputs, input.name)
      expect(row).toContain(input.required ? 'yes' : 'no')
      if (input.default !== undefined) expect(row).toContain(`\`${input.default}\``)
    }
  })

  it('marks an input with no declared default as having none', () => {
    const row = tableRow(section(buildAction(), '## Inputs'), 'provider')
    expect(row).toContain('—')
  })

  it('carries each input description onto the page verbatim', () => {
    const markdown = buildAction()
    for (const input of fixtureActionSource().inputs) {
      // Angle brackets are entity-escaped, since a markdown renderer reads
      // `<config>` as the start of a tag and drops the rest of the sentence.
      expect(markdown).toContain(input.description.replace(/</g, '&lt;'))
    }
  })

  it('documents every output', () => {
    const source = fixtureActionSource()
    const outputs = section(buildAction(source), '## Outputs')

    expect([...rowNames(outputs)].sort()).toEqual(source.outputs.map(output => output.name).sort())
    for (const output of source.outputs) {
      expect(outputs).toContain(output.description)
    }
  })

  it('keeps a workflow expression default as the manifest writes it', () => {
    // Paraphrasing `${{ github.workspace }}` would hide which context supplies
    // the value, which is the one thing a reader needs from a default.
    expect(tableRow(section(buildAction(), '## Inputs'), 'working_directory'))
      .toContain('`${{ github.workspace }}`')
  })

  it('points at the command it runs and at the workflow around it', () => {
    // The action installs the CLI and runs one command; its flags, its exit
    // codes and the step that commits what it wrote live where they belong.
    const markdown = buildAction()
    expect(markdown).toContain('(/reference/cli/translate)')
    expect(markdown).toContain('(/ci-cd/github-actions)')
  })
})

describe('the configuration reference, from a fixture schema', () => {
  it('lists every field the schema declares, and nothing else', () => {
    const markdown = configPage(build())
    expect(documentedFields(markdown)).toEqual(new Set(Object.keys(FIXTURE_SCHEMA.properties)))
  })

  it('carries every description the schema declares, verbatim', () => {
    const markdown = renderedText(configPage(build()))
    for (const node of Object.values(FIXTURE_SCHEMA.properties)) {
      expect(markdown).toContain(node.description)
    }
  })

  it('renders the type and the constraints the schema imposes', () => {
    const markdown = configPage(build())
    // A union renders as its members, not as the word "union", and an array of
    // one keeps the constraint on the entry rather than on the array.
    expect(markdown).toContain('`true \\| string`')
    expect(markdown).toContain('`Record<string, string>`')
    expect(markdown).toContain('each entry: minimum length 1')
    expect(markdown).toContain('suggested: "nuxt", "generic"')
  })

  it('marks a deprecated field as deprecated and keeps its migration note', () => {
    const row = fieldRow(configPage(build()), 'samplingPreferences')
    expect(row).toContain('deprecated')
    expect(row).toContain('configure a provider instead')
  })

  it('documents a nested object rather than flattening it to `object`', () => {
    const shape = section(configPage(build()), '### `layerRules`')
    // Including the optional property, and which of the three is required.
    expect(documentedNames(shape)).toEqual(new Set(['layer', 'when', 'note']))
    expect(shape).toMatch(/\| `layer` \| `string` \| yes \|/)
    expect(shape).toMatch(/\| `note` \| `string` \| no \|/)
  })

  it('documents both accepted forms of an entry, including the object one', () => {
    const shape = section(configPage(build()), '### `localeDirs`')
    expect(shape).toContain('Relative path to a locale directory.')

    // The object form's own properties, which a `string | object` union would
    // otherwise leave undocumented.
    const objectForm = shape.slice(shape.indexOf('form holds:'))
    expect(documentedNames(objectForm)).toEqual(new Set(['path', 'layer']))
    expect(objectForm).toContain('Layer name for this directory.')
  })

  it('documents a record entry and says that unlisted keys still validate', () => {
    const shape = section(configPage(build()), '### `orphanScan`')
    expect(documentedNames(shape)).toEqual(new Set(['ignorePatterns']))
    expect(shape).toContain('Properties beyond these are accepted')
  })

  it('states where each field may be declared, restrictions included', () => {
    const config = fixtureConfigSource()
    const markdown = configPage(build({ config }))

    for (const key of config.moduleOwnedKeys) {
      expect(fieldRow(markdown, key)).toContain('rejected by `@the-i18n-kit/nuxt`')
    }
    for (const key of config.untypedKeys) {
      expect(fieldRow(markdown, key)).toContain('`.i18n-mcp.json` only')
    }
    expect(fieldRow(markdown, 'framework')).toContain('Either config file')
  })

  it('names the options the i18nKit block accepts instead of these fields', () => {
    const markdown = configPage(build())
    for (const option of fixtureConfigSource().nuxtModuleOptions) {
      expect(markdown).toContain(`\`${option}\``)
    }
  })

  it('documents a field added to the schema with no other change', () => {
    const added = {
      type: 'string' as const,
      description: 'Where the CI report is written.',
    }
    const config = fixtureConfigSource({
      schema: {
        ...FIXTURE_SCHEMA,
        properties: { ...FIXTURE_SCHEMA.properties, ciReport: added },
      },
    })
    const markdown = configPage(build({ config }))

    expect(documentedFields(markdown)).toContain('ciReport')
    expect(markdown).toContain(added.description)
  })

  it('emits the page at the path whose route the concept pages link', () => {
    // The route follows from the file's location: numeric directory prefixes are
    // stripped, so this path and only this path serves /configuration/reference.
    const output = build()
    expect([...output.keys()]).toContain('5.configuration/4.reference.md')
    expect(CONFIG_REFERENCE_ROUTE).toBe('/configuration/reference')
  })
})

/** The field table row for one field, by the code span that opens it. */
function fieldRow(markdown: string, field: string): string {
  const row = section(markdown, '## Fields')
    .split('\n')
    .find(line => new RegExp(`^\\| \\[?\`${field.replace('$', '\\$')}\``).test(line))
  if (row === undefined) throw new Error(`No row for ${field} in the field table.`)
  return row
}
