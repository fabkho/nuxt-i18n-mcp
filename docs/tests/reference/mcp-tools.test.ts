/**
 * Contract tests for the MCP reference against the running server.
 *
 * The listing comes from the same loader the generator uses, which starts the
 * built server over stdio and issues `tools/list` — so these tests assert what
 * an MCP host is handed is what the site documents. There is no per-tool list
 * here to forget to update: adding a tool and forgetting the docs cannot pass
 * this file, and neither can changing a parameter.
 *
 * Requires `pnpm build`, because the loader drives the built entry point rather
 * than the source. It says so when the build is missing.
 */

import { describe, expect, it } from 'vitest'
import { buildReference } from '../../generate/reference/build.js'
import { PAIRED_COMMANDS, buildMcpModel } from '../../generate/reference/mcp-model.js'
import { loadCliSource } from '../../generate/sources/cli.js'
import { loadMcpSource } from '../../generate/sources/mcp.js'
import { fixtureSources } from './fixtures.js'
import { mcpOverview, pagedTools, rowNames, section, tableRow, toolPage } from './helpers.js'

const cli = await loadCliSource()
const mcp = await loadMcpSource()
const output = buildReference(fixtureSources({ cli, mcp }))
const commandNames = cli.entries.map(entry => entry.name)
const model = buildMcpModel(mcp, commandNames)

describe('the MCP reference against the advertised tool listing', () => {
  it('finds tools to document at all', () => {
    // Everything below is satisfied vacuously by an empty listing, which is what
    // a server that failed to start would hand back.
    expect(mcp.tools.length).toBeGreaterThan(1)
  })

  it('gives every advertised tool a page', () => {
    expect([...pagedTools(output)].sort()).toEqual(mcp.tools.map(tool => tool.name).sort())
  })

  it('links every tool page from the overview', () => {
    const markdown = mcpOverview(output)
    for (const tool of mcp.tools) {
      expect(markdown).toContain(`(/reference/mcp/${tool.name})`)
    }
  })

  it('documents exactly the parameters each tool advertises, and which are required', () => {
    for (const tool of model.tools) {
      const params = section(toolPage(output, tool.name), '## Parameters')
      expect([...rowNames(params)].sort()).toEqual(tool.params.map(param => param.name).sort())

      for (const param of tool.params) {
        expect(tableRow(params, param.name)).toContain(param.required ? 'yes' : 'no')
      }
    }
  })

  it('uses the advertised description, unaltered, on each tool page', () => {
    for (const tool of model.tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(toolPage(output, tool.name)).toContain(tool.description)
    }
  })

  it('advertises a parameter description for every parameter it documents', () => {
    // A blank description column is a gap in the server's own schema, not in the
    // reference — and it reads as one to anyone using the tool from a host.
    for (const tool of model.tools) {
      for (const param of tool.params) {
        expect(param.description, `${tool.name}.${param.name}`).not.toBe('')
      }
    }
  })

  it('documents the result of every advertised tool', () => {
    for (const tool of model.tools) {
      expect(tool.result, `${tool.name} advertises no output schema`).toBeDefined()
      const result = section(toolPage(output, tool.name), '## Result')

      // Either the fields, or the type of a result that has none — never an
      // empty section, which reads as "nothing comes back".
      expect(result.trim().length, tool.name).toBeGreaterThan(0)
      if (tool.result !== undefined && tool.result.fields.length > 0) {
        expect([...rowNames(result)].sort(), tool.name)
          .toEqual(tool.result.fields.map(field => field.name).sort())
      }
    }
  })

  it('advertises a description for every result field it documents', () => {
    // A blank description column is a gap in the server's own schema, and it
    // reads as one to the model the schema was written for.
    for (const tool of model.tools) {
      for (const field of tool.result?.fields ?? []) {
        expect(field.description, `${tool.name}.${field.name}`).not.toBe('')
      }
      if (tool.result !== undefined && tool.result.fields.length === 0) {
        expect(tool.result.description, `${tool.name} result`).not.toBe('')
      }
    }
  })

  it('pairs a tool only with a CLI command the reference documents', () => {
    const paired = model.tools.filter(tool => tool.command !== undefined)
    expect(paired.length).toBeGreaterThan(0)

    for (const tool of paired) {
      const command = tool.command as string
      expect(commandNames).toContain(command)
      expect(toolPage(output, tool.name)).toContain(`(/reference/cli/${command})`)
      expect(mcpOverview(output)).toContain(`(/reference/cli/${command})`)
    }
  })

  it('declares no pairing for a tool the server no longer advertises', () => {
    // A stale entry renders nothing, so it cannot break a page — it just makes
    // the map lie about the surface.
    const advertised = new Set(mcp.tools.map(tool => tool.name))
    for (const name of Object.keys(PAIRED_COMMANDS)) {
      expect(advertised, `PAIRED_COMMANDS names ${name}`).toContain(name)
    }
  })

  it('repeats no command flag on a tool page', () => {
    // The paired command's flags belong on its own generated page. Restating
    // them here is how the READMEs came to contradict each other.
    for (const tool of model.tools) {
      expect(toolPage(output, tool.name)).not.toMatch(/`--[A-Za-z]/)
    }
  })
})
