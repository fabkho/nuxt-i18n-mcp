import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { loadKit } from './nuxt-loader'
import type { I18nConfig, LocaleDefinition, LocaleDir } from './types'
import { loadProjectConfig } from './project-config'
import { log } from '../utils/logger'
import { ConfigError } from '../utils/errors'
import { canonicalPath, findNuxtConfig, discoverNuxtApps, deriveLayerName } from './discovery'

export { discoverNuxtApps } from './discovery'

/** Per-project config cache keyed by canonical absolute path. */
const configCache = new Map<string, I18nConfig>()

/** Most recently detected config (for getCachedConfig). */
let lastConfig: I18nConfig | null = null

/**
 * Detect the i18n configuration from a Nuxt project or monorepo root.
 *
 * When `projectDir` is a single Nuxt app, loads it directly (backwards compatible).
 * When `projectDir` is a monorepo root containing multiple Nuxt apps with i18n,
 * discovers all apps, loads each independently, and merges into a unified config.
 */
export async function detectI18nConfig(projectDir: string): Promise<I18nConfig> {
  const canonDir = canonicalPath(projectDir)
  const cached = configCache.get(canonDir)
  if (cached) {
    log.debug('Using cached i18n config')
    return cached
  }

  log.info(`Detecting i18n config from: ${projectDir}`)

  const isNuxtApp = findNuxtConfig(projectDir) !== null

  if (isNuxtApp) {
    const config = await loadSingleApp(projectDir, projectDir)
    configCache.set(canonDir, config)
    lastConfig = config
    log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories`)
    return config
  }

  const appDirs = await discoverNuxtApps(projectDir)
  if (appDirs.length === 0) {
    throw new ConfigError(
      `No Nuxt apps with i18n configuration found under ${projectDir}. `
      + 'Make sure your Nuxt apps have a nuxt.config.ts with i18n configured.',
    )
  }

  log.info(`Discovered ${appDirs.length} Nuxt app(s) with i18n: ${appDirs.map(d => relative(projectDir, d) || '.').join(', ')}`)

  const config = await loadAndMergeApps(appDirs, projectDir)
  configCache.set(canonDir, config)
  lastConfig = config
  log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories from ${appDirs.length} app(s)`)
  return config
}

export function clearConfigCache(): void {
  configCache.clear()
  lastConfig = null
  log.debug('Config cache cleared')
}

/**
 * Get the currently cached config without triggering detection.
 * Returns null if no config has been detected yet.
 * Used by MCP resources which can't pass a projectDir parameter.
 */
export function getCachedConfig(): I18nConfig | null {
  return lastConfig
}

async function loadSingleApp(appDir: string, discoveryRoot: string): Promise<I18nConfig> {
  const kit = await loadKit(appDir)

  let nuxt: Awaited<ReturnType<typeof kit.loadNuxt>>

  try {
    nuxt = await kit.loadNuxt({
      cwd: appDir,
      dotenv: { cwd: appDir },
      overrides: {
        logLevel: 'silent' as const,
        vite: { clearScreen: false },
      },
    })
  }
  catch (_error) {
    log.warn(`Initial loadNuxt failed for ${appDir}, retrying with ready:false...`)
    try {
      nuxt = await kit.loadNuxt({
        cwd: appDir,
        dotenv: { cwd: appDir },
        ready: false,
        overrides: {
          logLevel: 'silent' as const,
          vite: { clearScreen: false },
        },
      })
    }
    catch (retryError) {
      throw new ConfigError(
        `Failed to load Nuxt config from ${appDir}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      )
    }
  }

  try {
    return await extractI18nConfig(nuxt as unknown as { options: Record<string, unknown> }, appDir, discoveryRoot)
  }
  finally {
    await nuxt.close()
  }
}

async function loadAndMergeApps(appDirs: string[], discoveryRoot: string): Promise<I18nConfig> {
  const projectConfig = await loadProjectConfig(discoveryRoot)

  const allLocaleDirs: LocaleDir[] = []
  const allLocales: LocaleDefinition[] = []
  const allLayerRootDirs: string[] = []
  const seenLocalePaths = new Map<string, string>()
  const seenLocaleCodes = new Set<string>()
  const usedLayerNames = new Set<string>()
  let defaultLocale = 'en'
  let fallbackLocale: Record<string, string[]> = { default: ['en'] }

  for (const appDir of appDirs) {
    log.info(`Loading Nuxt app: ${relative(discoveryRoot, appDir) || '.'}`)
    let appConfig: I18nConfig
    try {
      appConfig = await loadSingleApp(appDir, discoveryRoot)
    }
    catch (error) {
      log.warn(`Failed to load app at ${appDir}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (allLocaleDirs.length === 0) {
      defaultLocale = appConfig.defaultLocale
      fallbackLocale = appConfig.fallbackLocale
    }

    for (const dir of appConfig.localeDirs) {
      const existingLayer = seenLocalePaths.get(dir.path)
      if (existingLayer) {
        if (dir.layer !== existingLayer) {
          allLocaleDirs.push({
            ...dir,
            aliasOf: existingLayer,
          })
          log.debug(`Layer '${dir.layer}' is alias of '${existingLayer}' (same path: ${dir.path})`)
        }
        continue
      }

      // Disambiguate layer name if already used by a different path
      let layerName = dir.layer
      if (usedLayerNames.has(layerName)) {
        layerName = deriveLayerName(dir.layerRootDir, discoveryRoot, usedLayerNames)
      }
      usedLayerNames.add(layerName)
      seenLocalePaths.set(dir.path, layerName)
      allLocaleDirs.push({ ...dir, layer: layerName })
    }

    for (const locale of appConfig.locales) {
      if (!seenLocaleCodes.has(locale.code)) {
        seenLocaleCodes.add(locale.code)
        allLocales.push(locale)
      }
    }

    for (const rootDir of appConfig.layerRootDirs) {
      if (!allLayerRootDirs.includes(rootDir)) {
        allLayerRootDirs.push(rootDir)
      }
    }
  }

  if (allLocaleDirs.length === 0) {
    throw new ConfigError(
      `No locale directories found in any Nuxt app under ${discoveryRoot}. `
      + 'Make sure your Nuxt apps have i18n/locales/ directories with JSON files.',
    )
  }

  return {
    rootDir: discoveryRoot,
    defaultLocale,
    fallbackLocale,
    locales: allLocales,
    localeDirs: allLocaleDirs,
    layerRootDirs: allLayerRootDirs,
    projectConfig: projectConfig ?? undefined,
  }
}

async function extractI18nConfig(
  nuxt: { options: Record<string, unknown> },
  appDir: string,
  discoveryRoot: string,
): Promise<I18nConfig> {
  const projectConfig = await loadProjectConfig(appDir)

  const nuxtOptions = nuxt.options as Record<string, unknown>
  const i18nOptions = nuxtOptions.i18n as Record<string, unknown> | undefined
  const layers = (nuxtOptions._layers ?? []) as Array<{
    config: {
      rootDir: string
      i18n?: Record<string, unknown>
    }
  }>

  if (!i18nOptions) {
    throw new ConfigError(
      `No i18n configuration found in nuxt.config at ${appDir}. Make sure @nuxtjs/i18n is configured.`,
    )
  }

  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  log.debug(`Default locale: ${defaultLocale}`)

  const rawLocales = (i18nOptions.locales ?? []) as Array<Record<string, unknown>>
  const locales: LocaleDefinition[] = rawLocales
    .filter(l => typeof l === 'object' && l !== null)
    .map(l => ({
      code: String(l.code ?? ''),
      language: String(l.language ?? l.iso ?? ''),
      file: String(l.file ?? ''),
      name: l.name ? String(l.name) : undefined,
    }))
    .filter(l => l.code && l.file)

  if (locales.length === 0) {
    throw new ConfigError(
      'No locales found in i18n configuration. Make sure locales are defined with code and file properties.',
    )
  }

  const fallbackLocale = extractFallbackLocale(i18nOptions)
  const localeDirs = await discoverLocaleDirs(layers, i18nOptions, discoveryRoot)

  const layerRootDirs = [...new Set(layers.map(l => l.config.rootDir))]
  if (layerRootDirs.length === 0) {
    layerRootDirs.push(appDir)
  }

  return {
    rootDir: appDir,
    defaultLocale,
    fallbackLocale,
    locales,
    localeDirs,
    layerRootDirs,
    projectConfig: projectConfig ?? undefined,
  }
}

function extractFallbackLocale(
  i18nOptions: Record<string, unknown>,
): Record<string, string[]> {
  const fallback = i18nOptions.fallbackLocale
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    const result: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(fallback as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[key] = value.map(String)
      }
      else if (typeof value === 'string') {
        result[key] = [value]
      }
    }
    return result
  }

  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  return { default: [defaultLocale] }
}

async function discoverLocaleDirs(
  layers: Array<{ config: { rootDir: string; i18n?: Record<string, unknown> } }>,
  i18nOptions: Record<string, unknown>,
  discoveryRoot: string,
): Promise<LocaleDir[]> {
  const dirs: LocaleDir[] = []
  const resolvedPaths = new Map<string, string>()
  const usedLayerNames = new Set<string>()

  for (const layer of layers) {
    const layerRootDir = layer.config.rootDir
    const layerName = deriveLayerName(layerRootDir, discoveryRoot, usedLayerNames)
    usedLayerNames.add(layerName)
    const layerI18n = layer.config.i18n ?? i18nOptions

    const langDir = (layerI18n.langDir as string) ?? 'locales'
    const restructureDir = (layerI18n.restructureDir as string) ?? 'i18n'
    const resolvedDir = resolve(layerRootDir, restructureDir, langDir)

    if (!existsSync(resolvedDir)) {
      log.debug(`Locale dir not found for layer '${layerName}': ${resolvedDir}`)
      continue
    }

    const existingLayer = resolvedPaths.get(resolvedDir)
    if (existingLayer) {
      dirs.push({
        path: resolvedDir,
        layer: layerName,
        layerRootDir,
        aliasOf: existingLayer,
      })
      log.debug(`Layer '${layerName}' is alias of '${existingLayer}'`)
      continue
    }

    const files = await readdir(resolvedDir)
    const jsonFiles = files.filter(f => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
      log.debug(`No JSON files in locale dir for layer '${layerName}': ${resolvedDir}`)
      continue
    }

    resolvedPaths.set(resolvedDir, layerName)
    dirs.push({
      path: resolvedDir,
      layer: layerName,
      layerRootDir,
    })

    log.debug(`Found locale dir for layer '${layerName}': ${resolvedDir} (${jsonFiles.length} files)`)
  }

  if (dirs.length === 0) {
    throw new ConfigError(
      'No locale directories found. Make sure your Nuxt layers have i18n/locales/ directories with JSON files.',
    )
  }

  return dirs
}
