/**
 * File-diversion of a large result, as the surfaces apply it.
 *
 * An operation returns its whole result and knows nothing about report files.
 * Everything the diversion needs is surface vocabulary — the `outputFile`
 * parameter, the `reportOutput` directory a project configures, the tool name
 * the file is written under — so it lives here, once, and both the command
 * factory and the tool registrar call it. That is what keeps every operation
 * returning exactly one shape and keeps the names of MCP tools out of the
 * engine.
 *
 * The heavy modules are imported per run rather than at module load: the
 * descriptor table is read by `--help`, by the tool registrar and by the
 * reference generator, none of which write a report.
 */

import { z } from 'zod'
import type { AnyOperationDescriptor, AnyReportSpec, GateSpec, Params } from './types.js'

/** The parameters a `report` declaration adds, in the order they are offered. */
export const REPORT_PARAM_NAMES = ['outputFile', 'codequalityOutput'] as const

/**
 * The parameters that request a diversion, built from what the operation
 * declared about its report. One description per concept, filled in with the
 * operation's own example, rather than one hand-written variation per command.
 */
export function reportParams(spec: AnyReportSpec): Params {
  return {
    outputFile: {
      type: 'string',
      description: `Absolute path to write the full JSON output to. Only a compact summary is returned to the caller, which is what you want for a result too large to read in one piece. Example: "${spec.outputFile.example}"`,
      ...(spec.outputFile.cli === undefined ? {} : { cli: spec.outputFile.cli }),
      ...(spec.outputFile.mcp === undefined ? {} : { mcp: spec.outputFile.mcp }),
    },
    ...(spec.codequality === undefined
      ? {}
      : {
          codequalityOutput: {
            type: 'string' as const,
            description: `Also write the ${spec.codequality.findings} as a GitLab Code Quality (CodeClimate) JSON report to this file path.`,
            // A pipeline artifact means nothing to an MCP host, which reads the
            // result it is handed rather than a file a runner collects
            // afterwards.
            mcp: { hidden: true },
          },
        }),
  }
}

/**
 * Every shape a caller can be handed for one operation: its whole result, and
 * — where a report is declared — the compact stand-in a diverted run returns
 * instead.
 *
 * The MCP server advertises this as the tool's `outputSchema`, and the SDK
 * rejects a `structuredContent` that fails it, so the union has to be exactly
 * the two shapes `divertToReport` can produce. Built here, from the same
 * declaration the diversion itself reads, rather than restated per tool.
 */
export function outputSchema(descriptor: AnyOperationDescriptor): z.ZodType {
  const spec = descriptor.report
  if (spec === undefined) return descriptor.result
  return z.union([
    descriptor.result,
    z.object({
      reportFile: z.string()
        .describe('Absolute path the full JSON result was written to. Read the file for the findings; the summary below is all that came back.'),
      summary: spec.summarySchema
        .describe('The counts from the full result, so a caller can act on them without reading the file.'),
    }),
  ])
}

/**
 * An operation's parameters with the report parameters merged in.
 *
 * They sit after what the operation takes and before the flags that only
 * decide an exit code, which is where they were written by hand and where
 * `--help` and the generated reference still show them.
 */
export function withReportParams(
  params: Params,
  gates: GateSpec[] | undefined,
  spec: AnyReportSpec,
): Params {
  const gateFlags = flagsOf(gates)
  const declared = Object.entries(params)
  return Object.fromEntries([
    ...declared.filter(([name]) => !gateFlags.has(name)),
    ...Object.entries(reportParams(spec)),
    ...declared.filter(([name]) => gateFlags.has(name)),
  ])
}

/**
 * Reject a report path that leaves the project before the operation runs.
 * The same check runs again when the file is written; doing it first spares a
 * caller a full monorepo scan whose result it was never going to receive.
 */
export async function assertReportPaths(
  descriptor: AnyOperationDescriptor,
  args: Record<string, unknown>,
): Promise<void> {
  if (descriptor.report === undefined) return
  const projectDir = typeof args.projectDir === 'string' ? args.projectDir : process.cwd()
  const { resolveOutputFile, validateReportPath } = await import('../core/report.js')
  for (const key of ['outputFile', 'codequalityOutput'] as const) {
    const value = pathArg(args[key])
    if (value === undefined) continue
    // resolveOutputFile turns a relative path into one under the project dir
    // and validates; an absolute path is validated as given.
    if (key === 'outputFile') resolveOutputFile(projectDir, value)
    else validateReportPath(projectDir, value)
  }
}

/**
 * Write the result where the caller asked for it, and hand back the compact
 * stand-in — or hand back the result untouched when nothing asked for a file.
 *
 * Called with the arguments the operation ran with, which is what lets an
 * operation answering several questions write each under its own report name.
 */
export async function divertToReport(
  result: unknown,
  descriptor: AnyOperationDescriptor,
  args: Record<string, unknown>,
): Promise<unknown> {
  const spec = descriptor.report
  if (spec === undefined || result === null || typeof result !== 'object') return result

  const projectDir = typeof args.projectDir === 'string' ? args.projectDir : process.cwd()
  const [
    { detectI18nConfig },
    { resolveOutputFile, resolveReportFilePath, validateReportPath },
    { writeCodequalityFile, writeReportFile },
  ] = await Promise.all([
    import('../config/detector.js'),
    import('../core/report.js'),
    import('../io/json-writer.js'),
  ])
  // A cache hit: the operation detected the same project directory a moment ago.
  const config = await detectI18nConfig(projectDir)

  const codequalityOutput = pathArg(args.codequalityOutput)
  if (spec.codequality !== undefined && codequalityOutput !== undefined) {
    const issues = spec.codequality.issues(result, { projectDir, config, args })
    if (issues !== undefined) {
      validateReportPath(projectDir, codequalityOutput)
      await writeCodequalityFile(codequalityOutput, issues)
    }
  }

  const name = typeof spec.name === 'function' ? spec.name(args) : spec.name
  const reportFile = resolveOutputFile(projectDir, pathArg(args.outputFile))
    ?? resolveReportFilePath(config, projectDir, name)
  if (reportFile === undefined) return result

  await writeReportFile(reportFile, result, { tool: name, args: requestedArgs(descriptor, args) })
  return { reportFile, summary: spec.summary(result) }
}

/**
 * What the report records as the request behind it: what the caller actually
 * asked for. Arguments left at their default say nothing a reader of the file
 * does not already know, the report parameters are how the file was asked for
 * rather than part of the question, and a gate flag decides an exit code and
 * nothing about the result.
 */
function requestedArgs(
  descriptor: AnyOperationDescriptor,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const excluded = new Set<string>([...REPORT_PARAM_NAMES, ...flagsOf(descriptor.gates)])
  const requested: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(descriptor.params)) {
    const value = args[name]
    if (excluded.has(name) || value === undefined || value === spec.default) continue
    requested[name] = value
  }
  return requested
}

function flagsOf(gates: GateSpec[] | undefined): Set<string> {
  const flags = new Set<string>()
  for (const gate of gates ?? []) {
    if (gate.flag !== undefined) flags.add(gate.flag)
  }
  return flags
}

/** A path parameter as the surfaces deliver it; anything else is not a path. */
function pathArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
