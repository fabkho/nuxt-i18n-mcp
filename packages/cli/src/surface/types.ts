/**
 * The declaration language both surfaces are built from.
 *
 * A descriptor states an operation once — what it does, what it takes, what it
 * runs — and the CLI command factory and the MCP tool registrar each read the
 * same table. The two surfaces used to be independent transcriptions of the
 * same fifteen operations, which is why a parameter could be called `ref` in
 * one and `referenceLocale` in the other, with descriptions that had drifted
 * apart and nothing to notice.
 *
 * A parameter therefore has ONE name. Where the CLI used a shorter spelling it
 * survives as an alias, so `--ref` keeps working while the name both surfaces
 * agree on is `referenceLocale`. The only other latitude a surface has is to
 * hide a parameter it genuinely does not have — a CI gate flag means nothing
 * over MCP, a provider flag means nothing to a server that resolves its backend
 * from the environment — and hiding one has to be written down, which is what
 * the drift test reads.
 */

import type { z } from 'zod'
import type { I18nConfig } from '../config/types.js'
import type { CodeQualityIssue } from '../core/codequality.js'
import type { ProgressFn, TranslateFn } from '../core/types.js'
import { applyGuidance } from './guidance.js'
import { withReportParams } from './report.js'

/** Which surface is invoking an operation. They differ only in the prose they own. */
export type Surface = 'cli' | 'mcp'

/**
 * What a parameter carries.
 *
 * `string[]` is a list on both surfaces: MCP passes a JSON array, the CLI a
 * comma-separated string it splits. `record` is the one nested shape on the
 * surface — the key → locale → value map `write` takes — so the builders state
 * its inner levels once instead of every spec carrying a schema.
 */
export type ParamType = 'string' | 'boolean' | 'number' | 'string[]' | 'record'

/** The value shape of a `record` parameter: dot-path key → locale ref → string. */
export type TranslationsRecord = Record<string, Record<string, string>>

export interface CliParamOptions {
  /**
   * Additional spellings citty accepts for this flag. Single characters render
   * as `-d`; longer ones are the flag's previous name, kept working after the
   * descriptor took the name the MCP tool used.
   */
  alias?: string | readonly string[]
  /** Not exposed as a flag. Every use of this states why in a comment. */
  hidden?: boolean
}

export interface McpParamOptions {
  /** Not part of the tool's input schema. Every use of this states why in a comment. */
  hidden?: boolean
}

/** One parameter of an operation, as both surfaces expose it. */
export interface ParamSpec {
  type: ParamType
  /**
   * The one description. It reaches `--help`, the generated CLI page and the
   * JSON Schema an MCP host hands its model, so it is written for a reader who
   * knows neither surface: no `--flag` spellings, no "this tool".
   */
  description: string
  required?: boolean
  /**
   * Applied by the CLI so `--help` can state it. Deliberately not put into the
   * JSON Schema: the operations already apply their own defaults, and a schema
   * default would make a host send a value the caller never chose.
   */
  default?: unknown
  /** The accepted values. The CLI validates against them and MCP emits an enum. */
  enum?: readonly string[]
  /** Numbers only: reject a fractional value. */
  integer?: boolean
  /** Numbers only: reject anything below this. */
  min?: number
  /** `string[]` parameters that also accept the literal "all". */
  allowAll?: boolean
  cli?: CliParamOptions
  mcp?: McpParamOptions
}

export type Params = Record<string, ParamSpec>

/**
 * A CI gate a command evaluates. `counter` is the field of `result.summary`
 * carrying the observed value.
 *
 * The two shapes are a union rather than one type with optional halves so the
 * invariants hold at compile time: a flagged gate always has a flag to read
 * its name and threshold from, and a flagless one always carries both itself.
 * Stated as options, `{ counter, threshold }` type-checks and then has no name
 * to report the gate under.
 */
export type GateSpec = FlaggedGateSpec | AlwaysOnGateSpec

interface GateSpecBase {
  counter: string
  /** 'above' trips when observed > threshold (default); 'below' when observed < threshold. */
  direction?: 'above' | 'below'
}

/**
 * Requested by a flag, and evaluated only when that flag is passed. Omitting
 * `threshold` takes it from the flag's own value, so a boolean flag pairs with
 * `threshold: 0` and a numeric one (`--failUnder 90`) omits it.
 */
export interface FlaggedGateSpec extends GateSpecBase {
  flag: string
  name?: never
  threshold?: number
}

/**
 * Always evaluated, for findings that are a defect rather than a threshold — a
 * key that renders raw in production is not something you opt into caring
 * about. It still reports as a gate: the run succeeded, and what it found is
 * what you are being told about.
 */
export interface AlwaysOnGateSpec extends GateSpecBase {
  flag?: never
  name: string
  threshold: number
}

/**
 * What the surface hands a report builder beyond the result: the project the
 * operation ran against and the arguments it ran with.
 */
export interface ReportContext<A = Record<string, unknown>> {
  projectDir: string
  /** The project's resolved i18n configuration, as the operation itself read it. */
  config: I18nConfig
  /** The operation's arguments, as the surface resolved them. */
  args: A
}

/**
 * How a result too large to hand back is diverted to a file.
 *
 * An operation always returns its whole result. Whether that result is written
 * to disk and replaced by a compact stand-in is the surface's decision — it is
 * the surface that owns `outputFile`, the configured report directory and the
 * name the file is written under — so the operations know nothing about any of
 * it, and a descriptor declaring this is what gives an operation the parameters
 * that request it.
 */
export interface ReportSpec<R = unknown, A = Record<string, unknown>> {
  /**
   * The file's base name under the configured report directory, and the tool
   * name recorded inside the report. A function where one operation answers
   * different questions and writes each under its own name — pipelines archive
   * these paths, so they are part of the contract.
   */
  name: string | ((args: A) => string)
  /** The compact stand-in returned once the full result is on disk. */
  summary: (result: R) => unknown
  /**
   * That stand-in, as a schema. Declared next to the builder so the tool's
   * advertised output schema can state both shapes an operation with a report
   * can answer with, exactly — a host validates a result against that schema,
   * so a summary described as `unknown` would document nothing and accept
   * anything.
   *
   * Written as a projection of the operation's own result schema wherever the
   * summary is a field of the result, which is what keeps the two together.
   */
  summarySchema: z.ZodType
  /**
   * The `outputFile` parameter as this operation offers it. Declared here and
   * nowhere else, so an operation cannot advertise the parameter without the
   * plumbing behind it, nor grow the plumbing without the parameter.
   */
  outputFile: {
    /** The example path its description carries. */
    example: string
    cli?: CliParamOptions
    mcp?: McpParamOptions
  }
  /** The same findings, as a GitLab Code Quality report the pipeline collects. */
  codequality?: {
    /** What the findings are called in the parameter's description. */
    findings: string
    /**
     * Returning undefined writes nothing, which is not the same as writing an
     * empty array: the empty array is the baseline the merge-request widget
     * diffs against, so it is only right for a run that looked for these
     * findings and found none.
     */
    issues: (result: R, ctx: ReportContext<A>) => CodeQualityIssue[] | undefined
  }
}

/**
 * A report spec with its result type erased, as the runner sees it.
 *
 * `any` rather than `unknown`: the runner holds a result whose type it cannot
 * know, while every declaration site is checked against its own operation's
 * result type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type AnyReportSpec = ReportSpec<any>

/** How the MCP server advertises an operation as a tool. */
export interface McpToolSpec {
  name: string
  /** The display title a host shows. */
  title: string
  /**
   * Behaviour hints a host reads before it decides whether to ask the user.
   * Every tool declares them: a host treats an absent `destructiveHint` as
   * true and an absent `openWorldHint` as true, so leaving them out makes a
   * read tool look like a deletion that reaches the network. `readOnlyHint`
   * is what lets a host auto-approve the reads; `destructiveHint` is what
   * makes it confirm a removal but not a scaffold.
   */
  annotations: McpToolAnnotations
}

/** The subset of MCP tool annotations the server advertises. */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint: boolean
  /** Required for a tool that writes: whether it can destroy data a user has. */
  destructiveHint?: boolean
  /** Whether repeating the call with the same arguments changes nothing more. */
  idempotentHint?: boolean
  /** Whether the tool reaches beyond the project — the translating tools call a provider. */
  openWorldHint: boolean
}

/** How the CLI exposes an operation as a command. */
export interface CliCommandSpec {
  name: string
}

/**
 * What a surface hands an operation beyond its parameters.
 *
 * `surface` exists because the guidance an agent-mode result carries is the
 * caller's, not the operation's: a terminal is told to pass `--provider`, a
 * host is told to translate the fallback contexts inline. Keeping both strings
 * in one place is the point — they used to sit in two files and say different
 * things about the same state.
 */
export interface OperationContext {
  surface: Surface
  /** Provider-backed translation, when the surface resolved one. */
  translateFn?: TranslateFn
  /**
   * Progress reporting, when the caller asked for it. Only MCP does — a
   * terminal is left with its exit code. The operations that take long enough
   * to report call it (translating, orphan scans); the rest never do.
   */
  progressFn?: ProgressFn
  /**
   * The number of steps the operation is about to report, counted in whatever
   * unit it reports in. Called once, before the first `progressFn` call, so a
   * notification never goes out against an unknown total.
   */
  onProgressTotal?: (total: number) => void
}

/**
 * The value of one parameter as the operation receives it: already split,
 * parsed and validated by whichever surface took it.
 */
type ParamValue<S extends ParamSpec>
  = S extends { type: 'boolean' } ? boolean
    : S extends { type: 'number' } ? number
      : S extends { type: 'record' } ? TranslationsRecord
        : S extends { type: 'string[]', allowAll: true } ? string[] | 'all'
          : S extends { type: 'string[]' } ? string[]
            : S extends { type: 'string', enum: readonly (infer E extends string)[] } ? E
              : S extends { type: 'string' } ? string
                : never

type RequiredParamNames<P extends Params> = {
  [K in keyof P]-?: P[K] extends { required: true } ? K : never
}[keyof P]

/**
 * The arguments an operation's `run` receives. Required parameters are present,
 * the rest are optional, and `projectDir` is always available because both
 * surfaces resolve it themselves (the CLI from `--projectDir`, the server from
 * I18N_PROJECT_DIR) rather than making every operation declare it.
 */
export type OperationArgs<P extends Params = Params> =
  & { [K in RequiredParamNames<P> & keyof P]: ParamValue<P[K]> }
  & { [K in Exclude<keyof P, RequiredParamNames<P>>]?: ParamValue<P[K]> }
  & { projectDir?: string }

/** One operation, as both surfaces read it. */
export interface OperationDescriptor<P extends Params = Params> {
  /** Stable identifier, independent of what either surface calls it. */
  id: string
  /** Null for an operation the CLI does not expose. */
  cli: CliCommandSpec | null
  /** Null for an operation the MCP server does not advertise. */
  mcp: McpToolSpec | null
  /** One sentence, on both surfaces. */
  description: string
  /**
   * Further prose for a model deciding whether to call the tool: when to reach
   * for it, what the result carries, what it will not do. MCP only — a `--help`
   * line has to stay a line, and the generated CLI page says the same things in
   * its flag table.
   */
  longDescription?: string
  params: P
  /**
   * The whole result the operation answers with, as a schema.
   *
   * The MCP server advertises it as the tool's `outputSchema` and validates the
   * `structuredContent` it returns against it, so a host hands its model a
   * description of the answer and not just of the call. The schemas live in
   * `./results.ts`, which is where they are held to `core/types.ts`.
   *
   * Typed as an opaque schema rather than one tied to `run`'s return type: a
   * `run` whose arguments are contextually typed is not an inference site, so
   * nothing here can see the operation's own result type. `results.ts` checks
   * every schema against its interface instead.
   */
  result: z.ZodType
  /** CI gates the CLI evaluates. Exit codes are a CLI notion, so MCP ignores these. */
  gates?: GateSpec[]
  /**
   * The operation translates, so the surface has to hand it a backend: the CLI
   * resolves one from the provider flags, the server from its startup
   * environment. Without one the operation returns contexts to translate by
   * hand rather than failing.
   */
  usesTranslateFn?: boolean
  /**
   * The result is large enough to be worth writing to a file instead of
   * returning. Declaring this is what adds the parameters that request it and
   * what makes the configured report directory apply to the operation.
   *
   * The result type stays open: a `run` whose parameters are contextually typed
   * is not an inference site, so nothing here can see the operation's own
   * result type. Declaration sites annotate it on the builder instead, which is
   * what type-checks them.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  report?: ReportSpec<any, OperationArgs<P>>
  /**
   * Declared as a method so the table can hold descriptors with different
   * parameter maps: method parameters are compared bivariantly, which is what
   * lets `run` be typed against each operation's own arguments and still be
   * callable through the erased element type below.
   */
  run(args: OperationArgs<P>, ctx: OperationContext): Promise<unknown>
}

/**
 * A descriptor as the registrars see it, with `run` erased to plain arguments.
 * They build those arguments from a schema at runtime and cannot know the
 * per-operation type, so the erasure happens once, in `defineOperation`,
 * instead of at every call site.
 */
export type AnyOperationDescriptor = Omit<OperationDescriptor<Params>, 'run' | 'params' | 'report'> & {
  params: Params
  report?: AnyReportSpec
  run(args: Record<string, unknown>, ctx: OperationContext): Promise<unknown>
}

/**
 * Declare one operation. The `const` type parameter is what keeps `required:
 * true` and `enum: [...]` literal, so `run` receives `layer: string` rather
 * than `string | undefined` for a parameter the surface guarantees.
 *
 * An operation that declares a `report` gains the parameters that request one
 * here, so the two cannot drift apart.
 *
 * The run is wrapped so every result carries the next step it implies. Doing it
 * here rather than in each `run` is what keeps the operation id the guidance is
 * written against and the id the table declares the same string.
 */
export function defineOperation<const P extends Params>(
  descriptor: OperationDescriptor<P>,
): AnyOperationDescriptor {
  const erased = descriptor as unknown as AnyOperationDescriptor
  const guided: AnyOperationDescriptor = {
    ...erased,
    async run(args, ctx) {
      const result = await erased.run(args, ctx)
      applyGuidance(erased.id, result, ctx.surface)
      return result
    },
  }
  if (guided.report === undefined) return guided
  return { ...guided, params: withReportParams(guided.params, guided.gates, guided.report) }
}
