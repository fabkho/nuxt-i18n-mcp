/**
 * Renders the MCP reference: one overview page carrying what is true of the
 * whole tool surface, and one page per advertised tool.
 *
 * Everything comes from the listing the running server hands a host, so a tool
 * page cannot document a parameter the server does not accept.
 */

import { buildMcpModel, toolsAccepting } from './mcp-model.js'
import { GENERATED_NOTICE, cell, code, frontmatter, page, prose, table, textCell } from './markdown.js'
import type { HintDoc, ParamDoc, ToolDoc } from './mcp-model.js'
import type { McpSource, ReferenceOutput } from './types.js'

/** Directory under `docs/content`. The numeric prefixes are stripped from routes. */
const DIR = '9.reference/2.mcp'
/** The route the pages link to each other by. */
const ROUTE = '/reference/mcp'
/** The route of the generated CLI reference, which pairings link into. */
const CLI_ROUTE = '/reference/cli'

const BINARY = 'the-i18n-mcp'
const PACKAGE = '@the-i18n-kit/mcp'
const CLI_PACKAGE = '@the-i18n-kit/cli'
const CLI_BINARY = 'the-i18n-cli'

/** The parameter that diverts a full result to a file. */
const OUTPUT_FILE = 'outputFile'

export function renderMcpReference(
  source: McpSource,
  commandNames: readonly string[],
): ReferenceOutput {
  const model = buildMcpModel(source, commandNames)
  const output: ReferenceOutput = new Map()

  output.set(`${DIR}/index.md`, renderOverview(model.tools, model.universalParams))
  for (const tool of model.tools) {
    output.set(`${DIR}/${tool.name}.md`, renderTool(tool))
  }

  return output
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function renderOverview(tools: ToolDoc[], universalParams: string[]): string {
  return page([
    frontmatter({
      title: 'MCP Tools',
      description: `Every tool ${PACKAGE} advertises to an MCP host, generated from the server's own tool listing.`,
    }),
    GENERATED_NOTICE,
    '# MCP Tools',
    `Every tool ${code(BINARY)} advertises is listed below and documented on its own page, with the parameters and descriptions an MCP host receives.`,
    '## Tools',
    toolTable(tools),
    ...pairingSection(tools),
    ...universalParamSection(universalParams),
    ...resultSection(tools),
    ...outputFileSection(tools),
  ])
}

function toolTable(tools: ToolDoc[]): string {
  const rows = tools.map(tool => [
    `[${code(tool.name)}](${ROUTE}/${tool.name})`,
    textCell(tool.title),
  ])
  return table(['Tool', 'What it does'], rows)
}

/**
 * Stated once for the whole surface rather than on every tool page: the flags of
 * a paired command are documented on the command's own page.
 */
function pairingSection(tools: ToolDoc[]): string[] {
  const rows = tools.flatMap(tool => tool.command === undefined
    ? []
    : [[
        `[${code(tool.name)}](${ROUTE}/${tool.name})`,
        `[${code(`${CLI_BINARY} ${tool.command}`)}](${CLI_ROUTE}/${tool.command})`,
      ]])
  if (rows.length === 0) return []

  return [
    '## Paired CLI Commands',
    `${code(PACKAGE)} depends on ${code(CLI_PACKAGE)} and calls the same functions the commands call, so a tool and the command it pairs with read the same project and return the same result. Where you run an operation from is a matter of who is driving.`,
    `A tool parameter and the flag that reaches it carry one name — ${code('targetLocales')} is ${code('--targetLocales')}, with the shorter spelling the CLI used before kept as an alias — so the [command pages](${CLI_ROUTE}) document the flags rather than these pages restating them.`,
    table(['Tool', 'Command'], rows),
  ]
}

function universalParamSection(universalParams: string[]): string[] {
  if (universalParams.length === 0) return []
  const names = universalParams.map(name => code(name)).join(', ')
  return [
    '## Parameters Every Tool Accepts',
    `${names} appears on every tool.`,
  ]
}

/**
 * What every tool answers with, stated once for the surface. The tool pages
 * list their own fields; how a result reaches a host is the same everywhere.
 */
function resultSection(tools: ToolDoc[]): string[] {
  if (!tools.every(tool => tool.result !== undefined)) return []
  return [
    '## What a Tool Returns',
    `Every tool advertises an ${code('outputSchema')} and returns its result as ${code('structuredContent')}, so a host hands its model typed data rather than a JSON blob to parse. The same JSON is sent as a text block for hosts that read only that. Each tool page lists the top-level fields of its own result.`,
  ]
}

/** Derived: the tools listed here are the ones whose schema carries the parameter. */
function outputFileSection(tools: ToolDoc[]): string[] {
  const diverting = toolsAccepting(tools, OUTPUT_FILE)
  if (diverting.length === 0) return []
  const names = diverting.map(tool => `[${code(tool.name)}](${ROUTE}/${tool.name})`).join(', ')
  return [
    '## Diverting a Large Result',
    `${names} accept ${code(OUTPUT_FILE)}. Given an absolute path, the tool writes its full JSON result there and returns a compact summary instead, so a result covering thousands of keys never enters the conversation.`,
  ]
}

// ---------------------------------------------------------------------------
// One tool
// ---------------------------------------------------------------------------

function renderTool(tool: ToolDoc): string {
  return page([
    frontmatter({ title: tool.name, description: tool.description }),
    GENERATED_NOTICE,
    prose(tool.description),
    '## Parameters',
    ...paramSection(tool),
    ...resultFieldSection(tool),
    ...hintSection(tool.hints),
    ...pairedCommandSection(tool),
  ])
}

/**
 * The top level of the result, and no further: the nested shapes below it run
 * several levels deep, and a reader who needs them has the advertised schema.
 */
function resultFieldSection(tool: ToolDoc): string[] {
  const result = tool.result
  if (result === undefined) return []
  if (result.fields.length === 0) {
    return ['## Result', `${code(result.type)}${result.description === '' ? '' : ` — ${prose(result.description)}`}`]
  }
  const rows = result.fields.map(field => [
    code(field.name),
    code(cell(field.type)),
    textCell(field.description),
  ])
  return ['## Result', table(['Field', 'Type', 'Description'], rows)]
}

function paramSection(tool: ToolDoc): string[] {
  if (tool.params.length === 0) {
    return [`${code(tool.name)} takes no parameters.`]
  }
  return [paramTable(tool.params)]
}

function paramTable(params: ParamDoc[]): string {
  const rows = params.map(param => [
    code(param.name),
    code(cell(param.type)),
    param.required ? 'yes' : 'no',
    textCell(param.description),
  ])
  return table(['Parameter', 'Type', 'Required', 'Description'], rows)
}

/**
 * Behaviour hints travel with the tool and shape what a host does before
 * calling it, so they belong on the page even though most tools send none.
 */
function hintSection(hints: HintDoc[]): string[] {
  if (hints.length === 0) return []
  const rows = hints.map(hint => [code(hint.name), code(hint.value)])
  return [
    '## Behavior Hints',
    'A host reads these to decide whether a call needs your confirmation first.',
    table(['Hint', 'Value'], rows),
  ]
}

function pairedCommandSection(tool: ToolDoc): string[] {
  if (tool.command === undefined) return []
  return [
    '## Paired CLI Command',
    `The same operation runs from a terminal as [${code(`${CLI_BINARY} ${tool.command}`)}](${CLI_ROUTE}/${tool.command}), whose page documents its flags.`,
  ]
}
