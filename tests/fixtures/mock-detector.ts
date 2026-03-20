import { vi } from 'vitest'
import { resolve } from 'node:path'
import { createPlaygroundConfig, createAppAdminConfig } from './config.js'
import type { I18nConfig } from '../../src/config/types.js'

export const playgroundDir = resolve(import.meta.dirname, '../../playground')
export const appAdminDir = resolve(import.meta.dirname, '../../playground/app-admin')

/**
 * Register a `vi.mock` for `../../src/config/detector.js` that replaces
 * `detectI18nConfig`, `clearConfigCache`, and `getCachedConfig` with
 * fixture-backed implementations.
 *
 * The mock maintains a single cached instance per `projectDir` so that
 * cache-identity semantics work correctly:
 * - Calling `detectI18nConfig(dir)` twice returns the **same** object.
 * - `getCachedConfig()` returns the most recently detected config.
 * - `clearConfigCache()` resets the cache to `null`.
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
        if (projectDir === playgroundDir) {
          config = createPlaygroundConfig()
        } else if (projectDir === appAdminDir) {
          config = createAppAdminConfig()
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
      getCachedConfig: vi.fn(() => cached),
    }
  })
}
