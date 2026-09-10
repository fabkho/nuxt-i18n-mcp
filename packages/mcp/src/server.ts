import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import type { CacheHint } from '@modelcontextprotocol/server'
import { descriptors, toErrorMessage } from '@the-i18n-kit/cli'
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
  // Per connection, not per process: the scope adopts the roots of the client
  // it is serving, and two connections may be served by two different hosts.
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

  adoptClientRoots(server, scope)

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

/**
 * Let the client's roots stand in for I18N_PROJECT_DIR, so a host that already
 * knows where the user is working needs no environment variable.
 *
 * `roots/list` is a server→client request, a channel only the 2025 era has
 * (SEP-2577 removed it): a 2026-07-28 client declares no roots capability, the
 * gate below holds, and such a connection stays on I18N_PROJECT_DIR or
 * unconfined.
 *
 * Follow-up: `notifications/roots/list_changed` is not subscribed to. Acting on
 * it means swapping the default directory and the confinement boundary out from
 * under in-flight calls and re-deciding which project a cached config belongs
 * to — more than a notification handler, so a host that moves its workspace
 * mid-session keeps the root the connection started with.
 */
function adoptClientRoots(server: McpServer, scope: ProjectScope): void {
  const connection = server.server

  scope.offerClientRoots(async () => {
    // The declared capability first: listRoots against a client that never
    // offered roots is a protocol error rather than an empty answer.
    if (connection.getClientCapabilities()?.roots === undefined) return []

    try {
      const { roots } = await connection.listRoots()
      // A non-file root names something this server cannot open.
      return roots.filter(root => root.uri.startsWith('file://')).map(root => fileURLToPath(root.uri))
    }
    catch (error) {
      process.stderr.write(`[the-i18n-mcp] Could not read the client's roots: ${toErrorMessage(error)}\n`)
      return []
    }
  })
}
