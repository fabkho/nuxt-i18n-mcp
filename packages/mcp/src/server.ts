import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/server'
import type { CacheHint } from '@modelcontextprotocol/server'
import { descriptors } from '@the-i18n-kit/cli'
import type { TranslateFn } from '@the-i18n-kit/cli'
import { resolveTranslationBackend } from './backend.js'
import type { TranslationBackend } from './backend.js'
import { registerPrompts } from './prompts.js'
import { registerResources } from './resources.js'
import { registerTools } from './tools.js'
import { ProjectScope } from './scope.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

// SEP-2549 cache hints for the cacheable 2026-07-28 results.
const STATIC_SURFACE_CACHE: CacheHint = { ttlMs: 3_600_000, cacheScope: 'private' }

export interface CreateServerOptions {
  /**
   * Test-only seam: inject a TranslateFn directly, bypassing environment
   * resolution. Production callers must leave this unset and configure the
   * backend via I18N_PROVIDER / I18N_MODEL / the provider's API key env.
   */
  translateFn?: TranslateFn
}

/**
 * Create and configure the MCP server.
 *
 * The tools are registered from the operation descriptors the CLI package
 * publishes — the same table its commands are built from — so this file holds
 * only what belongs to a server: the translation backend (resolved once here,
 * see resolveTranslationBackend for the environment contract), the cache hints,
 * the resource, the prompts, and the one result a server decorates with
 * something the project itself cannot know.
 */
export async function createServer(options: CreateServerOptions = {}): Promise<McpServer> {
  // Per connection, not per process: what a scope resolves belongs to the
  // connection it serves, not to a module loaded once.
  const scope = new ProjectScope()

  const backend: TranslationBackend = options.translateFn
    ? { mode: 'provider', translateFn: options.translateFn }
    : await resolveTranslationBackend(scope.startupDir)

  const server = new McpServer(
    {
      name: 'the-i18n-mcp',
      version,
    },
    {
      // 2026-07-28 responses only — legacy-era responses never carry cache
      // fields. Everything is 'private': locale data is project-local.
      cacheHints: {
        // Tool/prompt registrations and the discover advertisement are fixed
        // for the process lifetime.
        'tools/list': STATIC_SURFACE_CACHE,
        'prompts/list': STATIC_SURFACE_CACHE,
        'server/discover': STATIC_SURFACE_CACHE,
        // Resources carry no cache hints: the write tools mutate locale
        // files and clients have no guaranteed invalidation channel, so any
        // TTL would let an agent read stale data right after its own write.
      },
    },
  )

  registerTools(server, descriptors, {
    scope,
    translateFn: backend.translateFn,
    decorate: {
      /**
       * The one part of the discover answer that is the server's own rather
       * than the project's: the active translation mode, which lets operators
       * verify env configuration without triggering a translation. Never
       * includes the API key.
       */
      discover: result => ({
        ...(result as Record<string, unknown>),
        translationMode: backend.mode,
        ...(backend.provider ? { translationProvider: backend.provider } : {}),
        ...(backend.model ? { translationModel: backend.model } : {}),
      }),
    },
  })

  registerResources(server, scope)
  registerPrompts(server, scope)

  return server
}

