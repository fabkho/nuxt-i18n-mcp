#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { log } from './utils/logger.js'

async function main() {
  log.info('Starting nuxt-i18n-mcp server...')

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  log.info('nuxt-i18n-mcp server running on stdio')
}

main().catch((error) => {
  log.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
