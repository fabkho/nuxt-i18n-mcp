import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ProjectConfig } from './types.js'
import { ConfigError } from '../utils/errors.js'
import { log } from '../utils/logger.js'

const CONFIG_FILENAME = '.i18n-mcp.json'

/**
 * Walk up the directory tree from `startDir` to find the nearest config file.
 * Returns the full path if found, null otherwise.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = startDir
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return null
}

/**
 * Load the optional project config file (.i18n-mcp.json).
 * Walks up from projectDir to find the nearest config file,
 * similar to how ESLint, Prettier, and tsconfig resolve configs.
 * Returns null if no config file is found in any ancestor.
 * Throws ConfigError if a file is found but is invalid.
 */
export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig | null> {
  log.debug(`Searching for ${CONFIG_FILENAME} starting from: ${projectDir}`)

  const configPath = findConfigFile(projectDir)

  if (!configPath) {
    log.info(`No ${CONFIG_FILENAME} found in ${projectDir} or any parent directory — skipping`)
    return null
  }

  log.info(`Found project config: ${configPath}`)

  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch (error) {
    throw new ConfigError(
      `Failed to read ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${CONFIG_FILENAME} must contain a JSON object at the root level`)
  }

  const config = parsed as Record<string, unknown>

  // Validate context
  if ('context' in config && typeof config.context !== 'string') {
    throw new ConfigError(`${CONFIG_FILENAME}: "context" must be a string`)
  }

  // Validate layerRules
  if ('layerRules' in config) {
    if (!Array.isArray(config.layerRules)) {
      throw new ConfigError(`${CONFIG_FILENAME}: "layerRules" must be an array`)
    }
    for (let i = 0; i < config.layerRules.length; i++) {
      const rule = config.layerRules[i]
      if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
        throw new ConfigError(`${CONFIG_FILENAME}: "layerRules[${i}]" must be an object`)
      }
      const ruleObj = rule as Record<string, unknown>
      if (typeof ruleObj.layer !== 'string') {
        throw new ConfigError(`${CONFIG_FILENAME}: "layerRules[${i}].layer" must be a string`)
      }
      if (typeof ruleObj.description !== 'string') {
        throw new ConfigError(`${CONFIG_FILENAME}: "layerRules[${i}].description" must be a string`)
      }
      if (typeof ruleObj.when !== 'string') {
        throw new ConfigError(`${CONFIG_FILENAME}: "layerRules[${i}].when" must be a string`)
      }
    }
  }

  // Validate glossary
  if ('glossary' in config) {
    if (typeof config.glossary !== 'object' || config.glossary === null || Array.isArray(config.glossary)) {
      throw new ConfigError(`${CONFIG_FILENAME}: "glossary" must be an object (Record<string, string>)`)
    }
    const glossary = config.glossary as Record<string, unknown>
    for (const [key, value] of Object.entries(glossary)) {
      if (typeof value !== 'string') {
        throw new ConfigError(`${CONFIG_FILENAME}: "glossary.${key}" must be a string`)
      }
    }
  }

  // Validate translationPrompt
  if ('translationPrompt' in config && typeof config.translationPrompt !== 'string') {
    throw new ConfigError(`${CONFIG_FILENAME}: "translationPrompt" must be a string`)
  }

  // Validate localeNotes
  if ('localeNotes' in config) {
    if (typeof config.localeNotes !== 'object' || config.localeNotes === null || Array.isArray(config.localeNotes)) {
      throw new ConfigError(`${CONFIG_FILENAME}: "localeNotes" must be an object (Record<string, string>)`)
    }
    const localeNotes = config.localeNotes as Record<string, unknown>
    for (const [key, value] of Object.entries(localeNotes)) {
      if (typeof value !== 'string') {
        throw new ConfigError(`${CONFIG_FILENAME}: "localeNotes.${key}" must be a string`)
      }
    }
  }

  // Validate examples
  if ('examples' in config) {
    if (!Array.isArray(config.examples)) {
      throw new ConfigError(`${CONFIG_FILENAME}: "examples" must be an array`)
    }
    for (let i = 0; i < config.examples.length; i++) {
      const example = config.examples[i]
      if (typeof example !== 'object' || example === null || Array.isArray(example)) {
        throw new ConfigError(`${CONFIG_FILENAME}: "examples[${i}]" must be an object`)
      }
      const exampleObj = example as Record<string, unknown>
      for (const [key, value] of Object.entries(exampleObj)) {
        if (typeof value !== 'string') {
          throw new ConfigError(`${CONFIG_FILENAME}: "examples[${i}].${key}" must be a string`)
        }
      }
    }
  }

  // Validate orphanScan
  if ('orphanScan' in config) {
    if (typeof config.orphanScan !== 'object' || config.orphanScan === null || Array.isArray(config.orphanScan)) {
      throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan" must be an object`)
    }
    const orphanScan = config.orphanScan as Record<string, unknown>
    for (const [layerName, layerConfig] of Object.entries(orphanScan)) {
      if (typeof layerConfig !== 'object' || layerConfig === null || Array.isArray(layerConfig)) {
        throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan.${layerName}" must be an object`)
      }
      const layerObj = layerConfig as Record<string, unknown>
      if (!Array.isArray(layerObj.scanDirs)) {
        throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan.${layerName}.scanDirs" must be an array of strings`)
      }
      for (let i = 0; i < layerObj.scanDirs.length; i++) {
        if (typeof layerObj.scanDirs[i] !== 'string') {
          throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan.${layerName}.scanDirs[${i}]" must be a string`)
        }
      }
      if ('ignorePatterns' in layerObj) {
        if (!Array.isArray(layerObj.ignorePatterns)) {
          throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan.${layerName}.ignorePatterns" must be an array of strings`)
        }
        for (let i = 0; i < layerObj.ignorePatterns.length; i++) {
          if (typeof layerObj.ignorePatterns[i] !== 'string') {
            throw new ConfigError(`${CONFIG_FILENAME}: "orphanScan.${layerName}.ignorePatterns[${i}]" must be a string`)
          }
        }
      }
    }
  }

  log.debug(`Project config loaded successfully from ${configPath}`)

  return {
    context: config.context as string | undefined,
    layerRules: config.layerRules as ProjectConfig['layerRules'],
    glossary: config.glossary as Record<string, string> | undefined,
    translationPrompt: config.translationPrompt as string | undefined,
    localeNotes: config.localeNotes as Record<string, string> | undefined,
    examples: config.examples as Array<Record<string, string>> | undefined,
    orphanScan: config.orphanScan as ProjectConfig['orphanScan'],
  }
}
