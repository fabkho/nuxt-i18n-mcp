import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { descriptors, visibleParams } from '@the-i18n-kit/cli'

/**
 * The server half of the drift guard.
 *
 * The CLI half lives in `packages/cli/tests/cli/descriptors.test.ts`: it holds
 * the commands to the operation table and checks that a parameter both surfaces
 * expose is spelled the same on both. This half holds the advertised tools to
 * the same table — the tools a host is handed, their parameters and which of
 * them are required — so neither surface can drift from the declaration without
 * one of the two files failing.
 *
 * Nothing here is listed by hand. Adding a tool, renaming a parameter or hiding
 * one needs no edit in this file; contradicting the table does.
 */

const mcpDescriptors = descriptors.filter(descriptor => descriptor.mcp !== null)

let projectDir: string
let client: Client
let tools: Array<{
  name: string
  title?: string
  description?: string
  inputSchema: { properties?: Record<string, unknown>, required?: string[] }
  outputSchema?: { type?: string, description?: string, properties?: Record<string, unknown>, anyOf?: unknown[] }
}>

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'i18n-mcp-descriptors-'))
  process.env.I18N_PROJECT_DIR = projectDir

  const { createServer } = await import('../src/server.js')
  const server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'descriptor-test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  tools = (await client.listTools()).tools as typeof tools
})

afterAll(async () => {
  await client.close()
  await rm(projectDir, { recursive: true, force: true })
})

/** The advertised tool of one descriptor, or a failure naming the missing one. */
function advertised(name: string) {
  const tool = tools.find(candidate => candidate.name === name)
  expect(tool, `the server advertises no tool named ${name}`).toBeDefined()
  return tool!
}

describe('the operation table drives the advertised tools', () => {
  it('advertises exactly the operations that declare a tool', () => {
    expect(tools.map(tool => tool.name).sort())
      .toEqual(mcpDescriptors.map(descriptor => descriptor.mcp?.name).sort())
  })

  it('accepts exactly the parameters the descriptor declares, plus projectDir', () => {
    for (const descriptor of mcpDescriptors) {
      const tool = advertised(descriptor.mcp?.name ?? '')
      // Every operation takes a project directory without declaring one, so the
      // registrar adds it rather than sixteen descriptors repeating it.
      const declared = [...visibleParams(descriptor, 'mcp'), 'projectDir']

      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(declared.sort())
    }
  })

  it('marks exactly the required parameters as required', () => {
    for (const descriptor of mcpDescriptors) {
      const tool = advertised(descriptor.mcp?.name ?? '')
      const required = Object.entries(descriptor.params)
        .filter(([, spec]) => spec.required === true && spec.mcp?.hidden !== true)
        .map(([name]) => name)

      expect((tool.inputSchema.required ?? []).sort()).toEqual(required.sort())
    }
  })

  it('advertises the declared title and description, the long prose included', () => {
    for (const descriptor of mcpDescriptors) {
      const tool = advertised(descriptor.mcp?.name ?? '')

      expect(tool.title).toBe(descriptor.mcp?.title)
      expect(tool.description).toContain(descriptor.description)
      if (descriptor.longDescription !== undefined) {
        expect(tool.description).toContain(descriptor.longDescription)
      }
    }
  })

  it('carries every parameter description onto the schema a host reads', () => {
    for (const descriptor of mcpDescriptors) {
      const properties = advertised(descriptor.mcp?.name ?? '').inputSchema.properties ?? {}

      for (const name of visibleParams(descriptor, 'mcp')) {
        expect((properties[name] as { description?: string }).description)
          .toBe(descriptor.params[name]?.description)
      }
    }
  })

  /**
   * The half of the contract a host reads about the answer rather than the
   * call. A tool without one hands its model a JSON blob to guess at, and the
   * SDK has nothing to validate the structured result against.
   */
  it('advertises an output schema describing an object for every tool', () => {
    for (const descriptor of mcpDescriptors) {
      const schema = advertised(descriptor.mcp?.name ?? '').outputSchema

      expect(schema, `${descriptor.mcp?.name} advertises no outputSchema`).toBeDefined()
      // An object root, on both eras: the 2025 wire shape requires one, and
      // without it the SDK wraps every result as `{ result: … }`.
      expect(schema?.type, descriptor.mcp?.name).toBe('object')
      // Either named fields or a described map — a schema with neither says
      // nothing more than "an object came back".
      expect(
        schema?.properties ?? schema?.anyOf ?? schema?.description,
        `${descriptor.mcp?.name} describes nothing about its result`,
      ).toBeDefined()
    }
  })

  it('hides no parameter by accident: a hidden one is absent, not silently optional', () => {
    for (const descriptor of mcpDescriptors) {
      const properties = advertised(descriptor.mcp?.name ?? '').inputSchema.properties ?? {}
      const hidden = Object.entries(descriptor.params)
        .filter(([, spec]) => spec.mcp?.hidden === true)
        .map(([name]) => name)

      for (const name of hidden) expect(properties).not.toHaveProperty(name)
    }
  })

  it('advertises behaviour hints a host can auto-approve or confirm on', () => {
    for (const descriptor of mcpDescriptors) {
      const tool = advertised(descriptor.mcp?.name ?? '')
      const annotations = tool.annotations ?? {}

      expect(annotations, `${tool.name} declares no annotations`).toEqual(descriptor.mcp?.annotations)
      expect(typeof annotations.readOnlyHint).toBe('boolean')
      expect(typeof annotations.openWorldHint).toBe('boolean')
      // A host reads an absent destructiveHint as true, so a writing tool
      // says which it is rather than being confirmed for a scaffold.
      if (annotations.readOnlyHint === false) {
        expect(typeof annotations.destructiveHint, `${tool.name} writes but declares no destructiveHint`).toBe('boolean')
      }
    }
  })

  it('marks a tool read-only exactly when it has no parameter that writes', () => {
    const writes = new Set(['write', 'remove', 'overwriteStale'])
    for (const descriptor of mcpDescriptors) {
      const readOnly = descriptor.mcp?.annotations.readOnlyHint
      const hasWritingParam = Object.keys(descriptor.params).some(name => writes.has(name))
      const isWriteOperation = ['write', 'remove', 'move', 'translate', 'translate-key', 'scaffold'].includes(descriptor.id)
      expect(readOnly, `${descriptor.id}`).toBe(!hasWritingParam && !isWriteOperation)
    }
  })

  it('finds tools to check at all, so none of the above passes vacuously', () => {
    expect(tools.length).toBe(mcpDescriptors.length)
    expect(tools.length).toBeGreaterThan(1)
  })
})

/**
 * The bounds on the reads that used to have none.
 *
 * A tool call is answered into a context window, so every read that can grow
 * with the project takes a window — and says, in the schema a host reads, what
 * to do when it returned one.
 */
describe('the unbounded reads are bounded', () => {
  const PAGED_TOOLS = ['search_translations', 'list_namespaces', 'get_missing_translations', 'get_translations']

  const spec = (id: string, param: string) =>
    descriptors.find(descriptor => descriptor.id === id)?.params[param]

  it.each(PAGED_TOOLS)('%s advertises limit and offset', (name) => {
    const properties = advertised(name).inputSchema.properties ?? {}

    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['limit', 'offset']))
    expect((properties.limit as { description?: string }).description).toContain('truncated')
    expect((properties.offset as { description?: string }).description).toContain('nextOffset')
  })

  it.each(PAGED_TOOLS)('%s leaves limit and offset optional', (name) => {
    expect(advertised(name).inputSchema.required ?? []).not.toContain('limit')
    expect(advertised(name).inputSchema.required ?? []).not.toContain('offset')
  })

  it('declares no limit default on the table, because the two surfaces disagree', () => {
    // `default` is applied by the CLI, which stays unbounded; the 100 a tool
    // call gets is resolved from the surface at run time. A default here would
    // cap the terminal too.
    for (const id of ['search', 'list-namespaces', 'missing', 'get']) {
      expect(spec(id, 'limit')?.default, id).toBeUndefined()
      expect(spec(id, 'limit')?.description, id).toContain('100 for a tool call, unlimited at a terminal')
      expect(spec(id, 'offset')?.default, id).toBeUndefined()
    }
  })

  it('offers get_translations a key prefix, and requires neither it nor the layer', () => {
    const tool = advertised('get_translations')

    expect(tool.inputSchema.properties).toHaveProperty('keyPrefix')
    expect(tool.inputSchema.required ?? []).toEqual(['locale'])
    expect(tool.description).toContain('EARG')
  })

  it('lets discover drop the translation prose, and defaults to dropping it for a tool call', () => {
    const properties = advertised('discover').inputSchema.properties ?? {}

    expect(properties).toHaveProperty('includeTranslationGuidance')
    // True on the table is the CLI's default; a tool call sends nothing and the
    // operation's own default (false) is what a host gets.
    expect(spec('discover', 'includeTranslationGuidance')?.default).toBe(true)
    expect((properties.includeTranslationGuidance as { description?: string }).description)
      .toContain('translationGuidanceOmitted')
  })
})
