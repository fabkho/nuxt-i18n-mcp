import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commands } from '../../src/commands/index.js'
import { clearConfigCache } from '../../src/config/detector.js'
import { descriptors, visibleParams } from '../../src/surface/descriptors.js'
import { runOperation } from '../fixtures/surface.js'

/**
 * The drift guard.
 *
 * The CLI and the MCP server used to be two hand-written transcriptions of the
 * same operations, and nothing checked that they agreed: one called a parameter
 * `ref` and the other `referenceLocale`, with descriptions written months apart.
 * They are now generated from one table, and this file holds the table to what
 * it promises:
 *
 * - every operation with a `cli` really is a command the built binary answers
 * - the flags that command accepts are exactly the ones the table declares
 * - a parameter both surfaces expose is spelled the same on both, and one only
 *   a single surface exposes says so on the parameter
 * - the parameters that ask for a report exist exactly where a report does
 * - every operation declares the shape of its result, and really answers with
 *   something that shape accepts
 *
 * The other half — that the server advertises exactly these operations with
 * exactly these parameters — is asserted in `packages/mcp/tests/descriptors.test.ts`,
 * which is where a server can be started. Together they close the loop.
 */

const execFileAsync = promisify(execFile)
const binPath = resolve(import.meta.dirname, '../../dist/bin.js')

async function runBin(args: string[]): Promise<{ stdout: string, code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, ...args])
    return { stdout, code: 0 }
  }
  catch (error) {
    const e = error as { stdout?: string, code?: number }
    return { stdout: e.stdout ?? '', code: e.code ?? 1 }
  }
}

/** Flags the shared command factory merges into every command. */
const SHARED_FLAGS = ['projectDir', 'json']

const cliDescriptors = descriptors.filter(descriptor => descriptor.cli !== null)
const mcpDescriptors = descriptors.filter(descriptor => descriptor.mcp !== null)
const bothDescriptors = descriptors.filter(d => d.cli !== null && d.mcp !== null)

describe('the operation table drives the CLI', () => {
  it('registers a command for every descriptor that declares one, and no other', () => {
    expect(Object.keys(commands).sort())
      .toEqual(cliDescriptors.map(descriptor => descriptor.cli?.name).sort())
  })

  // A registered command that cannot be invoked is worse than no command: it is
  // documented, tested at the unit level and dead at the only level that counts.
  // Only the real binary can show that, so this drives it. Requires a built dist.
  it.each(cliDescriptors.map(descriptor => descriptor.cli?.name ?? ''))(
    '%s is invocable through the binary',
    async (name) => {
      const { stdout, code } = await runBin([name, '--help'])

      expect(code).toBe(0)
      expect(stdout).toContain('USAGE')
    },
  )

  it('accepts exactly the flags the descriptor declares, plus the shared ones', async () => {
    for (const descriptor of cliDescriptors) {
      const def = await commands[descriptor.cli?.name ?? '']?.load()
      const declared = [...visibleParams(descriptor, 'cli'), ...SHARED_FLAGS]

      expect(Object.keys((def as { args: Record<string, unknown> }).args).sort())
        .toEqual(declared.sort())
    }
  })

  it('prints the descriptor description as the command description', async () => {
    for (const descriptor of cliDescriptors) {
      const def = await commands[descriptor.cli?.name ?? '']?.load()

      expect((def as { meta: { description: string } }).meta.description)
        .toBe(descriptor.description)
    }
  })
})

describe('the two surfaces agree', () => {
  it('spells a parameter the same way on both, or says which surface hides it', () => {
    for (const descriptor of bothDescriptors) {
      const cli = visibleParams(descriptor, 'cli')
      const mcp = visibleParams(descriptor, 'mcp')
      const hidden = Object.entries(descriptor.params)
        .filter(([, spec]) => spec.cli?.hidden === true || spec.mcp?.hidden === true)
        .map(([name]) => name)

      // Every difference between the two sets is a parameter the table hides on
      // one of them. A parameter that exists on one surface for no stated
      // reason is the drift this table was written to make impossible.
      const onlyCli = cli.filter(name => !mcp.includes(name))
      const onlyMcp = mcp.filter(name => !cli.includes(name))

      expect(onlyCli.filter(name => !hidden.includes(name))).toEqual([])
      expect(onlyMcp.filter(name => !hidden.includes(name))).toEqual([])
    }
  })

  it('keeps the previous CLI spelling of every renamed parameter reachable', () => {
    // The rename direction is towards the MCP name, so the flag someone has in
    // a pipeline has to survive it. Stated as a table because a lost alias is a
    // broken pipeline, not a failing type.
    const kept: Record<string, Record<string, string>> = {
      missing: { referenceLocale: 'ref', targetLocales: 'targets' },
      status: { referenceLocale: 'ref' },
      search: { searchIn: 'in' },
      translate: { referenceLocale: 'ref', targetLocales: 'targets' },
      'translate-key': { targetLocales: 'targets' },
    }

    for (const [command, aliases] of Object.entries(kept)) {
      const descriptor = descriptors.find(candidate => candidate.cli?.name === command)
      expect(descriptor, `no descriptor for ${command}`).toBeDefined()

      for (const [param, alias] of Object.entries(aliases)) {
        const declared = descriptor?.params[param]?.cli?.alias
        const spellings = typeof declared === 'string' ? [declared] : declared ?? []
        expect(spellings, `${command} --${param}`).toContain(alias)
      }
    }
  })

  /**
   * The parameters are generated from the `report` declaration, so the two
   * cannot drift apart by construction. Asserted anyway: the generation is
   * what a reader has to be able to rely on, and a command that offers
   * `--output-file` and then ignores it is exactly the failure the diversion
   * was moved out of the operations to make impossible.
   */
  it('offers the report parameters exactly where a report is declared', () => {
    for (const descriptor of descriptors) {
      const params = Object.keys(descriptor.params)
      const report = descriptor.report

      expect(params.includes('outputFile'), `${descriptor.id}.outputFile`)
        .toBe(report !== undefined)
      expect(params.includes('codequalityOutput'), `${descriptor.id}.codequalityOutput`)
        .toBe(report?.codequality !== undefined)
    }
  })

  it('leaves no operation without a surface', () => {
    for (const descriptor of descriptors) {
      expect(
        descriptor.cli !== null || descriptor.mcp !== null,
        `${descriptor.id} is reachable from neither surface`,
      ).toBe(true)
    }
  })

  it('gives every parameter a description written for a reader of either surface', () => {
    for (const descriptor of descriptors) {
      for (const [name, spec] of Object.entries(descriptor.params)) {
        expect(spec.description.length, `${descriptor.id}.${name}`).toBeGreaterThan(0)
        // No flag spellings in a shared description: an MCP host has no flags,
        // and the CLI adds what a shell needs when it builds the flag.
        expect(spec.description, `${descriptor.id}.${name}`).not.toMatch(/(^|\s)--\w/)
      }
    }
  })

  it('covers both surfaces, so neither is documented against an empty table', () => {
    expect(cliDescriptors.length).toBeGreaterThan(1)
    expect(mcpDescriptors.length).toBeGreaterThan(1)
  })
})

/**
 * The arguments each operation needs to answer with something worth checking,
 * against the project seeded below.
 *
 * Written by hand, and held to the table by the first case: an operation added
 * without an entry here would otherwise be declared to answer in a shape
 * nothing ever compares a real result against. The mutating operations run as
 * previews, so one seeded project serves every case regardless of order.
 */
const RESULT_CASES: Record<string, Record<string, unknown>> = {
  // force, because the seeded project already has the config init would write.
  'init': { dryRun: true, force: true },
  'discover': {},
  'list-namespaces': {},
  'get': { layer: 'root', locale: 'en', keys: ['common.greeting'] },
  'write': { layer: 'root', translations: { 'common.welcome': { en: 'Welcome' } }, dryRun: true },
  'missing': {},
  'status': { listEmpty: true },
  'search': { query: 'Hello' },
  'remove': { layer: 'root', keys: ['common.farewell'], dryRun: true },
  'move': { layer: 'root', key: 'common.greeting', newKey: 'common.hello', dryRun: true },
  // No provider is configured here, so this is agent mode: nothing is written
  // and the fallback contexts come back instead.
  'translate': {},
  'translate-key': { layer: 'root', key: 'common.greeting', sourceLocale: 'en' },
  'check': {},
  'orphans': {},
  'find-duplicates': { byValue: true },
  'scaffold': { locales: ['fr'], dryRun: true },
}

describe('every operation states the shape of its result', () => {
  let projectDir: string

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'i18n-result-schema-'))
    await mkdir(join(projectDir, 'locales'), { recursive: true })
    await mkdir(join(projectDir, 'src'), { recursive: true })
    await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
      defaultLocale: 'en',
      localeDirs: [{ path: 'locales', layer: 'root' }],
      // fr is declared and has no file, which is what scaffold has to answer for.
      locales: ['en', 'de', 'fr'],
    }))
    await writeFile(join(projectDir, 'locales/en.json'), JSON.stringify({
      common: { greeting: 'Hello', farewell: 'Goodbye' },
    }))
    // de is missing common.farewell and holds an empty greeting, so the
    // coverage and missing-key results have every bucket filled.
    await writeFile(join(projectDir, 'locales/de.json'), JSON.stringify({ common: { greeting: '' } }))
    // common.farewell is referenced nowhere, so the orphan scan finds one.
    await writeFile(join(projectDir, 'src/app.ts'), `export const label = t('common.greeting')\n`)
  })

  afterAll(async () => {
    clearConfigCache()
    await rm(projectDir, { recursive: true, force: true })
  })

  it('declares a result schema, so no tool is advertised without one', () => {
    for (const descriptor of descriptors) {
      expect(descriptor.result, `${descriptor.id}.result`).toBeDefined()
    }
    expect(Object.keys(RESULT_CASES).sort()).toEqual(descriptors.map(d => d.id).sort())
  })

  it.each(descriptors.map(descriptor => descriptor.id))(
    '%s answers with a result its own schema accepts',
    async (id) => {
      const descriptor = descriptors.find(candidate => candidate.id === id)
      const result = await runOperation(id, { projectDir, ...RESULT_CASES[id] })

      const parsed = descriptor?.result.safeParse(result)

      // The whole issue list, not just "failed": a schema that has drifted from
      // its operation names the field it drifted on.
      expect(parsed?.success, JSON.stringify(parsed?.error?.issues, null, 2)).toBe(true)
    },
  )
})
