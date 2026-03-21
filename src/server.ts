import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { detectI18nConfig, getCachedConfig } from './config/detector.js'
import type { I18nConfig, ProjectConfig } from './config/types.js'
import { readLocaleFile } from './io/json-reader.js'
import { mutateLocaleFile } from './io/json-writer.js'
import {
  getNestedValue,
  setNestedValue,
  hasNestedKey,
  getLeafKeys,
  removeNestedValue,
  renameNestedKey,
  validateTranslationValue,
} from './io/key-operations.js'
import { scanSourceFiles, toRelativePath, buildDynamicKeyRegexes } from './scanner/code-scanner.js'
import { log } from './utils/logger.js'
import { ToolError } from './utils/errors.js'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

// ─── Shared helpers ───────────────────────────────────────────────

/**
 * Format a caught error into an MCP tool error response.
 */
function toolErrorResponse(context: string, error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof ToolError
          ? `[${error.code}] ${error.message}`
          : `Error ${context}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  }
}

/**
 * Shared logic for add_translations and update_translations.
 * - mode 'add': fails if key already exists
 * - mode 'update': fails if key does not exist
 */
async function applyTranslations(
  config: I18nConfig,
  layer: string,
  translations: Record<string, Record<string, string>>,
  mode: 'add' | 'update',
  findLocale: (config: I18nConfig, ref: string) => ReturnType<typeof findLocaleImpl>,
  resolveLocaleFilePath: (config: I18nConfig, layer: string, file: string) => string | null,
): Promise<{ applied: string[]; skipped: string[]; warnings: string[]; filesWritten: number }> {
  const applied: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []
  const filesWritten = new Set<string>()

  // Group translations by locale file
  const byFile = new Map<string, Array<{ key: string; value: string }>>()

  for (const [key, localeValues] of Object.entries(translations)) {
    for (const [localeRef, value] of Object.entries(localeValues)) {
      if (mode === 'add') {
        const warning = validateTranslationValue(value)
        if (warning) {
          warnings.push(`${key} (${localeRef}): ${warning}`)
        }
      }
      const locale = findLocale(config, localeRef)
      if (!locale) {
        log.warn(`Locale not found: ${localeRef}, skipping`)
        continue
      }
      const filePath = resolveLocaleFilePath(config, layer, locale.file)
      if (!filePath) {
        log.warn(`No locale dir found for layer '${layer}', skipping`)
        continue
      }
      if (!byFile.has(filePath)) {
        byFile.set(filePath, [])
      }
      byFile.get(filePath)!.push({ key, value })
    }
  }

  // Apply changes per file
  for (const [filePath, entries] of byFile) {
    await mutateLocaleFile(filePath, (data) => {
      for (const { key, value } of entries) {
        const exists = hasNestedKey(data, key)
        if (mode === 'add' && exists) {
          skipped.push(key)
        } else if (mode === 'update' && !exists) {
          skipped.push(key)
        } else {
          setNestedValue(data, key, value)
          applied.push(key)
        }
      }
    })
    filesWritten.add(filePath)
  }

  return {
    applied: [...new Set(applied)],
    skipped: [...new Set(skipped)],
    warnings,
    filesWritten: filesWritten.size,
  }
}

// ─── Sampling prompt helpers ──────────────────────────────────────

/**
 * Build a system prompt for translation sampling from project config.
 */
function buildTranslationSystemPrompt(
  projectConfig: ProjectConfig | undefined,
  targetLocaleCode: string,
): string {
  const parts: string[] = []

  // 1. Translation prompt from project config
  if (projectConfig?.translationPrompt) {
    parts.push(projectConfig.translationPrompt)
  }

  // 2. Glossary
  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    const glossaryLines = Object.entries(projectConfig.glossary)
      .map(([term, definition]) => `- ${term} → ${definition}`)
      .join('\n')
    parts.push(`GLOSSARY — use these terms consistently:\n${glossaryLines}`)
  }

  // 3. Locale-specific notes
  if (projectConfig?.localeNotes?.[targetLocaleCode]) {
    parts.push(`TARGET LOCALE NOTE (${targetLocaleCode}): ${projectConfig.localeNotes[targetLocaleCode]}`)
  }

  // 4. Examples
  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    const exampleLines = projectConfig.examples
      .map((ex) => {
        const pairs = Object.entries(ex)
          .filter(([k]) => k !== 'key' && k !== 'note')
          .map(([locale, val]) => `${locale}: "${val}"`)
          .join(', ')
        const note = ex.note ? ` (${ex.note})` : ''
        return `- ${ex.key}: ${pairs}${note}`
      })
      .join('\n')
    parts.push(`STYLE EXAMPLES:\n${exampleLines}`)
  }

  if (parts.length === 0) {
    return 'You are a professional translator for software UI strings. Preserve all {placeholder} parameters and @:linked.message references. Be concise — UI space is limited.'
  }

  return parts.join('\n\n')
}

/**
 * Build the user message for a translation sampling request.
 */
function buildTranslationUserMessage(
  referenceLocaleCode: string,
  targetLocaleCode: string,
  keysAndValues: Record<string, string>,
): string {
  return [
    `Translate the following i18n key-value pairs from ${referenceLocaleCode} to ${targetLocaleCode}.`,
    'Preserve all {placeholder} parameters and @:linked.message references.',
    'Return ONLY a JSON object mapping keys to translated values. No markdown, no explanation, no code fences.',
    '',
    JSON.stringify(keysAndValues, null, 2),
  ].join('\n')
}

/**
 * Build a fallback context object when sampling is not available.
 * Returns everything the agent needs to translate inline.
 */
function buildFallbackContext(
  projectConfig: ProjectConfig | undefined,
  referenceLocaleCode: string,
  targetLocaleCode: string,
  keysAndValues: Record<string, string>,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    instruction: `Translate these keys from ${referenceLocaleCode} to ${targetLocaleCode}, then call add_translations to write them.`,
    referenceLocale: referenceLocaleCode,
    targetLocale: targetLocaleCode,
    keysToTranslate: keysAndValues,
  }

  if (projectConfig?.translationPrompt) {
    context.translationPrompt = projectConfig.translationPrompt
  }
  if (projectConfig?.glossary && Object.keys(projectConfig.glossary).length > 0) {
    context.glossary = projectConfig.glossary
  }
  if (projectConfig?.localeNotes?.[targetLocaleCode]) {
    context.localeNote = projectConfig.localeNotes[targetLocaleCode]
  }
  if (projectConfig?.examples && projectConfig.examples.length > 0) {
    context.examples = projectConfig.examples
  }

  return context
}

// ─── Find locale helper (module-level for type reuse) ────────────

function findLocaleImpl(config: I18nConfig, localeRef: string) {
  return config.locales.find(
    l => l.code === localeRef || l.file === localeRef || l.language === localeRef,
  )
}

/**
 * Create and configure the MCP server with all tools.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nuxt-i18n-mcp',
    version: '0.1.0',
  })

  // Helper: resolve locale file path for a layer + locale file name
  function resolveLocaleFilePath(config: I18nConfig, layer: string, localeFile: string): string | null {
    const dir = config.localeDirs.find(d => d.layer === layer)
    if (!dir) return null
    // If this is an alias, resolve to the aliased layer's dir
    if (dir.aliasOf) {
      const aliasDir = config.localeDirs.find(d => d.layer === dir.aliasOf)
      if (aliasDir) return join(aliasDir.path, localeFile)
    }
    return join(dir.path, localeFile)
  }

  // Helper: find locale definition by locale code or file name
  function findLocale(config: I18nConfig, localeRef: string) {
    return findLocaleImpl(config, localeRef)
  }

  // ─── Tool: detect_i18n_config ──────────────────────────────────

  server.registerTool(
    'detect_i18n_config',
    {
      title: 'Detect i18n Config',
      description:
        'Detect the Nuxt i18n configuration from the project. Returns locales, locale directories, default locale, and fallback chain. Call this first before using other tools.',
      inputSchema: {
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(config, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('detecting i18n config', error)
      }
    },
  )

  // ─── Tool: list_locale_dirs ────────────────────────────────────

  server.registerTool(
    'list_locale_dirs',
    {
      title: 'List Locale Directories',
      description:
        'List all i18n locale directories in the project, grouped by layer. Shows file count and top-level key namespaces per layer.',
      inputSchema: {
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        const results = []

        for (const localeDir of config.localeDirs) {
          if (localeDir.aliasOf) {
            results.push({
              layer: localeDir.layer,
              path: localeDir.path,
              aliasOf: localeDir.aliasOf,
              fileCount: 0,
              topLevelKeys: [],
            })
            continue
          }

          const files = await readdir(localeDir.path)
          const jsonFiles = files.filter(f => f.endsWith('.json'))

          // Read first JSON file to get top-level keys
          let topLevelKeys: string[] = []
          if (jsonFiles.length > 0) {
            try {
              const sampleFile = join(localeDir.path, jsonFiles[0])
              const data = await readLocaleFile(sampleFile)
              topLevelKeys = Object.keys(data)
            } catch {
              // Ignore errors reading sample file
            }
          }

          results.push({
            layer: localeDir.layer,
            path: localeDir.path,
            fileCount: jsonFiles.length,
            topLevelKeys,
          })
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('listing locale dirs', error)
      }
    },
  )

  // ─── Tool: get_translations ────────────────────────────────────

  server.registerTool(
    'get_translations',
    {
      title: 'Get Translations',
      description:
        'Get translation values for given key paths from a specific locale and layer. Use "*" as locale to read from all locales.',
      inputSchema: {
        layer: z.string().describe('Layer name (e.g., "root", "app-admin")'),
        locale: z
          .string()
          .describe('Locale code, file name, or "*" for all locales (e.g., "en", "en-US.json", "*")'),
        keys: z
          .array(z.string())
          .describe('Dot-separated key paths (e.g., ["common.actions.save"])'),
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, locale, keys, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        const localesToRead = locale === '*'
          ? config.locales
          : (() => {
              const found = findLocale(config, locale)
              if (!found) {
                throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
              }
              return [found]
            })()

        const results: Record<string, Record<string, unknown>> = {}

        for (const loc of localesToRead) {
          const filePath = resolveLocaleFilePath(config, layer, loc.file)
          if (!filePath) {
            results[loc.code] = Object.fromEntries(keys.map(k => [k, null]))
            continue
          }

          try {
            const data = await readLocaleFile(filePath)
            results[loc.code] = Object.fromEntries(
              keys.map(k => [k, getNestedValue(data, k) ?? null]),
            )
          } catch {
            results[loc.code] = Object.fromEntries(keys.map(k => [k, null]))
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('getting translations', error)
      }
    },
  )

  // ─── Tool: add_translations ────────────────────────────────────

  server.registerTool(
    'add_translations',
    {
      title: 'Add Translations',
      description:
        'Add new translation keys to the specified layer. Provide translations per locale file name. Keys are inserted in alphabetical order. Fails if a key already exists (use update_translations instead).',
      inputSchema: {
        layer: z.string().describe('Layer name (e.g., "root", "app-admin")'),
        translations: z
          .record(
            z.string().describe('Dot-separated key path'),
            z.record(
              z.string().describe('Locale file name (e.g., "en-US.json") or locale code'),
              z.string().describe('Translation value'),
            ),
          )
          .describe('Map of key paths to locale-value pairs'),
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, translations, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        const { applied, skipped, warnings, filesWritten } = await applyTranslations(
          config, layer, translations, 'add', findLocale, resolveLocaleFilePath,
        )

        const summary: Record<string, unknown> = {
          added: applied,
          skipped,
          filesWritten,
        }
        if (warnings.length > 0) {
          summary.warnings = warnings
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('adding translations', error)
      }
    },
  )

  // ─── Tool: update_translations ─────────────────────────────────

  server.registerTool(
    'update_translations',
    {
      title: 'Update Translations',
      description:
        'Update existing translation keys in the specified layer. Provide new values per locale file name. Fails if a key does not exist (use add_translations instead).',
      inputSchema: {
        layer: z.string().describe('Layer name (e.g., "root", "app-admin")'),
        translations: z
          .record(
            z.string().describe('Dot-separated key path'),
            z.record(
              z.string().describe('Locale file name (e.g., "en-US.json") or locale code'),
              z.string().describe('New translation value'),
            ),
          )
          .describe('Map of key paths to locale-value pairs'),
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, translations, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        const { applied, skipped, filesWritten } = await applyTranslations(
          config, layer, translations, 'update', findLocale, resolveLocaleFilePath,
        )

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                updated: applied,
                skipped,
                filesWritten,
              }, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('updating translations', error)
      }
    },
  )

  // ─── Tool: get_missing_translations ────────────────────────────

  server.registerTool(
    'get_missing_translations',
    {
      title: 'Get Missing Translations',
      description:
        'Find translation keys that exist in the reference locale but are missing in other locales. Scans a specific layer or all layers.',
      inputSchema: {
        layer: z.string().optional().describe('Layer name to scan. If omitted, scans all layers.'),
        referenceLocale: z.string().optional().describe('Reference locale code to compare against. Defaults to the project default locale.'),
        targetLocales: z.array(z.string()).optional().describe('Locale codes to check for missing keys. Defaults to all locales except the reference.'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, referenceLocale, targetLocales, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        // Determine reference locale
        const refCode = referenceLocale ?? config.defaultLocale
        const refLocale = findLocale(config, refCode)
        if (!refLocale) {
          throw new ToolError(`Reference locale not found: "${refCode}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass a valid locale code as referenceLocale, or omit it to use the project default.`, 'REFERENCE_LOCALE_NOT_FOUND')
        }

        // Determine target locales
        const targets = targetLocales
          ? targetLocales.map((code) => {
              const loc = findLocale(config, code)
              if (!loc) {
                throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
              }
              return loc
            })
          : config.locales.filter(l => l.code !== refLocale.code)

        // Determine layers to scan
        const layersToScan = layer
          ? config.localeDirs.filter(d => d.layer === layer)
          : config.localeDirs.filter(d => !d.aliasOf)

        if (layersToScan.length === 0) {
          if (layer) {
            throw new ToolError(`Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}. Use list_locale_dirs to see all layers.`, 'LAYER_NOT_FOUND')
          }
          throw new ToolError('No locale directories found. Run detect_i18n_config to verify the project setup.', 'LAYER_NOT_FOUND')
        }

        const result: Record<string, Record<string, string[]>> = {}
        let totalMissing = 0

        for (const localeDir of layersToScan) {
          // Read reference locale file for this layer
          const refFilePath = resolveLocaleFilePath(config, localeDir.layer, refLocale.file)
          if (!refFilePath) continue

          let refData: Record<string, unknown>
          try {
            refData = await readLocaleFile(refFilePath)
          } catch {
            // Reference file doesn't exist in this layer, skip
            continue
          }

          // Only consider ref keys that have non-empty values
          const refKeys = getLeafKeys(refData).filter(k => {
            const v = getNestedValue(refData, k)
            return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
          })
          if (refKeys.length === 0) continue

          for (const target of targets) {
            const targetFilePath = resolveLocaleFilePath(config, localeDir.layer, target.file)
            let targetData: Record<string, unknown> = {}

            if (targetFilePath) {
              try {
                targetData = await readLocaleFile(targetFilePath)
              } catch {
                // Target file doesn't exist — all ref keys are missing
              }
            }

            // A key is missing if it doesn't exist OR its value is an empty string
            const missing = refKeys.filter(k => {
              const v = getNestedValue(targetData, k)
              return v === undefined || v === '' || v === null
            })

            if (missing.length > 0) {
              if (!result[target.code]) {
                result[target.code] = {}
              }
              result[target.code][localeDir.layer] = missing
              totalMissing += missing.length
            }
          }
        }

        const output = {
          missing: result,
          summary: {
            referenceLocale: refLocale.code,
            targetLocales: targets.map(t => t.code),
            layersScanned: layersToScan.map(d => d.layer),
            totalMissingKeys: totalMissing,
          },
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('finding missing translations', error)
      }
    },
  )

  // ─── Tool: search_translations ─────────────────────────────────

  server.registerTool(
    'search_translations',
    {
      title: 'Search Translations',
      description:
        'Search translation files by key pattern (glob/regex) or value substring. Useful for finding existing translations before adding duplicates.',
      inputSchema: {
        query: z.string().describe('Search query — matched against keys and/or values'),
        searchIn: z.enum(['keys', 'values', 'both']).optional().describe('Where to search. Default: "both"'),
        layer: z.string().optional().describe('Layer to search in. If omitted, searches all layers.'),
        locale: z.string().optional().describe('Locale to search in. If omitted, searches all locales.'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ query, searchIn, layer, locale, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        const mode = searchIn ?? 'both'
        const queryLower = query.toLowerCase()

        // Determine layers to search
        const layersToSearch = layer
          ? config.localeDirs.filter(d => d.layer === layer)
          : config.localeDirs.filter(d => !d.aliasOf)

        if (layersToSearch.length === 0) {
          if (layer) {
            throw new ToolError(`Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}. Use list_locale_dirs to see all layers.`, 'LAYER_NOT_FOUND')
          }
          throw new ToolError('No locale directories found. Run detect_i18n_config to verify the project setup.', 'LAYER_NOT_FOUND')
        }

        // Determine locales to search
        const localesToSearch = locale
          ? (() => {
              const found = findLocale(config, locale)
              if (!found) {
                throw new ToolError(`Locale not found: "${locale}". Available: ${config.locales.map(l => l.code).join(', ')}. Use one of the available locale codes or file names.`, 'LOCALE_NOT_FOUND')
              }
              return [found]
            })()
          : config.locales

        const matches: Array<{ layer: string; locale: string; key: string; value: unknown }> = []

        for (const localeDir of layersToSearch) {
          for (const loc of localesToSearch) {
            const filePath = resolveLocaleFilePath(config, localeDir.layer, loc.file)
            if (!filePath) continue

            let data: Record<string, unknown>
            try {
              data = await readLocaleFile(filePath)
            } catch {
              // File doesn't exist in this layer, skip
              continue
            }

            const leafKeys = getLeafKeys(data)

            for (const key of leafKeys) {
              const value = getNestedValue(data, key)
              const valueStr = typeof value === 'string' ? value : JSON.stringify(value)

              const keyMatch = mode === 'keys' || mode === 'both'
                ? key.toLowerCase().includes(queryLower)
                : false
              const valueMatch = mode === 'values' || mode === 'both'
                ? valueStr.toLowerCase().includes(queryLower)
                : false

              if (keyMatch || valueMatch) {
                matches.push({
                  layer: localeDir.layer,
                  locale: loc.code,
                  key,
                  value,
                })
              }
            }
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ matches, totalMatches: matches.length }, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('searching translations', error)
      }
    },
  )

  // ─── Tool: remove_translations ─────────────────────────────────

  server.registerTool(
    'remove_translations',
    {
      title: 'Remove Translations',
      description:
        'Remove one or more translation keys from ALL locale files in the specified layer. Use dryRun to preview changes before applying them.',
      inputSchema: {
        layer: z.string().describe('Layer name (e.g., "root", "app-admin")'),
        keys: z
          .array(z.string())
          .describe('Dot-separated key paths to remove (e.g., ["common.actions.save"])'),
        dryRun: z
          .boolean()
          .optional()
          .describe('If true, return a preview of changes without writing. Default: false.'),
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, keys, dryRun, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)
        const isDryRun = dryRun ?? false

        const localeDir = config.localeDirs.find(d => d.layer === layer)
        if (!localeDir) {
          throw new ToolError(`Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}. Use list_locale_dirs to see all layers.`, 'LAYER_NOT_FOUND')
        }
        if (localeDir.aliasOf) {
          throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
        }

        const preview: Array<{ locale: string; key: string; oldValue: unknown }> = []
        const removed: string[] = []
        const notFound: string[] = []
        const filesWritten = new Set<string>()

        for (const locale of config.locales) {
          const filePath = resolveLocaleFilePath(config, layer, locale.file)
          if (!filePath) continue

          let data: Record<string, unknown>
          try {
            data = await readLocaleFile(filePath)
          } catch {
            continue
          }

          if (isDryRun) {
            for (const key of keys) {
              const value = getNestedValue(data, key)
              if (value !== undefined) {
                preview.push({ locale: locale.code, key, oldValue: value })
              }
            }
          } else {
            await mutateLocaleFile(filePath, (fileData) => {
              for (const key of keys) {
                if (removeNestedValue(fileData, key)) {
                  removed.push(`${locale.code}:${key}`)
                } else {
                  notFound.push(`${locale.code}:${key}`)
                }
              }
            })
            filesWritten.add(filePath)
          }
        }

        if (isDryRun) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  dryRun: true,
                  wouldRemove: preview,
                  summary: {
                    keysFound: preview.length,
                    message: 'Call again with dryRun: false to apply these changes.',
                  },
                }, null, 2),
              },
            ],
          }
        }

        const uniqueRemoved = [...new Set(removed.map(r => r.split(':')[1]))]
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                removed: uniqueRemoved,
                removedPerLocale: removed,
                notFound: [...new Set(notFound)],
                filesWritten: filesWritten.size,
              }, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('removing translations', error)
      }
    },
  )

  // ─── Tool: rename_translation_key ──────────────────────────────

  server.registerTool(
    'rename_translation_key',
    {
      title: 'Rename Translation Key',
      description:
        'Rename/move a translation key across ALL locale files in a layer. Preserves the value in every locale. Use dryRun to preview changes before applying them.',
      inputSchema: {
        layer: z.string().describe('Layer name (e.g., "root", "app-admin")'),
        oldKey: z.string().describe('Current dot-separated key path (e.g., "common.actions.save")'),
        newKey: z.string().describe('New dot-separated key path (e.g., "common.buttons.save")'),
        dryRun: z
          .boolean()
          .optional()
          .describe('If true, return a preview of changes without writing. Default: false.'),
        projectDir: z
          .string()
          .optional()
          .describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, oldKey, newKey, dryRun, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)
        const isDryRun = dryRun ?? false

        if (oldKey === newKey) {
          throw new ToolError(`Old key and new key are the same: "${oldKey}". Provide a different newKey to rename to.`, 'SAME_KEY')
        }

        const localeDir = config.localeDirs.find(d => d.layer === layer)
        if (!localeDir) {
          throw new ToolError(`Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}. Use list_locale_dirs to see all layers.`, 'LAYER_NOT_FOUND')
        }
        if (localeDir.aliasOf) {
          throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
        }

        const preview: Array<{ locale: string; oldKey: string; newKey: string; value: unknown }> = []
        const renamed: string[] = []
        const notFound: string[] = []
        const conflicts: string[] = []
        const filesWritten = new Set<string>()

        for (const locale of config.locales) {
          const filePath = resolveLocaleFilePath(config, layer, locale.file)
          if (!filePath) continue

          let data: Record<string, unknown>
          try {
            data = await readLocaleFile(filePath)
          } catch {
            continue
          }

          const oldValue = getNestedValue(data, oldKey)
          if (oldValue === undefined) {
            notFound.push(locale.code)
            continue
          }

          if (hasNestedKey(data, newKey)) {
            conflicts.push(locale.code)
            continue
          }

          if (isDryRun) {
            preview.push({ locale: locale.code, oldKey, newKey, value: oldValue })
          } else {
            await mutateLocaleFile(filePath, (fileData) => {
              renameNestedKey(fileData, oldKey, newKey)
            })
            renamed.push(locale.code)
            filesWritten.add(filePath)
          }
        }

        if (isDryRun) {
          const result: Record<string, unknown> = {
            dryRun: true,
            wouldRename: preview,
            summary: {
              localesAffected: preview.length,
              message: 'Call again with dryRun: false to apply these changes.',
            },
          }
          if (notFound.length > 0) {
            result.notFoundInLocales = notFound
          }
          if (conflicts.length > 0) {
            result.conflictsInLocales = conflicts
            result.summary = {
              ...(result.summary as Record<string, unknown>),
              warning: `New key "${newKey}" already exists in ${conflicts.length} locale(s). These will be skipped.`,
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          }
        }

        const summary: Record<string, unknown> = {
          renamed: renamed,
          filesWritten: filesWritten.size,
          oldKey,
          newKey,
        }
        if (notFound.length > 0) {
          summary.notFoundInLocales = notFound
        }
        if (conflicts.length > 0) {
          summary.skippedDueToConflict = conflicts
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(summary, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('renaming translation key', error)
      }
    },
  )

  // ─── Tool: translate_missing ───────────────────────────────────

  server.registerTool(
    'translate_missing',
    {
      title: 'Translate Missing',
      description:
        'Find keys missing in target locales and translate them. Uses the host LLM via MCP sampling if available, otherwise returns context for the agent to translate inline. Uses project config (glossary, translation prompt, locale notes, examples) if available.',
      annotations: {
        title: 'Translate Missing Translations',
        readOnlyHint: false,
      },
      inputSchema: {
        layer: z.string().describe('Layer name to translate (e.g., "root", "app-admin")'),
        referenceLocale: z.string().optional().describe('Reference locale code. Defaults to the project default locale.'),
        targetLocales: z.array(z.string()).optional().describe('Locale codes to translate into. Defaults to all locales except the reference.'),
        keys: z.array(z.string()).optional().describe('Specific keys to translate. If omitted, translates all missing keys.'),
        batchSize: z.number().optional().describe('Max keys per sampling request. Default: 50.'),
        dryRun: z.boolean().optional().describe('If true, return what would be translated without writing. Default: false.'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, referenceLocale, targetLocales, keys, batchSize, dryRun, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)
        const isDryRun = dryRun ?? false
        const maxBatch = batchSize ?? 50

        // Validate layer
        const localeDir = config.localeDirs.find(d => d.layer === layer)
        if (!localeDir) {
          throw new ToolError(`Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}. Use list_locale_dirs to see all layers.`, 'LAYER_NOT_FOUND')
        }
        if (localeDir.aliasOf) {
          throw new ToolError(`Layer "${layer}" is an alias of "${localeDir.aliasOf}". Modify the source layer "${localeDir.aliasOf}" instead.`, 'LAYER_IS_ALIAS')
        }

        // Determine reference locale
        const refCode = referenceLocale ?? config.defaultLocale
        const refLocale = findLocale(config, refCode)
        if (!refLocale) {
          throw new ToolError(`Reference locale not found: "${refCode}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass a valid locale code as referenceLocale, or omit it to use the project default.`, 'REFERENCE_LOCALE_NOT_FOUND')
        }

        // Read reference locale file
        const refFilePath = resolveLocaleFilePath(config, layer, refLocale.file)
        if (!refFilePath) {
          throw new ToolError(`No locale file found for reference locale "${refCode}" in layer "${layer}". Verify the layer exists and contains a file for this locale using list_locale_dirs.`, 'NO_LOCALE_FILE')
        }
        const refData = await readLocaleFile(refFilePath)
        // Only consider ref keys that have non-empty values
        const allRefKeys = getLeafKeys(refData).filter(k => {
          const v = getNestedValue(refData, k)
          return typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined
        })

        // Determine target locales
        const targets = targetLocales
          ? targetLocales.map((code) => {
              const loc = findLocale(config, code)
              if (!loc) {
                throw new ToolError(`Target locale not found: "${code}". Available: ${config.locales.map(l => l.code).join(', ')}. Pass valid locale codes in targetLocales.`, 'LOCALE_NOT_FOUND')
              }
              return loc
            })
          : config.locales.filter(l => l.code !== refLocale.code)

        // Check sampling support
        const clientCapabilities = server.server.getClientCapabilities()
        const samplingSupported = !!clientCapabilities?.sampling

        const results: Record<string, { translated: string[]; failed: string[]; samplingUsed: boolean }> = {}
        const fallbackContexts: Record<string, Record<string, unknown>> = {}

        for (const target of targets) {
          const targetFilePath = resolveLocaleFilePath(config, layer, target.file)
          let targetData: Record<string, unknown> = {}

          if (targetFilePath) {
            try {
              targetData = await readLocaleFile(targetFilePath)
            } catch {
              // File doesn't exist yet — all keys are missing
            }
          }

          // A key is missing if it doesn't exist OR its value is an empty string
          const isKeyMissing = (k: string): boolean => {
            const v = getNestedValue(targetData, k)
            return v === undefined || v === '' || v === null
          }

          // Determine which keys need translation
          let missingKeys: string[]
          if (keys) {
            // Only translate specified keys that are actually missing
            missingKeys = keys.filter(k => isKeyMissing(k) && allRefKeys.includes(k))
          } else {
            missingKeys = allRefKeys.filter(k => isKeyMissing(k))
          }

          if (missingKeys.length === 0) {
            results[target.code] = { translated: [], failed: [], samplingUsed: false }
            continue
          }

          // Build key-value pairs from reference
          const keysAndValues: Record<string, string> = {}
          for (const key of missingKeys) {
            const value = getNestedValue(refData, key)
            if (typeof value === 'string') {
              keysAndValues[key] = value
            }
          }

          if (isDryRun) {
            results[target.code] = {
              translated: Object.keys(keysAndValues),
              failed: [],
              samplingUsed: samplingSupported,
            }
            continue
          }

          if (samplingSupported) {
            // Use MCP sampling to translate
            const translated: string[] = []
            const failed: string[] = []
            const keyEntries = Object.entries(keysAndValues)

            // Accumulate all translations across batches, write once at the end
            const allTranslations: Record<string, string> = {}

            // Process in batches
            for (let i = 0; i < keyEntries.length; i += maxBatch) {
              const batch = Object.fromEntries(keyEntries.slice(i, i + maxBatch))

              try {
                const systemPrompt = buildTranslationSystemPrompt(config.projectConfig, target.language || target.code)
                const userMessage = buildTranslationUserMessage(
                  refLocale.language || refLocale.code,
                  target.language || target.code,
                  batch,
                )

                const samplingResult = await server.server.createMessage({
                  messages: [
                    {
                      role: 'user',
                      content: { type: 'text', text: userMessage },
                    },
                  ],
                  systemPrompt,
                  maxTokens: 4096,
                  includeContext: 'none',
                })

                // Parse the response
                const responseText = samplingResult.content.type === 'text'
                  ? samplingResult.content.text
                  : ''

                // Try to extract JSON from the response (handle potential markdown fencing)
                let cleanJson = responseText.trim()
                if (cleanJson.startsWith('```')) {
                  cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
                }

                const translations = JSON.parse(cleanJson) as Record<string, string>

                for (const [key, value] of Object.entries(translations)) {
                  if (typeof value === 'string') {
                    allTranslations[key] = value
                    translated.push(key)
                  }
                }
              } catch (error) {
                log.warn(`Sampling failed for batch in ${target.code}: ${error instanceof Error ? error.message : String(error)}`)
                failed.push(...Object.keys(batch))
              }
            }

            // Single write per locale file after all batches
            if (targetFilePath && Object.keys(allTranslations).length > 0) {
              await mutateLocaleFile(targetFilePath, (data) => {
                for (const [key, value] of Object.entries(allTranslations)) {
                  setNestedValue(data, key, value)
                }
              })
            }

            results[target.code] = { translated, failed, samplingUsed: true }
          } else {
            // Fallback: return context for agent to translate inline
            fallbackContexts[target.code] = buildFallbackContext(
              config.projectConfig,
              refLocale.language || refLocale.code,
              target.language || target.code,
              keysAndValues,
            )
            results[target.code] = {
              translated: [],
              failed: Object.keys(keysAndValues),
              samplingUsed: false,
            }
          }
        }

        const totalTranslated = Object.values(results).reduce((sum, r) => sum + r.translated.length, 0)
        const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed.length, 0)

        const output: Record<string, unknown> = {
          results,
          summary: {
            samplingSupported,
            totalTranslated,
            totalFailed,
            layer,
            referenceLocale: refLocale.code,
            targetLocales: targets.map(t => t.code),
            dryRun: isDryRun,
          },
        }

        if (Object.keys(fallbackContexts).length > 0) {
          output.fallbackContexts = fallbackContexts
          output.summary = {
            ...(output.summary as Record<string, unknown>),
            message: 'Sampling not supported by this host. Use the fallbackContexts to translate inline, then call add_translations to write the results.',
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('translating missing keys', error)
      }
    },
  )

  // ─── find_orphan_keys ─────────────────────────────────────────

  server.registerTool(
    'find_orphan_keys',
    {
      title: 'Find Orphan Translation Keys',
      description:
        'Find translation keys that exist in locale JSON files but are not referenced in any Vue/TS source code. Scans a specific layer or all layers. Reports keys that can potentially be removed.',
      inputSchema: {
        layer: z.string().optional().describe('Layer name to check. If omitted, checks all layers.'),
        locale: z.string().optional().describe('Locale code to read keys from. Defaults to the project default locale.'),
        scanDirs: z.array(z.string()).optional().describe('Directories to scan for source code (absolute paths). Defaults to all layer root directories.'),
        excludeDirs: z.array(z.string()).optional().describe('Additional directory names to skip when scanning (e.g., ["storybook", "__tests__"]).'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, locale, scanDirs, excludeDirs, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        // Determine which locale to read keys from
        const localeCode = locale ?? config.defaultLocale
        const localeDef = findLocale(config, localeCode)
        if (!localeDef) {
          throw new ToolError(
            `Locale not found: "${localeCode}". Available: ${config.locales.map(l => l.code).join(', ')}`,
            'LOCALE_NOT_FOUND',
          )
        }

        // Determine layers to check
        const layersToCheck = layer
          ? config.localeDirs.filter(d => d.layer === layer)
          : config.localeDirs.filter(d => !d.aliasOf)

        if (layersToCheck.length === 0) {
          if (layer) {
            throw new ToolError(
              `Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}`,
              'LAYER_NOT_FOUND',
            )
          }
          throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
        }

        // Reject alias layers — they share files with their target layer
        if (layer && layersToCheck[0]?.aliasOf) {
          throw new ToolError(
            `Layer "${layer}" is an alias of "${layersToCheck[0].aliasOf}". Use the target layer instead.`,
            'LAYER_IS_ALIAS',
          )
        }

        // Collect all translation keys from locale files
        const allTranslationKeys = new Map<string, string>() // key -> layer
        for (const localeDir of layersToCheck) {
          const filePath = resolveLocaleFilePath(config, localeDir.layer, localeDef.file)
          if (!filePath) continue

          let data: Record<string, unknown>
          try {
            data = await readLocaleFile(filePath)
          } catch {
            continue
          }

          const leafKeys = getLeafKeys(data)
          for (const key of leafKeys) {
            allTranslationKeys.set(key, localeDir.layer)
          }
        }

        if (allTranslationKeys.size === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ orphanKeys: [], summary: { totalKeys: 0, orphanCount: 0, filesScanned: 0, message: 'No translation keys found in locale files.' } }, null, 2),
              },
            ],
          }
        }

        // Determine directories to scan for source code.
        // Use all layer roots (not just those with locale dirs) so layers without
        // i18n/locales/ still have their source files scanned for key usage.
        const dirsToScan = scanDirs ?? config.layerRootDirs

        // Scan all source files for key usage
        const combinedUniqueKeys = new Set<string>()
        let totalFilesScanned = 0
        const allDynamicKeys: Array<{ expression: string; file: string; line: number; callee: string }> = []

        for (const scanDir of dirsToScan) {
          const result = await scanSourceFiles(scanDir, excludeDirs)
          totalFilesScanned += result.filesScanned
          for (const key of result.uniqueKeys) {
            combinedUniqueKeys.add(key)
          }
          allDynamicKeys.push(...result.dynamicKeys)
        }

        // Find orphan keys: translation keys not referenced in source code
        const dynamicKeyRegexes = buildDynamicKeyRegexes(allDynamicKeys)

        const orphanKeys: Array<{ key: string; layer: string }> = []
        let dynamicMatchedCount = 0
        for (const [key, keyLayer] of allTranslationKeys) {
          if (!combinedUniqueKeys.has(key)) {
            if (dynamicKeyRegexes.some(re => re.test(key))) {
              dynamicMatchedCount++
            } else {
              orphanKeys.push({ key, layer: keyLayer })
            }
          }
        }

        // Sort orphans by layer, then key
        orphanKeys.sort((a, b) => a.layer.localeCompare(b.layer) || a.key.localeCompare(b.key))

        // Group by layer for readability
        const byLayer: Record<string, string[]> = {}
        for (const { key, layer: keyLayer } of orphanKeys) {
          if (!byLayer[keyLayer]) byLayer[keyLayer] = []
          byLayer[keyLayer].push(key)
        }

        const output = {
          orphanKeys: byLayer,
          summary: {
            totalKeys: allTranslationKeys.size,
            orphanCount: orphanKeys.length,
            dynamicMatchedCount,
            usedCount: allTranslationKeys.size - orphanKeys.length,
            filesScanned: totalFilesScanned,
            layersChecked: layersToCheck.map(d => d.layer),
            dirsScanned: dirsToScan,
            locale: localeCode,
          },
          dynamicKeyWarning: allDynamicKeys.length > 0
            ? `${allDynamicKeys.length} dynamic key reference(s) found (template literals with interpolation). Some "orphan" keys may actually be used via dynamic keys. Review before removing.`
            : undefined,
          dynamicKeys: allDynamicKeys.length > 0
            ? allDynamicKeys.map(dk => ({
                expression: dk.expression,
                file: toRelativePath(dk.file, dir),
                line: dk.line,
              }))
            : undefined,
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('finding orphan keys', error)
      }
    },
  )

  // ─── scan_code_usage ──────────────────────────────────────────

  server.registerTool(
    'scan_code_usage',
    {
      title: 'Scan Code for Translation Key Usage',
      description:
        'Scan Vue/TS source files to find where translation keys are referenced. Shows file paths and line numbers for each key. Useful for understanding where a key is used before renaming or removing it.',
      inputSchema: {
        keys: z.array(z.string()).optional().describe('Specific dot-path keys to search for. If omitted, returns all key usages found in code.'),
        scanDirs: z.array(z.string()).optional().describe('Directories to scan (absolute paths). Defaults to all layer root directories.'),
        excludeDirs: z.array(z.string()).optional().describe('Additional directory names to skip (e.g., ["storybook", "__tests__"]).'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ keys, scanDirs, excludeDirs, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)

        // Determine directories to scan.
        // Use all layer roots (not just those with locale dirs) so layers without
        // i18n/locales/ still have their source files scanned for key usage.
        const dirsToScan = scanDirs ?? config.layerRootDirs

        // Scan all source files
        const allUsages: Array<{ key: string; file: string; line: number; callee: string }> = []
        const allDynamicKeys: Array<{ expression: string; file: string; line: number; callee: string }> = []
        let totalFilesScanned = 0

        for (const scanDir of dirsToScan) {
          const result = await scanSourceFiles(scanDir, excludeDirs)
          totalFilesScanned += result.filesScanned
          allUsages.push(...result.usages)
          allDynamicKeys.push(...result.dynamicKeys)
        }

        // Filter to requested keys if specified
        const filteredUsages = keys
          ? allUsages.filter(u => keys.includes(u.key))
          : allUsages

        // Group usages by key
        const byKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
        for (const usage of filteredUsages) {
          if (!byKey[usage.key]) byKey[usage.key] = []
          byKey[usage.key].push({
            file: toRelativePath(usage.file, dir),
            line: usage.line,
            callee: usage.callee,
          })
        }

        // Sort keys alphabetically
        const sortedByKey: Record<string, Array<{ file: string; line: number; callee: string }>> = {}
        for (const key of Object.keys(byKey).sort()) {
          sortedByKey[key] = byKey[key]
        }

        // Report keys that were requested but not found
        const notFound = keys
          ? keys.filter(k => !byKey[k])
          : []

        const output: Record<string, unknown> = {
          usages: sortedByKey,
          summary: {
            uniqueKeysFound: Object.keys(sortedByKey).length,
            totalReferences: filteredUsages.length,
            filesScanned: totalFilesScanned,
            dirsScanned: dirsToScan,
          },
        }

        if (notFound.length > 0) {
          output.notFoundInCode = notFound
        }

        if (allDynamicKeys.length > 0) {
          output.dynamicKeys = allDynamicKeys.map(dk => ({
            expression: dk.expression,
            file: toRelativePath(dk.file, dir),
            line: dk.line,
          }))
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        }
      } catch (error) {
        return toolErrorResponse('scanning code usage', error)
      }
    },
  )

  // ─── cleanup_unused_translations ──────────────────────────────

  server.registerTool(
    'cleanup_unused_translations',
    {
      title: 'Cleanup Unused Translations',
      description:
        'Find translation keys not referenced in source code and remove them. Combines find_orphan_keys + remove_translations in one step. Always does a dry run first unless dryRun is explicitly set to false.',
      inputSchema: {
        layer: z.string().optional().describe('Layer name to clean up. If omitted, cleans all layers.'),
        locale: z.string().optional().describe('Locale code to read keys from for orphan detection. Defaults to the project default locale.'),
        scanDirs: z.array(z.string()).optional().describe('Directories to scan for source code (absolute paths). Defaults to all layer root directories.'),
        excludeDirs: z.array(z.string()).optional().describe('Additional directory names to skip when scanning (e.g., ["storybook", "__tests__"]).'),
        dryRun: z.boolean().optional().describe('If true (default), only report what would be removed. Set to false to actually delete the keys.'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, locale, scanDirs, excludeDirs, dryRun, projectDir }) => {
      try {
        const dir = projectDir ?? process.cwd()
        const config = await detectI18nConfig(dir)
        const isDryRun = dryRun ?? true

        // Determine which locale to read keys from
        const localeCode = locale ?? config.defaultLocale
        const localeDef = findLocale(config, localeCode)
        if (!localeDef) {
          throw new ToolError(
            `Locale not found: "${localeCode}". Available: ${config.locales.map(l => l.code).join(', ')}`,
            'LOCALE_NOT_FOUND',
          )
        }

        // Determine layers to check
        const layersToCheck = layer
          ? config.localeDirs.filter(d => d.layer === layer)
          : config.localeDirs.filter(d => !d.aliasOf)

        if (layersToCheck.length === 0) {
          if (layer) {
            throw new ToolError(
              `Layer not found: "${layer}". Available: ${config.localeDirs.map(d => d.layer).join(', ')}`,
              'LAYER_NOT_FOUND',
            )
          }
          throw new ToolError('No locale directories found.', 'LAYER_NOT_FOUND')
        }

        // Reject alias layers — they share files with their target layer
        if (layer && layersToCheck[0]?.aliasOf) {
          throw new ToolError(
            `Layer "${layer}" is an alias of "${layersToCheck[0].aliasOf}". Use the target layer instead.`,
            'LAYER_IS_ALIAS',
          )
        }

        // Collect translation keys per layer
        const keysByLayer = new Map<string, string[]>()
        for (const localeDir of layersToCheck) {
          const filePath = resolveLocaleFilePath(config, localeDir.layer, localeDef.file)
          if (!filePath) continue

          let data: Record<string, unknown>
          try {
            data = await readLocaleFile(filePath)
          } catch {
            continue
          }

          keysByLayer.set(localeDir.layer, getLeafKeys(data))
        }

        const totalKeys = [...keysByLayer.values()].reduce((sum, keys) => sum + keys.length, 0)
        if (totalKeys === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ orphanKeys: {}, removed: {}, summary: { totalKeys: 0, orphanCount: 0, message: 'No translation keys found.' } }, null, 2),
            }],
          }
        }

        // Scan source files for key usage.
        // Use all layer roots (not just those with locale dirs) so layers without
        // i18n/locales/ still have their source files scanned for key usage.
        const dirsToScan = scanDirs ?? config.layerRootDirs
        const combinedUniqueKeys = new Set<string>()
        let totalFilesScanned = 0
        const allDynamicKeys: Array<{ expression: string; file: string; line: number }> = []

        for (const scanDir of dirsToScan) {
          const result = await scanSourceFiles(scanDir, excludeDirs)
          totalFilesScanned += result.filesScanned
          for (const key of result.uniqueKeys) combinedUniqueKeys.add(key)
          allDynamicKeys.push(...result.dynamicKeys.map(dk => ({
            expression: dk.expression,
            file: toRelativePath(dk.file, dir),
            line: dk.line,
          })))
        }

        // Find orphan keys per layer
        const dynamicKeyRegexes = buildDynamicKeyRegexes(allDynamicKeys)

        const orphansByLayer: Record<string, string[]> = {}
        let orphanCount = 0
        let dynamicMatchedCount = 0
        for (const [layerName, keys] of keysByLayer) {
          const orphans = keys.filter((k) => {
            if (combinedUniqueKeys.has(k)) return false
            if (dynamicKeyRegexes.some(re => re.test(k))) {
              dynamicMatchedCount++
              return false
            }
            return true
          }).sort()
          if (orphans.length > 0) {
            orphansByLayer[layerName] = orphans
            orphanCount += orphans.length
          }
        }

        if (orphanCount === 0) {
          const message = dynamicMatchedCount > 0
            ? `No orphan keys found. ${dynamicMatchedCount} key(s) were excluded by dynamic pattern matching.`
            : 'No orphan keys found. All translation keys are referenced in code.'
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                orphanKeys: {},
                summary: { totalKeys, orphanCount: 0, dynamicMatchedCount, filesScanned: totalFilesScanned, message },
              }, null, 2),
            }],
          }
        }

        // Dry run — just report
        if (isDryRun) {
          const output: Record<string, unknown> = {
            orphanKeys: orphansByLayer,
            summary: {
              dryRun: true,
              totalKeys,
              orphanCount,
              dynamicMatchedCount,
              usedCount: totalKeys - orphanCount,
              filesScanned: totalFilesScanned,
              message: `Found ${orphanCount} orphan key(s). ${dynamicMatchedCount > 0 ? `${dynamicMatchedCount} key(s) matched dynamic patterns and were excluded. ` : ''}Call again with dryRun: false to remove them.`,
            },
          }
          if (allDynamicKeys.length > 0) {
            output.dynamicKeyWarning = `${allDynamicKeys.length} dynamic key reference(s) found. Some "orphan" keys may be used via dynamic keys. Review before removing.`
            output.dynamicKeys = allDynamicKeys
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          }
        }

        // Actually remove orphan keys from all locale files in each layer
        const removedByLayer: Record<string, string[]> = {}
        let totalFilesWritten = 0

        for (const [layerName, orphans] of Object.entries(orphansByLayer)) {
          const localeDir = config.localeDirs.find(d => d.layer === layerName)!
          if (localeDir.aliasOf) continue

          for (const localeDef2 of config.locales) {
            const filePath = resolveLocaleFilePath(config, layerName, localeDef2.file)
            if (!filePath) continue

            try {
              await mutateLocaleFile(filePath, (fileData) => {
                for (const key of orphans) {
                  removeNestedValue(fileData, key)
                }
              })
              totalFilesWritten++
            } catch {
              continue
            }
          }

          removedByLayer[layerName] = orphans
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              removed: removedByLayer,
              summary: {
                dryRun: false,
                totalKeys,
                removedCount: orphanCount,
                dynamicMatchedCount,
                remainingCount: totalKeys - orphanCount,
                filesWritten: totalFilesWritten,
                filesScanned: totalFilesScanned,
              },
            }, null, 2),
          }],
        }
      } catch (error) {
        return toolErrorResponse('cleaning up unused translations', error)
      }
    },
  )

  // ─── Resources ────────────────────────────────────────────────

  server.registerResource(
    'locale-file',
    new ResourceTemplate('i18n:///{layer}/{file}', {
      list: async () => {
        const config = getCachedConfig()
        if (!config) {
          return { resources: [] }
        }
        const resources: Array<{
          uri: string
          name: string
          description?: string
          mimeType?: string
        }> = []

        for (const localeDir of config.localeDirs) {
          if (localeDir.aliasOf) continue
          for (const locale of config.locales) {
            resources.push({
              uri: `i18n:///${localeDir.layer}/${locale.file}`,
              name: `${localeDir.layer}/${locale.file}`,
              description: `${locale.name ?? locale.code} translations for ${localeDir.layer} layer`,
              mimeType: 'application/json',
            })
          }
        }

        return { resources }
      },
    }),
    {
      description: 'Locale translation file for a specific layer and locale',
      mimeType: 'application/json',
    },
    async (uri, { layer, file }) => {
      const config = getCachedConfig()
      if (!config) {
        throw new Error('No i18n config detected yet. Call detect_i18n_config first.')
      }
      const filePath = resolveLocaleFilePath(config, layer as string, file as string)
      if (!filePath) {
        throw new Error(`Locale file not found: ${layer}/${file}`)
      }
      const data = await readLocaleFile(filePath)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      }
    },
  )

  // ─── Prompts ──────────────────────────────────────────────────

  server.registerPrompt(
    'add-feature-translations',
    {
      title: 'Add Feature Translations',
      description: 'Guided workflow for adding i18n translations when building a new feature.',
      argsSchema: {
        layer: z.string().optional().describe('Target layer (e.g., "root", "app-admin"). If omitted, uses layerRules from project config.'),
        namespace: z.string().optional().describe('Key namespace for the feature (e.g., "admin.users", "common.actions")'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, namespace, projectDir }) => {
      const dir = projectDir ?? process.cwd()
      let projectConfigSection = ''

      try {
        const config = await detectI18nConfig(dir)
        const pc = config.projectConfig

        if (pc?.context) {
          projectConfigSection += `\nPROJECT CONTEXT: ${pc.context}\n`
        }
        if (pc?.layerRules && pc.layerRules.length > 0) {
          projectConfigSection += '\nLAYER RULES:\n'
          for (const rule of pc.layerRules) {
            projectConfigSection += `- ${rule.layer}: ${rule.description} (when: ${rule.when})\n`
          }
        }
        if (pc?.glossary && Object.keys(pc.glossary).length > 0) {
          projectConfigSection += '\nGLOSSARY:\n'
          for (const [term, definition] of Object.entries(pc.glossary)) {
            projectConfigSection += `- ${term} → ${definition}\n`
          }
        }
        if (pc?.translationPrompt) {
          projectConfigSection += `\nTRANSLATION STYLE: ${pc.translationPrompt}\n`
        }
        if (pc?.examples && pc.examples.length > 0) {
          projectConfigSection += '\nEXAMPLES:\n'
          for (const ex of pc.examples) {
            const pairs = Object.entries(ex)
              .filter(([k]) => k !== 'key' && k !== 'note')
              .map(([locale, val]) => `${locale}: "${val}"`)
              .join(', ')
            projectConfigSection += `- ${ex.key}: ${pairs}${ex.note ? ` (${ex.note})` : ''}\n`
          }
        }
      } catch {
        // Config detection failed — still provide the prompt without project context
      }

      const layerHint = layer ? `Target layer: ${layer}` : 'Determine the target layer using the layer rules below, or ask the user.'
      const nsHint = namespace ? `Feature namespace: ${namespace}` : 'Determine the key namespace based on the feature.'

      const promptText = `You are adding i18n translations for a new feature.
${layerHint}
${nsHint}
${projectConfigSection}
Follow these steps:

1. Call \`detect_i18n_config\` to understand the project setup (locales, layers, default locale).
2. Call \`search_translations\` to check for existing similar keys — avoid duplicates.
3. Call \`add_translations\` to add keys for ALL locales in a single call.
   - Provide translations for every locale defined in the project.
   - Follow the glossary and style examples if provided above.
   - Preserve all {placeholders} and @:linked.references.
4. If you only provided translations for some locales, call \`translate_missing\` to fill in the rest.
5. Summarize what was added.`

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: promptText },
          },
        ],
      }
    },
  )

  server.registerPrompt(
    'fix-missing-translations',
    {
      title: 'Fix Missing Translations',
      description: 'Find and fix all missing translations across the project.',
      argsSchema: {
        layer: z.string().optional().describe('Specific layer to fix. If omitted, fixes all layers.'),
        projectDir: z.string().optional().describe('Absolute path to the Nuxt project root. Defaults to server cwd.'),
      },
    },
    async ({ layer, projectDir }) => {
      const dir = projectDir ?? process.cwd()
      let projectConfigSection = ''

      try {
        const config = await detectI18nConfig(dir)
        const pc = config.projectConfig

        if (pc?.translationPrompt) {
          projectConfigSection += `\nTRANSLATION STYLE: ${pc.translationPrompt}\n`
        }
        if (pc?.glossary && Object.keys(pc.glossary).length > 0) {
          projectConfigSection += '\nGLOSSARY:\n'
          for (const [term, definition] of Object.entries(pc.glossary)) {
            projectConfigSection += `- ${term} → ${definition}\n`
          }
        }
      } catch {
        // Config detection failed — still provide the prompt without project context
      }

      const layerHint = layer ? `Focus on layer: ${layer}` : 'Check all layers.'

      const promptText = `Find and fix all missing translations in the project.
${layerHint}
${projectConfigSection}
Follow these steps:

1. Call \`detect_i18n_config\` to load the project config and understand the locale setup.
2. Call \`get_missing_translations\` to find all gaps across ${layer ? `the "${layer}" layer` : 'all layers'}.
3. For each locale with missing keys, call \`translate_missing\` to auto-fill gaps using the reference locale.
   - If auto-translation is not available, translate the keys yourself using the glossary and style guidelines above, then call \`add_translations\`.
4. Report a summary of what was translated, organized by layer and locale.`

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: promptText },
          },
        ],
      }
    },
  )

  return server
}
