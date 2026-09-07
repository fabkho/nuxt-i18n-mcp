import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { registerDetectorMock, registerFixtureConfig } from '../fixtures/mock-detector.js'

/**
 * The two defaults the surfaces disagree on.
 *
 * A terminal answer is piped into jq and read by someone who asked for it; a
 * tool answer is spent from a context window. Where that makes one default
 * wrong for the other surface, the descriptor resolves it from `ctx.surface`
 * rather than from a value on the parameter — which is what these drive.
 */

registerDetectorMock()

const { clearConfigCache } = await import('../../src/config/detector.js')
const { describeProject } = await import('../../src/core/operations.js')
const { descriptors } = await import('../../src/surface/descriptors.js')
const { commands } = await import('../../src/commands/index.js')

const PROSE = {
  context: 'A booking platform.',
  glossary: { Buchung: 'booking' },
  translationPrompt: 'Address the reader formally.',
  localeNotes: { de: 'Use Sie.' },
  examples: [{ key: 'a.b', de: 'Beispiel' }],
}

const STRUCTURE = {
  layerRules: [{ layer: 'root', description: 'shared', when: 'used by two apps' }],
  protectedLocales: ['en'],
  declaredNamespaces: [{ pattern: 'views.**', reason: 'sent by the API' }],
  orphanScan: { root: { ignorePatterns: ['common.months.*'] } },
  translationMemory: true,
}

/** A project whose config carries both halves, so the split is observable. */
async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'i18n-surface-'))
  const locales = join(dir, 'i18n', 'locales')
  await mkdir(locales, { recursive: true })

  // 150 keys: more than the cap a tool call gets, so the default is visible.
  const keys: Record<string, string> = {}
  for (let index = 0; index < 150; index++) keys[`key${String(index).padStart(3, '0')}`] = `Value ${index}`
  await writeFile(join(locales, 'en.json'), JSON.stringify({ paged: keys }))

  registerFixtureConfig(dir, {
    rootDir: dir,
    defaultLocale: 'en',
    fallbackLocale: { default: ['en'] },
    locales: [{ code: 'en', language: 'en-US', file: 'en.json' }],
    localeDirs: [{ path: locales, layer: 'root', layerRootDir: dir }],
    layerRootDirs: [dir],
    projectConfig: { ...PROSE, ...STRUCTURE },
  })
  return dir
}

let projectDir: string

beforeAll(async () => {
  projectDir = await makeProject()
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  clearConfigCache()
})

describe('discover without the translation prose', () => {
  it('omits the five prose fields and says it did', async () => {
    const result = await describeProject({ projectDir })

    for (const field of Object.keys(PROSE)) {
      expect(result.projectConfig, field).not.toHaveProperty(field)
    }
    expect(result.projectConfig).toHaveProperty('translationGuidanceOmitted', true)
  })

  it('keeps every structural field, which is what an agent decides with', async () => {
    const result = await describeProject({ projectDir })

    expect(result.projectConfig).toMatchObject(STRUCTURE)
  })

  it('returns the prose in full when it is asked for', async () => {
    const result = await describeProject({ projectDir, includeTranslationGuidance: true })

    expect(result.projectConfig).toMatchObject({ ...PROSE, ...STRUCTURE })
    expect(result.projectConfig).not.toHaveProperty('translationGuidanceOmitted')
  })

  it('leaves the rest of the discover answer alone', async () => {
    const result = await describeProject({ projectDir })

    expect(result.defaultLocale).toBe('en')
    expect(result.protectedLocales).toEqual(['en'])
    expect(result.layers).toEqual([expect.objectContaining({ layer: 'root' })])
  })

  it('is a tool-call default only: the terminal keeps the prose', async () => {
    const declared = descriptors.find(descriptor => descriptor.id === 'discover')
    const command = await commands.discover?.load() as { args: Record<string, { default?: unknown }> }

    // The parameter's `default` is the CLI's; a tool call sends nothing and
    // gets the operation's own default, which is to omit.
    expect(declared?.params.includeTranslationGuidance?.default).toBe(true)
    expect(command.args.includeTranslationGuidance?.default).toBe(true)
  })
})

describe('the row cap each surface gets', () => {
  const search = descriptors.find(descriptor => descriptor.id === 'search')

  it('caps a tool call at 100 rows and says where to continue', async () => {
    const result = await search?.run(
      { projectDir, query: 'paged.key', searchIn: 'keys' },
      { surface: 'mcp' },
    ) as { matches: unknown[], totalMatches: number, truncated: boolean, nextOffset?: number, message?: string }

    expect(result.matches).toHaveLength(100)
    expect(result.totalMatches).toBe(150)
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBe(100)
    expect(result.message).toContain('offset=100')
  })

  it('leaves a terminal run unbounded', async () => {
    const result = await search?.run(
      { projectDir, query: 'paged.key', searchIn: 'keys' },
      { surface: 'cli' },
    ) as { matches: unknown[], truncated: boolean, message?: string }

    expect(result.matches).toHaveLength(150)
    expect(result.truncated).toBe(false)
    expect(result.message).toBeUndefined()
  })

  it('lets a tool call ask for more than the default', async () => {
    const result = await search?.run(
      { projectDir, query: 'paged.key', searchIn: 'keys', limit: 200 },
      { surface: 'mcp' },
    ) as { matches: unknown[], truncated: boolean }

    expect(result.matches).toHaveLength(150)
    expect(result.truncated).toBe(false)
  })

  it('declares no cap on the parameter, since the two surfaces disagree', () => {
    for (const id of ['search', 'list-namespaces', 'missing', 'get']) {
      const declared = descriptors.find(descriptor => descriptor.id === id)
      expect(declared?.params.limit?.default, id).toBeUndefined()
      expect(declared?.params.offset?.default, id).toBeUndefined()
    }
  })
})
