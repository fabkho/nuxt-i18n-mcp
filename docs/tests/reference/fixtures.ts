/**
 * Fixture sources for the reference builder.
 *
 * The builder takes already-loaded sources, so a fixture is a plain object and
 * no test needs a repository on disk. Kept deliberately small: two commands
 * sharing a flag and one alias of one of them — enough to exercise every branch
 * of the shared/specific split and the alias folding — two advertised tools,
 * and an action manifest carrying one input of each required/default
 * combination.
 */

import type {
  ActionSource,
  CliCommandEntry,
  CliSource,
  ConfigJsonSchema,
  ConfigSource,
  McpSource,
  McpToolListing,
  ReferenceSources,
} from '../../generate/reference/types.js'

/** Two commands, both declaring the same two flags identically. */
const SHARED_ARG_DEFS = {
  projectDir: { type: 'string', alias: 'd', description: 'Project directory (default: cwd)' },
  json: { type: 'boolean', description: 'Output as JSON (default for non-TTY)', default: false },
}

function handler(): Promise<void> {
  return Promise.resolve()
}

const scanHandler = handler
const translateHandler = handler.bind(null)

export const SCAN_ENTRY: CliCommandEntry = {
  name: 'scan',
  def: {
    meta: { name: 'scan', description: 'Scan source code for translation key usage' },
    args: {
      ...SHARED_ARG_DEFS,
      keys: { type: 'string', description: 'Comma-separated keys to filter by' },
      outputFile: { type: 'string', description: 'Write full output to file, return summary only' },
    },
    run: scanHandler,
  },
}

export const TRANSLATE_ENTRY: CliCommandEntry = {
  name: 'translate',
  def: {
    meta: { name: 'translate', description: 'Find missing translations and translate them' },
    args: {
      ...SHARED_ARG_DEFS,
      layer: { type: 'string', description: 'Layer name', required: true },
      provider: { type: 'string', description: 'LLM provider', valueHint: 'openai|anthropic|google' },
      failOnFailed: { type: 'boolean', description: 'Exit 2 when any key failed to translate (CI gate)', default: false },
    },
    run: translateHandler,
  },
}

/** Same handler as `translate`, which is how the builder recognises an alias. */
export const TRANSLATE_ALIAS_ENTRY: CliCommandEntry = {
  name: 'translate-missing',
  def: {
    meta: { name: 'translate-missing', description: 'Alias of "translate" — matches the MCP tool.' },
    args: TRANSLATE_ENTRY.def.args,
    run: translateHandler,
  },
}

export function fixtureCliSource(overrides: Partial<CliSource> = {}): CliSource {
  return {
    entries: [SCAN_ENTRY, TRANSLATE_ENTRY, TRANSLATE_ALIAS_ENTRY],
    exitCodes: { success: 0, runFailed: 1, gateTripped: 2 },
    ...overrides,
  }
}

/**
 * Advertised with no paired CLI command, only the universal parameter, and a
 * result whose root is a map rather than named fields — the shape the reference
 * has to name a type for instead of tabulating.
 */
export const UNPAIRED_TOOL: McpToolListing = {
  name: 'list_namespaces',
  title: 'List Namespaces',
  description: 'List the translation key tree grouped by namespace prefix.',
  inputSchema: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Absolute path to the project root.' },
    },
  },
  outputSchema: {
    type: 'object',
    description: 'Layer name → the key tree of that layer.',
    propertyNames: { type: 'string' },
    additionalProperties: { type: 'object' },
  },
}

/**
 * Every schema shape the reference has to name a type for, plus behaviour
 * hints, a required parameter and a pairing with a command the fixture CLI
 * exposes.
 */
export const TRANSLATE_MISSING_TOOL: McpToolListing = {
  name: 'translate_missing',
  title: 'Translate Missing',
  description: 'Find keys missing in target locales and translate them. Provider mode | agent mode.',
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: 'Layer name' },
      targetLocales: {
        description: 'Target locales, or "all"',
        anyOf: [{ type: 'string', const: 'all' }, { type: 'array', items: { type: 'string' } }],
      },
      keys: { type: 'array', items: { type: 'string' }, description: 'Dot-separated key paths' },
      mode: { type: 'string', enum: ['add', 'update', 'upsert'], description: 'Write mode' },
      translations: {
        type: 'object',
        description: 'Map of key to locale values',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
      },
      dryRun: { type: 'boolean', description: 'Preview without writing' },
      outputFile: { type: 'string', description: 'Absolute path to write full JSON output' },
      projectDir: { type: 'string', description: 'Absolute path to the Nuxt project root.' },
    },
    required: ['layer'],
  },
  /**
   * A union root, as a tool that diverts a large result to a file advertises:
   * the whole result, or the compact stand-in. Both members are documented in
   * one table, so the reference must read the fields out of `anyOf`.
   */
  outputSchema: {
    type: 'object',
    anyOf: [
      {
        type: 'object',
        properties: {
          results: { type: 'object', description: 'Full per-locale results.' },
          summary: { type: 'object', description: 'What the run did.' },
        },
        required: ['summary'],
      },
      {
        type: 'object',
        properties: {
          reportFile: { type: 'string', description: 'Absolute path the full result was written to.' },
          summary: { type: 'object', description: 'What the run did.' },
        },
        required: ['reportFile', 'summary'],
      },
    ],
  },
  annotations: { title: 'Translate Missing Translations', readOnlyHint: false },
}

export function fixtureMcpSource(overrides: Partial<McpSource> = {}): McpSource {
  return { tools: [UNPAIRED_TOOL, TRANSLATE_MISSING_TOOL], ...overrides }
}

export function fixtureActionSource(overrides: Partial<ActionSource> = {}): ActionSource {
  return {
    name: 'the-i18n-kit — Auto-Translate Missing Keys',
    description: 'Find missing translation keys and translate them via LLM.',
    inputs: [
      { name: 'provider', description: 'LLM provider: openai, anthropic, or google', required: true },
      { name: 'batch_size', description: 'Keys per LLM call (default: 50)', required: false, default: '50' },
      {
        name: 'working_directory',
        description: 'Project root directory (default: github.workspace)',
        required: false,
        default: '${{ github.workspace }}',
      },
      {
        name: 'source_locale',
        description: 'Reference locale (default: the project default from <config>)',
        required: false,
      },
    ],
    outputs: [
      { name: 'translated_count', description: 'Number of keys translated' },
      { name: 'failed_count', description: 'Number of keys that failed to translate' },
    ],
    ...overrides,
  }
}

/**
 * A JSON Schema in the shape `z.toJSONSchema()` emits for the config schema,
 * cut down to one field of each kind the reference has to render: a scalar with
 * a suggestion list, an array of objects, a record of objects that accepts
 * unlisted keys, a union, a constrained array, a key the Nuxt module derives, a
 * key the typed config's interface omits, and a deprecated one.
 */
export const FIXTURE_SCHEMA: ConfigJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: {
      type: 'string',
      description: 'Path or URL to the JSON schema for IDE autocompletion.',
    },
    framework: {
      type: 'string',
      description: 'Force framework detection instead of auto-detecting.',
      examples: ['nuxt', 'generic'],
    },
    glossary: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Term dictionary for consistent translations.',
    },
    layerRules: {
      type: 'array',
      description: 'Rules that decide which layer a new key belongs to.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['layer', 'when'],
        properties: {
          layer: { type: 'string', description: 'Layer name.' },
          when: { type: 'string', description: 'When a key belongs in this layer.' },
          note: { type: 'string', description: 'Optional aside.' },
        },
      },
    },
    orphanScan: {
      type: 'object',
      description: 'Per-layer configuration for orphan key detection.',
      additionalProperties: {
        type: 'object',
        additionalProperties: {},
        properties: {
          ignorePatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key globs to exclude from orphan detection.',
          },
        },
      },
    },
    localeDirs: {
      type: 'array',
      description: 'Locale directories for the generic adapter.',
      items: {
        anyOf: [
          { type: 'string', minLength: 1, description: 'Relative path to a locale directory.' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'layer'],
            properties: {
              path: { type: 'string', minLength: 1, description: 'Relative path.' },
              layer: { type: 'string', minLength: 1, description: 'Layer name for this directory.' },
            },
          },
        ],
      },
    },
    protectedLocales: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Locales excluded from automatic translation.',
    },
    reportOutput: {
      description: 'Write full reports to <reportOutput>/<toolName>.json.',
      anyOf: [
        { type: 'boolean', const: true, description: 'Write to the default directory.' },
        { type: 'string', minLength: 1, description: 'A directory path of your own.' },
      ],
    },
    samplingPreferences: {
      deprecated: true,
      description: 'Deprecated and ignored — configure a provider instead.',
    },
  },
}

export function fixtureConfigSource(overrides: Partial<ConfigSource> = {}): ConfigSource {
  return {
    schema: FIXTURE_SCHEMA,
    moduleOwnedKeys: ['localeDirs'],
    untypedKeys: ['$schema', 'samplingPreferences'],
    nuxtModuleOptions: ['enabled', 'failOnInvalidConfig'],
    ...overrides,
  }
}

/** Every source the builder needs, with either half replaceable per test. */

/** Every source the builder needs, so a test overrides only the one it is about. */
export function fixtureSources(overrides: Partial<ReferenceSources> = {}): ReferenceSources {
  return {
    cli: fixtureCliSource(),
    mcp: fixtureMcpSource(),
    action: fixtureActionSource(),
    config: fixtureConfigSource(),
    ...overrides,
  }
}
