import type { AppInfo, I18nConfig, ProjectConfig } from './types'
import { registerAdapter, detectFramework } from '../adapters/registry'
import { NuxtAdapter } from '../adapters/nuxt/index'
import { LaravelAdapter } from '../adapters/laravel/index'
import { GenericAdapter } from '../adapters/generic/index'
import { ReactAdapter } from '../adapters/react/index'
import { loadProjectConfig } from './project-config'
import { log } from '../utils/logger'
import { canonicalPath } from './paths'
import { cacheConfig, getCachedConfigFor } from './cache'
import { inferWorkspaceApps } from './workspace-graph'

// Discovery moved to the Nuxt adapter, where the rest of the Nuxt knowledge
// lives; re-exported here because this is where callers import it from.
export { discoverNuxtApps } from '../adapters/nuxt/discovery'

// The cache itself lives in ./cache, which owns every memo that has to be
// forgotten together. Re-exported here because this has been its import path
// since before there was more than one thing to clear.
export { clearConfigCache, getCachedConfig } from './cache'

registerAdapter(new NuxtAdapter())
registerAdapter(new LaravelAdapter())
registerAdapter(new GenericAdapter())
registerAdapter(new ReactAdapter())

export async function detectI18nConfig(projectDir: string): Promise<I18nConfig> {
  const canonDir = canonicalPath(projectDir)
  const cached = getCachedConfigFor(canonDir)
  if (cached) {
    log.debug('Using cached i18n config')
    return cached
  }

  log.info(`Detecting i18n config from: ${projectDir}`)

  // Read once for the whole detection and handed to both halves of it: the
  // adapters score against it and the winner resolves from it. That is what
  // makes the deprecated-key warning, and the "found project config" line,
  // fire once per run rather than once per adapter and app.
  const projectConfig = await loadProjectConfig(projectDir)
  const hint = projectConfig?.framework

  const adapter = await detectFramework(projectDir, hint, projectConfig)
  log.info(`Detected framework: ${adapter.label}`)

  const config = await adapter.resolve(projectDir, projectConfig)
  config.framework = adapter.name
  await applyConsumerGraph(config, projectConfig, projectDir)
  cacheConfig(canonDir, config)

  log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories`)
  return config
}

/**
 * Settle the consumer graph in `config.apps`, which every cross-layer
 * operation reads, once the adapter has had its say.
 *
 * A declared `apps` list wins outright: it is the only way to correct a graph
 * the tool got wrong, so nothing may override it. Otherwise an adapter that
 * discovered real apps (Nuxt, from its `extends` chain) is left alone, and
 * only the single placeholder app the other adapters emit is open to being
 * replaced by what the workspace says. This lives here rather than in an
 * adapter because it is framework-independent: locale dirs plus package
 * manifests, which every adapter has already produced by this point.
 */
async function applyConsumerGraph(
  config: I18nConfig,
  projectConfig: ProjectConfig | null,
  projectDir: string,
): Promise<void> {
  const declared = projectConfig?.apps
  if (declared && declared.length > 0) {
    config.apps = declared.map(app => declaredApp(app, config))
    warnUnknownDeclaredLayers(config)
    log.debug(`Consumer graph declared in the project config: ${describeApps(config.apps)}`)
    return
  }

  if (projectConfig?.consumerGraph === 'off') return

  const placeholder = config.apps.length === 1 && config.apps[0]?.name === 'default'
  if (!placeholder) return

  const inferred = await inferWorkspaceApps(projectDir, config.localeDirs)
  if (!inferred) return

  config.apps = inferred
  log.debug(`Consumer graph inferred from the workspace: ${describeApps(inferred)}`)
}

/**
 * A declared app carries no directory, and the orphan scan needs one to know
 * which source tree is that app's. The first of its layers that has a locale
 * dir supplies it — by convention an app lists its own layer first, and the
 * shared layers it consumes after — falling back to the project root, which
 * scopes nothing away.
 */
function declaredApp(app: { name: string, layers: string[] }, config: I18nConfig): AppInfo {
  const own = app.layers
    .map(layer => config.localeDirs.find(dir => dir.layer === layer))
    .find(dir => dir !== undefined)

  return {
    name: app.name,
    rootDir: own?.layerRootDir ?? config.rootDir,
    layers: [...app.layers],
    source: 'declared',
  }
}

/**
 * A declared layer name that matches no locale dir is a typo rather than a
 * layer, and it silently contributes nothing to the graph — so say so.
 */
function warnUnknownDeclaredLayers(config: I18nConfig): void {
  const known = new Set(config.localeDirs.map(dir => dir.layer))
  const unknown = [...new Set(config.apps.flatMap(app => app.layers))].filter(layer => !known.has(layer))
  if (unknown.length === 0) return

  log.warn(
    `Declared apps reference unknown layer(s): ${unknown.join(', ')}. `
    + `Detected layers: ${[...known].join(', ')}.`,
  )
}

function describeApps(apps: AppInfo[]): string {
  return apps.map(app => `${app.name} -> [${app.layers.join(', ')}]`).join('; ')
}
