import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Wrapping the real loader rather than replacing it: the point is how many
// times a run reaches it, which only holds if the detection it drives is real.
vi.mock('../../src/config/project-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/project-config.js')>()
  return { ...actual, loadProjectConfig: vi.fn(actual.loadProjectConfig) }
})

const { loadProjectConfig } = await import('../../src/config/project-config.js')
const { detectI18nConfig, clearConfigCache } = await import('../../src/config/detector.js')

let projectDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'single-config-load-'))
  const localeDir = join(projectDir, 'locales')
  await mkdir(localeDir, { recursive: true })
  await writeFile(join(localeDir, 'en.json'), JSON.stringify({ common: { save: 'Save' } }))
  await writeFile(join(localeDir, 'de.json'), JSON.stringify({ common: { save: 'Speichern' } }))
  await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
    localeDirs: ['locales'],
    defaultLocale: 'en',
  }))

  clearConfigCache()
  vi.mocked(loadProjectConfig).mockClear()
})

afterEach(async () => {
  clearConfigCache()
  await rm(projectDir, { recursive: true, force: true })
})

describe('config detection', () => {
  it('reads the project config once per run', async () => {
    await detectI18nConfig(projectDir)

    expect(loadProjectConfig).toHaveBeenCalledTimes(1)
  })

  it('does not read it again for a project already in the cache', async () => {
    await detectI18nConfig(projectDir)
    await detectI18nConfig(projectDir)

    expect(loadProjectConfig).toHaveBeenCalledTimes(1)
  })
})
