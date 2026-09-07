/**
 * Turns the advertised tool listing into the model the MCP pages render from.
 *
 * The listing is JSON Schema, which is what the protocol carries; the model
 * flattens each tool's top-level properties into rows and turns each property's
 * schema into a type a reader recognises. Nothing is declared per tool, so a
 * tool the server starts advertising is modelled without an edit here.
 */

import type { JsonSchemaLike, McpSource, McpToolListing } from './types.js'

/** One top-level parameter of a tool's input schema. */
export interface ParamDoc {
  name: string
  /** The schema rendered as a type, e.g. `string[]` or `"add" | "update"`. */
  type: string
  description: string
  required: boolean
}

/** One behaviour hint, as the server advertises it to a host. */
export interface HintDoc {
  name: string
  value: string
}

/** One top-level field of a tool's result. */
export interface ResultFieldDoc {
  name: string
  /** The field's schema rendered as a type, the same way a parameter's is. */
  type: string
  description: string
}

/**
 * A tool's result, as the reference renders it.
 *
 * Only the top level: a result carrying findings per locale, per layer and per
 * key nests several levels deep, and rendering that is a page rather than a
 * section. The fields and their descriptions are what a reader needs to know
 * what came back and what to read next.
 */
export interface ResultDoc {
  /** The whole result rendered as a type, for a schema whose root has no named fields. */
  type: string
  /** The description on the schema root. Empty for a schema that describes its fields instead. */
  description: string
  fields: ResultFieldDoc[]
}

export interface ToolDoc {
  name: string
  /** The advertised title, or the name when the server sends none. */
  title: string
  description: string
  params: ParamDoc[]
  hints: HintDoc[]
  /** Absent for a tool that advertises no output schema. */
  result?: ResultDoc
  /** The CLI command this tool pairs with, when one is declared and exposed. */
  command?: string
}

export interface McpModel {
  tools: ToolDoc[]
  /** Parameter names every advertised tool accepts. */
  universalParams: string[]
}

/**
 * Tools whose operation the CLI also exposes as a command.
 *
 * The only hand-maintained mapping in the MCP reference, and it exists because
 * nothing machine-readable connects the two names: `find_duplicate_keys` and
 * `find-duplicates` are the same operation, and no rule derives one from the
 * other. Every pairing is checked against the CLI's own command registry on each
 * build, so a renamed command fails generation rather than publishing a dead
 * link. A tool absent from here is documented without a pairing rather than
 * guessed at, which is why a new tool needs no edit in this file.
 */
export const PAIRED_COMMANDS: Record<string, string> = {
  discover: 'discover',
  get_translations: 'get',
  write_translations: 'write',
  get_missing_translations: 'missing',
  get_translation_status: 'status',
  search_translations: 'search',
  remove_translations: 'remove',
  move_translation_key: 'move',
  translate_missing: 'translate',
  translate_key: 'translate-key',
  find_orphan_keys: 'orphans',
  find_undefined_keys: 'check',
  find_duplicate_keys: 'find-duplicates',
  scaffold_locale: 'scaffold',
}

export function buildMcpModel(source: McpSource, commandNames: readonly string[]): McpModel {
  checkPairings(source.tools, commandNames)
  const tools = source.tools.map(toToolDoc)
  return { tools, universalParams: universalParams(tools) }
}

/**
 * A pairing naming a command the CLI does not register would render a link to a
 * page that does not exist, which fails the site build far from its cause.
 *
 * Only pairings for advertised tools are checked. A map entry for a tool the
 * server no longer sends renders nothing at all, so failing on it would block
 * generation over something invisible to a reader.
 */
function checkPairings(tools: McpToolListing[], commandNames: readonly string[]): void {
  for (const tool of tools) {
    const command = PAIRED_COMMANDS[tool.name]
    if (command === undefined || commandNames.includes(command)) continue
    throw new Error(
      `The MCP tool pairing ${tool.name} → ${command} is stale: the CLI registers no command `
      + `named ${command}. Update PAIRED_COMMANDS in docs/generate/reference/mcp-model.ts.`,
    )
  }
}

function toToolDoc(tool: McpToolListing): ToolDoc {
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? '',
    params: toParamDocs(tool.inputSchema),
    hints: toHintDocs(tool),
    result: toResultDoc(tool.outputSchema),
    command: PAIRED_COMMANDS[tool.name],
  }
}

function toResultDoc(schema: JsonSchemaLike | undefined): ResultDoc | undefined {
  if (schema === undefined) return undefined
  return {
    type: typeLabel(schema),
    description: schema.description ?? '',
    fields: resultFields(schema),
  }
}

/**
 * The top-level fields of a result, across every shape the tool can answer
 * with.
 *
 * A tool that diverts a large result to a file advertises a union of the whole
 * result and the compact stand-in, and an operation answering several questions
 * advertises one member per answer. All of them are the same tool's result, so
 * they read as one table; the first member to name a field describes it, since
 * a field two members share means the same thing in both.
 */
function resultFields(schema: JsonSchemaLike): ResultFieldDoc[] {
  const named = Object.entries(schema.properties ?? {})
  if (named.length > 0) {
    return named.map(([name, property]) => ({
      name,
      type: typeLabel(property),
      description: property.description ?? '',
    }))
  }

  const byName = new Map<string, ResultFieldDoc>()
  for (const member of schema.anyOf ?? []) {
    for (const field of resultFields(member)) {
      if (!byName.has(field.name)) byName.set(field.name, field)
    }
  }
  return [...byName.values()]
}

function toParamDocs(schema: JsonSchemaLike): ParamDoc[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    type: typeLabel(property),
    description: property.description ?? '',
    required: required.has(name),
  }))
}

/** The `annotations` a host reads, excluding the title it duplicates. */
function toHintDocs(tool: McpToolListing): HintDoc[] {
  return Object.entries(tool.annotations ?? {})
    .filter(([name, value]) => name !== 'title' && value !== undefined)
    .map(([name, value]) => ({ name, value: String(value) }))
}

/**
 * Parameter names shared by every tool, by intersection rather than by a list.
 * A parameter on every page is worth stating once instead.
 */
function universalParams(tools: ToolDoc[]): string[] {
  const [first, ...rest] = tools
  if (first === undefined) return []
  return first.params
    .map(param => param.name)
    .filter(name => rest.every(tool => tool.params.some(param => param.name === name)))
}

/** Tools accepting a given parameter, in listing order. */
export function toolsAccepting(tools: ToolDoc[], param: string): ToolDoc[] {
  return tools.filter(tool => tool.params.some(candidate => candidate.name === param))
}

/**
 * A JSON Schema rendered as a type expression.
 *
 * Enums and `const` render as their literals, since that is what a caller has
 * to pass; anything the schema does not describe renders as `unknown` rather
 * than as a guess. Alternatives that render alike collapse: a result whose rows
 * take two object shapes is `object[]`, and `object[] | object[]` would read as
 * a distinction the reader cannot see.
 */
function typeLabel(schema: JsonSchemaLike): string {
  if (schema.enum !== undefined) return schema.enum.map(literal).join(' | ')
  if (schema.const !== undefined) return literal(schema.const)
  if (schema.anyOf !== undefined) return [...new Set(schema.anyOf.map(typeLabel))].join(' | ')
  if (schema.type === 'array') return `${schema.items === undefined ? 'unknown' : typeLabel(schema.items)}[]`
  if (schema.type === 'object') return objectLabel(schema)
  return schema.type ?? 'unknown'
}

/**
 * An object schema. `write_translations` takes a map of key to a map of locale
 * to string, which reads as a record and not as "object".
 */
function objectLabel(schema: JsonSchemaLike): string {
  if (schema.properties !== undefined) return 'object'
  const keys = schema.propertyNames === undefined ? 'string' : typeLabel(schema.propertyNames)
  const values = typeof schema.additionalProperties === 'object'
    ? typeLabel(schema.additionalProperties)
    : 'unknown'
  return `Record<${keys}, ${values}>`
}

function literal(value: unknown): string {
  return JSON.stringify(value)
}
