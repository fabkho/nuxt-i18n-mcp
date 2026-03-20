import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve, basename, relative } from 'node:path'
import { loadKit } from './nuxt-loader'
import type { I18nConfig, LocaleDefinition, LocaleDir } from './types'
import { loadProjectConfig } from './project-config'
import { log } from '../utils/logger'
import { ConfigError } from '../utils/errors'

/** Cached config instance */
let cachedConfig: I18nConfig | null = null

/**
 * Detect the i18n configuration from a Nuxt project.
 * Uses @nuxt/kit to load the full resolved Nuxt config, then extracts
 * i18n settings including locales, locale directories, and fallback chain.
 */
export async function detectI18nConfig(projectDir: string): Promise<I18nConfig> {
  if (cachedConfig && cachedConfig.rootDir === projectDir) {
    log.debug('Using cached i18n config')
    return cachedConfig
  }

  log.info(`Detecting i18n config from: ${projectDir}`)

  const kit = await loadKit(projectDir)

  let nuxt: Awaited<ReturnType<typeof kit.loadNuxt>>

  try {
    nuxt = await kit.loadNuxt({
      cwd: projectDir,
      dotenv: { cwd: projectDir },
      overrides: {
        logLevel: 'silent' as const,
        vite: { clearScreen: false },
      },
    })
  } catch (_error) {
    // Retry with ready:false to skip full module initialization while keeping config intact
    log.warn('Initial loadNuxt failed, retrying with ready:false...')
    try {
      nuxt = await kit.loadNuxt({
        cwd: projectDir,
        dotenv: { cwd: projectDir },
        ready: false,
        overrides: {
          logLevel: 'silent' as const,
          vite: { clearScreen: false },
        },
      })
    } catch (retryError) {
      throw new ConfigError(
        `Failed to load Nuxt config from ${projectDir}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
      )
    }
  }

  try {
    const config = await extractI18nConfig(nuxt as unknown as { options: Record<string, unknown> }, projectDir)
    cachedConfig = config
    log.info(`Detected ${config.locales.length} locales, ${config.localeDirs.length} locale directories`)
    return config
  } finally {
    await nuxt.close()
  }
}

/**
 * Clear the cached config. Used by the reload_config tool.
 */
export function clearConfigCache(): void {
  cachedConfig = null
  log.debug('Config cache cleared')
}

/**
 * Get the currently cached config without triggering detection.
 * Returns null if no config has been detected yet.
 * Used by MCP resources which can't pass a projectDir parameter.
 */
export function getCachedConfig(): I18nConfig | null {
  return cachedConfig
}

/**
 * Extract i18n config from a loaded Nuxt instance.
 */
async function extractI18nConfig(
  nuxt: { options: Record<string, unknown> },
  projectDir: string,
): Promise<I18nConfig> {
  // Load project config independently of Nuxt config
  const projectConfig = await loadProjectConfig(projectDir)

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
      'No i18n configuration found in nuxt.config. Make sure @nuxtjs/i18n is configured.',
    )
  }

  // Extract default locale
  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  log.debug(`Default locale: ${defaultLocale}`)

  // Extract locales
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

  // Extract fallback locale
  const fallbackLocale = extractFallbackLocale(i18nOptions, projectDir)

  // Discover locale directories from layers
  const localeDirs = await discoverLocaleDirs(layers, i18nOptions, projectDir)

  return {
    rootDir: projectDir,
    defaultLocale,
    fallbackLocale,
    locales,
    localeDirs,
    projectConfig: projectConfig ?? undefined,
  }
}

/**
 * Extract the fallback locale chain.
 * Tries to read from the i18n options or the i18n.config.ts file.
 */
function extractFallbackLocale(
  i18nOptions: Record<string, unknown>,
  _projectDir: string,
): Record<string, string[]> {
  // Check if fallbackLocale is directly in options
  const fallback = i18nOptions.fallbackLocale
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    // Convert to our format — ensure values are string arrays
    const result: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(fallback as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        result[key] = value.map(String)
      } else if (typeof value === 'string') {
        result[key] = [value]
      }
    }
    return result
  }

  // Default fallback
  const defaultLocale = (i18nOptions.defaultLocale as string) ?? 'en'
  return { default: [defaultLocale] }
}

/**
 * Discover locale directories from Nuxt layers.
 * Replicates the @nuxtjs/i18n langDir resolution logic.
 */
async function discoverLocaleDirs(
  layers: Array<{ config: { rootDir: string; i18n?: Record<string, unknown> } }>,
  i18nOptions: Record<string, unknown>,
  projectDir: string,
): Promise<LocaleDir[]> {
  const dirs: LocaleDir[] = []
  const resolvedPaths = new Map<string, string>() // path -> layer name (for alias detection)

  for (const layer of layers) {
    const layerRootDir = layer.config.rootDir
    const layerName = deriveLayerName(layerRootDir, projectDir)
    const layerI18n = layer.config.i18n ?? i18nOptions

    // Resolve langDir: default is 'locales' relative to '<layerRoot>/i18n/'
    const langDir = (layerI18n.langDir as string) ?? 'locales'
    const restructureDir = (layerI18n.restructureDir as string) ?? 'i18n'
    const resolvedDir = resolve(layerRootDir, restructureDir, langDir)

    if (!existsSync(resolvedDir)) {
      log.debug(`Locale dir not found for layer '${layerName}': ${resolvedDir}`)
      continue
    }

    // Check if this resolved path is an alias to another layer's dir
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

    // Verify the directory contains JSON files
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

/**
 * Derive a human-friendly layer name from its root directory.
 * e.g., '/path/to/anny-ui' → 'root', '/path/to/anny-ui/app-admin' → 'app-admin'
 */
function deriveLayerName(layerRootDir: string, projectDir: string): string {
  const rel = relative(projectDir, layerRootDir)
  if (rel === '' || rel === '.') {
    return 'root'
  }
  return basename(layerRootDir)
}
