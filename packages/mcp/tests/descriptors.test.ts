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

  it('finds tools to check at all, so none of the above passes vacuously', () => {
    expect(tools.length).toBe(mcpDescriptors.length)
    expect(tools.length).toBeGreaterThan(1)
  })
})
