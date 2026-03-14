import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { detectI18nConfig, clearConfigCache, getCachedConfig } from './config/detector.js'
import type { I18nConfig } from './config/types.js'
import { readLocaleFile, readLocaleFileWithMeta } from './io/json-reader.js'
import { writeLocaleFile, mutateLocaleFile } from './io/json-writer.js'
import {
  getNestedValue,
  setNestedValue,
  hasNestedKey,
  getLeafKeys,
} from './io/key-operations.js'
import { log } from './utils/logger.js'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

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
    return config.locales.find(
      l => l.code === localeRef || l.file === localeRef || l.language === localeRef,
    )
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error detecting i18n config: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing locale dirs: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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
                throw new Error(`Locale not found: ${locale}. Available: ${config.locales.map(l => l.code).join(', ')}`)
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting translations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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

        const added: string[] = []
        const skipped: string[] = []
        const filesWritten = new Set<string>()

        // Group translations by locale file
        const byFile = new Map<string, Array<{ key: string; value: string }>>()

        for (const [key, localeValues] of Object.entries(translations)) {
          for (const [localeRef, value] of Object.entries(localeValues)) {
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
              if (hasNestedKey(data, key)) {
                skipped.push(key)
              } else {
                setNestedValue(data, key, value)
                added.push(key)
              }
            }
          })
          filesWritten.add(filePath)
        }

        const summary = {
          added: [...new Set(added)],
          skipped: [...new Set(skipped)],
          filesWritten: filesWritten.size,
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error adding translations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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

        const updated: string[] = []
        const skipped: string[] = []
        const filesWritten = new Set<string>()

        // Group translations by locale file
        const byFile = new Map<string, Array<{ key: string; value: string }>>()

        for (const [key, localeValues] of Object.entries(translations)) {
          for (const [localeRef, value] of Object.entries(localeValues)) {
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
              if (!hasNestedKey(data, key)) {
                skipped.push(key)
              } else {
                setNestedValue(data, key, value)
                updated.push(key)
              }
            }
          })
          filesWritten.add(filePath)
        }

        const summary = {
          updated: [...new Set(updated)],
          skipped: [...new Set(skipped)],
          filesWritten: filesWritten.size,
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating translations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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
          throw new Error(`Reference locale not found: ${refCode}. Available: ${config.locales.map(l => l.code).join(', ')}`)
        }

        // Determine target locales
        const targets = targetLocales
          ? targetLocales.map((code) => {
              const loc = findLocale(config, code)
              if (!loc) {
                throw new Error(`Target locale not found: ${code}. Available: ${config.locales.map(l => l.code).join(', ')}`)
              }
              return loc
            })
          : config.locales.filter(l => l.code !== refLocale.code)

        // Determine layers to scan
        const layersToScan = layer
          ? config.localeDirs.filter(d => d.layer === layer)
          : config.localeDirs.filter(d => !d.aliasOf)

        if (layersToScan.length === 0) {
          throw new Error(layer ? `Layer not found: ${layer}` : 'No locale directories found')
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

          const refKeys = getLeafKeys(refData)
          if (refKeys.length === 0) continue

          for (const target of targets) {
            const targetFilePath = resolveLocaleFilePath(config, localeDir.layer, target.file)
            let targetKeys: string[] = []

            if (targetFilePath) {
              try {
                const targetData = await readLocaleFile(targetFilePath)
                targetKeys = getLeafKeys(targetData)
              } catch {
                // Target file doesn't exist — all ref keys are missing
              }
            }

            const targetKeySet = new Set(targetKeys)
            const missing = refKeys.filter(k => !targetKeySet.has(k))

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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error finding missing translations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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
          throw new Error(layer ? `Layer not found: ${layer}` : 'No locale directories found')
        }

        // Determine locales to search
        const localesToSearch = locale
          ? (() => {
              const found = findLocale(config, locale)
              if (!found) {
                throw new Error(`Locale not found: ${locale}. Available: ${config.locales.map(l => l.code).join(', ')}`)
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error searching translations: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
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

  return server
}
