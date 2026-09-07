/**
 * Registers one MCP tool per operation descriptor.
 *
 * The tool's name, title, description, input schema and handler all come off
 * the descriptor, so a tool is not something anyone writes here — which is what
 * keeps it from drifting from the CLI command that runs the same operation.
 * What is left is what only a server can do: turn a declared parameter into a
 * zod schema, report progress over the wire, and hand back a JSON-RPC error
 * instead of throwing.
 */

import { z } from 'zod'
import { assertReportPaths, divertToReport, outputSchema, ToolError, toErrorMessage } from '@the-i18n-kit/cli'
import type { AnyOperationDescriptor, ParamSpec, ProgressFn, TranslateFn } from '@the-i18n-kit/cli'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'

export interface ToolContext {
  /** Where an operation runs when the caller names no project directory. */
  defaultProjectDir: string
  /** The startup-resolved backend, absent in agent mode. */
  translateFn?: TranslateFn
  /**
   * Result decoration the server owns rather than the operation: today only
   * `discover`, which reports the server's own translation mode alongside the
   * project's configuration.
   */
  decorate?: Record<string, (result: unknown) => unknown>
}

/**
 * A result as a tool answers with it: the typed value under `structuredContent`
 * and the same value as text.
 *
 * Both, not one: `structuredContent` is the typed value a host hands its model,
 * and what the SDK validates against the tool's advertised `outputSchema`; the
 * text block is what a client reading only `content` renders. The SDK projects
 * the pair onto whichever protocol era the connection negotiated.
 */
export function jsonContent(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  }
}

/** Format a caught error into an MCP tool error response. */
export function toolErrorResponse(tool: string, error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof ToolError
          ? `[${error.code}] ${error.message}`
          : `Error running ${tool}: ${toErrorMessage(error)}`,
      },
    ],
    isError: true,
  }
}

const projectDirSchema = z
  .string()
  .optional()
  .describe('Absolute path to the project root. Defaults to I18N_PROJECT_DIR, then server cwd. Example: "/home/user/my-app".')

/** Register every descriptor the server advertises as a tool. */
export function registerTools(
  server: McpServer,
  descriptors: readonly AnyOperationDescriptor[],
  ctx: ToolContext,
): void {
  for (const descriptor of descriptors) {
    if (descriptor.mcp !== null) registerFromDescriptor(server, descriptor, ctx)
  }
}

export function registerFromDescriptor(
  server: McpServer,
  descriptor: AnyOperationDescriptor,
  ctx: ToolContext,
): void {
  const tool = descriptor.mcp
  if (tool === null) {
    throw new Error(`Operation "${descriptor.id}" declares no MCP tool.`)
  }
  const decorate = ctx.decorate?.[tool.name]

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      // The one-line summary plus the prose written for a model choosing a
      // tool. The CLI shows only the summary; `--help` has to stay a line.
      description: [descriptor.description, descriptor.longDescription]
        .filter(part => part !== undefined && part.length > 0)
        .join(' '),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      inputSchema: inputSchema(descriptor),
      // What the answer looks like, for a host that shows its model the shape
      // of a result rather than only the shape of a call. The SDK rejects a
      // structured result that fails this, so it covers every shape the handler
      // below can return — the whole result, and the compact stand-in a
      // diverted run answers with.
      outputSchema: outputSchema(descriptor),
    },
    async (args: Record<string, unknown>, requestCtx: ServerContext) => {
      try {
        const { projectDir, ...rest } = args
        const operationArgs = {
          ...rest,
          projectDir: (projectDir as string | undefined) ?? ctx.defaultProjectDir,
        }
        await assertReportPaths(descriptor, operationArgs)
        const result = await descriptor.run(
          operationArgs,
          { surface: 'mcp', translateFn: ctx.translateFn, ...progressReporter(requestCtx) },
        )
        // A result the caller asked to have written to a file leaves as the
        // summary of one. Applied here rather than in the operation, so both
        // surfaces divert the same way.
        const output = await divertToReport(result, descriptor, operationArgs)
        return jsonContent(decorate === undefined ? output : decorate(output))
      }
      catch (error) {
        return toolErrorResponse(tool.name, error)
      }
    },
  )
}

/**
 * The tool's input schema: every parameter it does not hide, plus the project
 * directory every operation accepts without declaring it.
 */
function inputSchema(descriptor: AnyOperationDescriptor) {
  const shape: Record<string, z.ZodType> = {}
  for (const [name, spec] of Object.entries(descriptor.params)) {
    if (spec.mcp?.hidden === true) continue
    // Described last, so the description lands on the property a host reads
    // rather than on the type inside an optional wrapper.
    shape[name] = (spec.required === true ? paramSchema(spec) : paramSchema(spec).optional())
      .describe(spec.description)
  }
  shape.projectDir = projectDirSchema
  return z.object(shape)
}

function paramSchema(spec: ParamSpec): z.ZodType {
  switch (spec.type) {
    case 'boolean':
      return z.boolean()
    case 'number': {
      const base = spec.integer === true ? z.number().int() : z.number()
      return spec.min === undefined ? base : base.min(spec.min)
    }
    case 'string[]':
      return spec.allowAll === true
        ? z.union([z.literal('all'), z.array(z.string())])
        : z.array(z.string())
    case 'record':
      // The one nested shape on the surface: a dot-path key mapped to a locale
      // map. Stated here so no spec has to carry a schema of its own.
      return z.record(
        z.string().describe('Dot-separated key path, e.g. "auth.login.title"'),
        z.record(
          z.string().describe('Locale code or file name, e.g. "en", "en-US", "en-US.json"'),
          z.string().describe('Translation string value for this locale'),
        ),
      )
    default:
      return spec.enum === undefined ? z.string() : z.enum([...spec.enum])
  }
}

/**
 * Progress notifications for the caller that asked for them.
 *
 * Wired for every tool; the ones long enough to be worth watching report
 * (translating, orphan scans). An operation that never calls the reporter
 * sends nothing, and a tool that starts reporting needs no change here.
 *
 * Invariant the total relies on: an operation calls onProgressTotal during its
 * pre-scan, before the first progress call, so the total is set by the time a
 * notification goes out.
 *
 * `progress` counts notifications rather than units of work, so an operation
 * reporting in strides (one call per N files) announces its total in that same
 * unit — otherwise its last notification would stop short of it.
 */
function progressReporter(ctx: ServerContext): {
  progressFn?: ProgressFn
  onProgressTotal?: (total: number) => void
} {
  const progressToken = ctx.mcpReq._meta?.progressToken
  if (progressToken === undefined) return {}

  let current = 0
  let total: number | undefined

  return {
    progressFn: async (message: string) => {
      current++
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken, progress: current, total, message },
      })
    },
    onProgressTotal: (value: number) => { total = value },
  }
}
