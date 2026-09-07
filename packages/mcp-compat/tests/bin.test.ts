/**
 * The alias has one job: `the-i18n-mcp` must start the same server that
 * `@the-i18n-kit/mcp` does. Spawns bin.js over real stdio and checks the
 * handshake names the real server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const bin = fileURLToPath(new URL('../bin.js', import.meta.url))
const realEntry = fileURLToPath(new URL('../../mcp/dist/index.js', import.meta.url))

let projectDir: string

beforeAll(async () => {
  if (!existsSync(realEntry)) {
    throw new Error('packages/mcp/dist/index.js missing — run `pnpm --filter @the-i18n-kit/mcp build` first')
  }
  projectDir = await mkdtemp(join(tmpdir(), 'i18n-mcp-compat-'))
  const localesDir = join(projectDir, 'i18n', 'locales')
  await mkdir(localesDir, { recursive: true })
  await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
    localeDirs: [{ path: 'i18n/locales', layer: 'root' }],
    defaultLocale: 'de',
    locales: ['de', 'en'],
  }))
  await writeFile(join(localesDir, 'de.json'), JSON.stringify({ greeting: 'Hallo' }))
  await writeFile(join(localesDir, 'en.json'), '{}\n')
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('the-i18n-mcp alias', () => {
  it('starts @the-i18n-kit/mcp', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const client = new Client({ name: 'compat', version: '0.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { ...env, I18N_PROJECT_DIR: projectDir },
    }))
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'the-i18n-mcp' })
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('discover')
    } finally {
      await client.close()
    }
  })
})
