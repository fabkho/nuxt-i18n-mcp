/**
 * Everything the process remembers about a project it has already read.
 *
 * One owner, because there is one moment that has to forget all of it: a
 * long-running MCP server clears the cache after the user edits a config file,
 * and any memo keeping its own copy would survive that and keep answering with
 * the project as it was.
 */
import type { I18nConfig } from './types.js'
import { canonicalPath } from './paths.js'
import { log } from '../utils/logger.js'

const configs = new Map<string, I18nConfig>()

let lastConfig: I18nConfig | null = null

/** The resolved config for a canonical project directory, if one is cached. */
export function getCachedConfigFor(canonicalDir: string): I18nConfig | undefined {
  return configs.get(canonicalDir)
}

export function cacheConfig(canonicalDir: string, config: I18nConfig): void {
  configs.set(canonicalDir, config)
  lastConfig = config
}

/** The most recently resolved config, or null when nothing has been resolved. */
export function getCachedConfig(): I18nConfig | null {
  return lastConfig
}

/**
 * Forget one project, leaving the others alone — a process that has resolved
 * several (an MCP server across a session, a command given an explicit
 * projectDir) should not lose all of them because one was re-detected.
 *
 * Takes the directory in any spelling and canonicalizes it the way
 * {@link cacheConfig}'s callers do.
 */
export function clearConfigCacheFor(dir: string): void {
  const canonicalDir = canonicalPath(dir)
  const cleared = configs.get(canonicalDir)
  if (cleared === undefined) return

  configs.delete(canonicalDir)
  // getCachedConfig() answers with lastConfig, so leaving it on the entry just
  // forgotten would keep handing out exactly what was cleared.
  if (lastConfig === cleared) lastConfig = null
  log.debug(`Config cache cleared for ${canonicalDir}`)
}

/** Forget every project. The whole-process reset, and what tests reach for. */
export function clearConfigCache(): void {
  configs.clear()
  lastConfig = null
  log.debug('Config cache cleared')
}
