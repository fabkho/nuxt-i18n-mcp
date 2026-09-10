import { vi } from 'vitest'
import { resolve } from 'node:path'
import { createPlaygroundConfig, createAppAdminConfig, createMonorepoConfig, projectRootDir } from './config.js'
import type { I18nConfig } from '../../src/config/types.js'

export const monorepoDir = projectRootDir
export const playgroundDir = resolve(import.meta.dirname, 'nuxt-project')
export const appAdminDir = resolve(playgroundDir, 'app-admin')

/** Hand-built configs a test registered for project dirs it created itself. */
const registeredConfigs = new Map<string, I18nConfig>()

/**
 * Teach the mock about a project the fixture dirs do not cover — an mkdtemp
 * directory a test wrote locale files into, with the config it wants detected
 * for it.
 *
 * `vi.mock` replaces a module once per test file, so a file that already calls
 * `registerDetectorMock` cannot add a second factory of its own; this is how it
 * drives an operation against files it wrote itself instead.
 */
export function registerFixtureConfig(projectDir: string, config: I18nConfig): void {
  registeredConfigs.set(projectDir, config)
}

/**
 * Register a `vi.mock` for `../../src/config/detector.js` that replaces
 * `detectI18nConfig`, `clearConfigCache`, `clearConfigCacheFor` and
 * `getCachedConfig` with fixture-backed implementations.
 *
 * The mock maintains a single cached instance per `projectDir` so that
 * cache-identity semantics work correctly:
 * - Calling `detectI18nConfig(dir)` twice returns the **same** object.
 * - `getCachedConfig()` returns the most recently detected config.
 * - `clearConfigCache()` resets the cache to `null`.
 * - `clearConfigCacheFor(dir)` forgets one project and leaves the rest.
 *
 * Must be called at the **top level** of the test file (before any imports
 * that depend on the mocked module), because `vi.mock` is hoisted by Vitest.
 *
 * @example
 * ```ts
 * import { registerDetectorMock, playgroundDir, appAdminDir } from '../fixtures/mock-detector.js'
 *
 * registerDetectorMock()
 *
 * const { detectI18nConfig, clearConfigCache, getCachedConfig } =
 *   await import('../../src/config/detector.js')
 * ```
 */
export function registerDetectorMock(): void {
  vi.mock('../../src/config/detector.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/config/detector.js')>()

    let cached: I18nConfig | null = null
    const instanceCache = new Map<string, I18nConfig>()

    return {
      ...original,
      detectI18nConfig: vi.fn(async (projectDir: string) => {
        // Return the same instance for repeat calls (real caching behaviour)
        const existing = instanceCache.get(projectDir)
        if (existing) {
          cached = existing
          return existing
        }

        let config: I18nConfig
        const registered = registeredConfigs.get(projectDir)
        if (registered) {
          config = registered
        } else if (projectDir === playgroundDir) {
          config = createPlaygroundConfig()
        } else if (projectDir === appAdminDir) {
          config = createAppAdminConfig()
        } else if (projectDir === monorepoDir) {
          config = createMonorepoConfig()
        } else {
          throw new Error(`No fixture config for ${projectDir}`)
        }

        instanceCache.set(projectDir, config)
        cached = config
        return config
      }),
      clearConfigCache: vi.fn(() => {
        cached = null
        instanceCache.clear()
      }),
      clearConfigCacheFor: vi.fn((projectDir: string) => {
        const entry = instanceCache.get(projectDir)
        if (!entry) return
        instanceCache.delete(projectDir)
        if (cached === entry) cached = null
      }),
      getCachedConfig: vi.fn(() => cached),
    }
  })
}
