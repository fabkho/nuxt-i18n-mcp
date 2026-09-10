/**
 * The locale-file resource.
 *
 * Resources resolve their own config (cached after first detection) — no prior
 * discover call required. Cross-call ordering dependencies are incompatible
 * with the stateless request/response model of MCP 2026-07-28.
 *
 * The URI names a layer and a locale, never a project, so a resource is always
 * the server's own project directory. Detection is therefore asked for that
 * directory by name: the process-wide "last config resolved" belongs to
 * whichever directory a tool was last called with, and in a monorepo that is
 * routinely another app of the same repository.
 */

import { ResourceTemplate } from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  detectI18nConfig,
  findLocaleImpl,
  readLocaleData,
} from '@the-i18n-kit/cli'
import type { ProjectScope } from './scope.js'

export function registerResources(server: McpServer, scope: ProjectScope): void {
  server.registerResource(
    'locale-file',
    new ResourceTemplate('i18n:///{layer}/{locale}', {
      list: async () => {
        const config = await detectI18nConfig(await scope.projectDirFor(undefined)).catch(() => null)
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
      const config = await detectI18nConfig(await scope.projectDirFor(undefined))
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
