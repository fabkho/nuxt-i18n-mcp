/**
 * The contract between the loaders that read sources off disk and the pure
 * builder that turns them into pages.
 *
 * Nothing here imports from the packages. The builder is handed already-loaded
 * data so that its tests can supply fixtures instead of a repository, and so
 * that the remaining reference sources (MCP tools, config schema, action
 * inputs) can be added as further fields on `ReferenceSources` without the
 * builder growing a filesystem dependency.
 */

/**
 * A citty `ArgDef`, narrowed to the fields the reference reads.
 *
 * Structural rather than imported: the builder must stay usable from a test
 * fixture, and citty's own type carries a discriminated union that makes a
 * hand-written fixture noisy for no gain here.
 */
export interface ArgDefLike {
  type?: string
  description?: string
  required?: boolean
  default?: unknown
  alias?: string | string[]
  valueHint?: string
}

/**
 * A gate the shared command factory evaluates, as retained on the definition.
 * A spec with no `flag` is always evaluated: the run still succeeds, and the
 * gate trips on what it found without having been asked to.
 */
export interface GateSpecLike {
  flag?: string
  name?: string
  counter: string
  direction?: string
  threshold?: number
}

/** A citty `CommandDef`, narrowed to the fields the reference reads. */
export interface CommandDefLike {
  meta?: { name?: string, description?: string }
  args?: Record<string, ArgDefLike>
  /** Retained by `createCommand`. Absent on hand-written definitions. */
  gates?: GateSpecLike[]
  /**
   * The handler. Never called — its identity is what distinguishes a genuine
   * command from an alias of one.
   */
  run?: unknown
}

/** One entry of the command registry, with its lazy loader already resolved. */
export interface CliCommandEntry {
  /** The registry key, which is the name a user types. */
  name: string
  def: CommandDefLike
}

/** The three exit codes the shared command factory assigns. */
export interface ExitCodeValues {
  success: number
  runFailed: number
  gateTripped: number
}

export interface CliSource {
  /**
   * Registry order, and the whole surface: every registered command is a
   * subcommand the CLI exposes. Aliases are still present as their own entries.
   */
  entries: CliCommandEntry[]
  exitCodes: ExitCodeValues
}

/**
 * A JSON Schema, narrowed to the keywords the MCP tool reference reads.
 *
 * The server advertises its input schemas as JSON Schema draft 2020-12, which is
 * what the protocol carries and what a host validates a call against.
 * Recursive, because a parameter can be an array of strings or a map of maps.
 */
export interface JsonSchemaLike {
  type?: string
  description?: string
  enum?: unknown[]
  const?: unknown
  items?: JsonSchemaLike
  anyOf?: JsonSchemaLike[]
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  additionalProperties?: JsonSchemaLike | boolean
  propertyNames?: JsonSchemaLike
}

/** One tool exactly as `tools/list` advertises it. */
export interface McpToolListing {
  name: string
  /** The human-readable name a host may show in place of `name`. */
  title?: string
  description?: string
  inputSchema: JsonSchemaLike
  /**
   * The shape of the result, which a host shows its model and validates the
   * tool's structured answer against. Optional here because the protocol allows
   * a tool without one; every tool this server advertises carries one.
   */
  outputSchema?: JsonSchemaLike
  /**
   * Behaviour hints a host uses to decide how much ceremony a call needs — a
   * read-only tool can be called without confirmation.
   */
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpSource {
  /** Listing order, as the server advertises it. */
  tools: McpToolListing[]
}

/** One `inputs` entry of the action manifest. */
export interface ActionInput {
  name: string
  description: string
  required: boolean
  /** Absent when the manifest declares no default. */
  default?: string
}

/** One `outputs` entry of the action manifest. */
export interface ActionOutput {
  name: string
  description: string
}

export interface ActionSource {
  name: string
  description: string
  /** Manifest order, which groups related inputs together. */
  inputs: ActionInput[]
  outputs: ActionOutput[]
}

/** Every loaded source the builder renders from. */
/**
 * A JSON Schema node, narrowed to the keywords the configuration reference
 * reads.
 *
 * Structural rather than a dependency on a JSON Schema type package: the
 * document comes from `z.toJSONSchema()` over the kit's own config schema, which
 * uses a small, known subset of the vocabulary, and a fixture has to stay
 * hand-writable.
 */
export interface JsonSchemaNode {
  type?: string | string[]
  description?: string
  deprecated?: boolean
  enum?: unknown[]
  const?: unknown
  /** Suggested values. `framework` carries the registered adapter names here. */
  examples?: unknown[]
  minLength?: number
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  /** A schema for unlisted properties, or `false` when there may be none. */
  additionalProperties?: JsonSchemaNode | boolean | undefined
}

/** The published JSON Schema document, whose root is always an object schema. */
export interface ConfigJsonSchema extends JsonSchemaNode {
  properties: Record<string, JsonSchemaNode>
}

export interface ConfigSource {
  /** The document `renderConfigJsonSchema()` publishes, already parsed. */
  schema: ConfigJsonSchema
  /**
   * Keys `@the-i18n-kit/nuxt` rejects in a hand-written config because Nuxt
   * resolves them itself — its `MODULE_OWNED_KEYS`.
   */
  moduleOwnedKeys: readonly string[]
  /**
   * Schema keys deliberately absent from the typed `ProjectConfig` interface, so
   * declaring one in `i18n-kit.config.ts` is a type error even though the schema
   * accepts the value at runtime.
   */
  untypedKeys: readonly string[]
  /** The options the `i18nKit` block in `nuxt.config.ts` accepts. */
  nuxtModuleOptions: readonly string[]
}

/** Every loaded source the builder renders from. */

export interface ReferenceSources {
  cli: CliSource
  mcp: McpSource
  action: ActionSource
  config: ConfigSource
}

/**
 * Output paths are relative to `docs/content`, so the builder never needs to
 * know where the content directory lives.
 */
export type ReferenceOutput = Map<string, string>

/** One flag, as the reference renders it. */
export interface ArgDoc {
  /**
   * The declared name, which is what the flag looks like in `--help`:
   * `dryRun` renders as `--dryRun`. citty registers the kebab-case form as an
   * alias, so `--dry-run` works too; the overview says so once.
   */
  name: string
  type: string
  description: string
  required: boolean
  default: unknown
  alias: string[]
  valueHint?: string
}

/** A second registry name for a command that already has a page. */
export interface AliasDoc {
  name: string
  description: string
}

/** One command, with its aliases folded in. */
export interface CommandDoc {
  name: string
  description: string
  /** Every declared flag, shared ones included. The builder does the split. */
  args: ArgDoc[]
  /** Other registry names resolving to this same command. */
  aliases: AliasDoc[]
  /** The gates the factory evaluates for this command, flagged or always on. */
  gates: GateSpecLike[]
}

/** Where a field may be declared, as the reference states it. */
export type DeclarationSites = 'both' | 'json-only' | 'derived-by-nuxt'

/** One property of a nested object shape. */
export interface PropertyDoc {
  name: string
  type: string
  required: boolean
  constraints: string[]
  description: string
}

/** One accepted form of a field, or of its entries, that accepts several. */
export interface FormDoc {
  type: string
  constraints: string[]
  description: string
  /** The properties of this form, when it is an object. */
  properties: PropertyDoc[]
}

/**
 * The shape inside a field, when its type string does not already say it.
 *
 * `scope` distinguishes a shape the field itself has — `reportOutput` is either
 * `true` or a path — from one each entry of an array or record has.
 */
export interface ShapeDoc {
  scope: 'field' | 'entry'
  properties: PropertyDoc[]
  forms: FormDoc[]
  /** True when properties beyond the listed ones still validate. */
  open: boolean
  /** The description declared on the inner node, where it carries one. */
  entryDescription: string | undefined
}

/** One configuration field, as the reference renders it. */
export interface ConfigFieldDoc {
  name: string
  type: string
  required: boolean
  constraints: string[]
  description: string
  deprecated: boolean
  sites: DeclarationSites
  shape: ShapeDoc | undefined
}
