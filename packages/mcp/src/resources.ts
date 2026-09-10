/**
 * The locale-file resource.
 *
 * Resources resolve their own config (cached after first detection) — no prior
 * discover call required. Cross-call ordering dependencies are incompatible
 * with the stateless request/response model of MCP 2026-07-28.
 */

import { ResourceTemplate } from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  detectI18nConfig,
  findLocaleImpl,
  getCachedConfig,
  readLocaleData,
} from '@the-i18n-kit/cli'
import type { ProjectScope } from './scope.js'

export function registerResources(server: McpServer, scope: ProjectScope): void {
  server.registerResource(
    'locale-file',
    new ResourceTemplate('i18n:///{layer}/{locale}', {
      list: async () => {
        const config = getCachedConfig() ?? await detectI18nConfig(scope.projectDirFor(undefined)).catch(() => null)
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
              uri: `i18n:///${localeDir.layer}/${locale.code}`,
              name: `${localeDir.layer}/${locale.code}`,
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
    async (uri, { layer, locale }) => {
      const config = getCachedConfig() ?? await detectI18nConfig(scope.projectDirFor(undefined))
      const localeDef = findLocaleImpl(config, locale as string)
      if (!localeDef) {
        throw new Error(`Locale not found: ${locale}`)
      }
      const data = await readLocaleData(config, layer as string, localeDef)
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
}
