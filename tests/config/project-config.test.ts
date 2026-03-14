import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { loadProjectConfig } from '../../src/config/project-config.js'

const playgroundDir = resolve(import.meta.dirname, '../../playground')
const tmpDir = resolve(import.meta.dirname, '../../.tmp-test')

describe('loadProjectConfig', () => {
  // Test 1: loads config from playground (we just created the file above)
  it('loads .i18n-mcp.json from playground', async () => {
    const config = await loadProjectConfig(playgroundDir)
    expect(config).not.toBeNull()
    expect(config!.context).toContain('playground')
    expect(config!.layerRules).toHaveLength(2)
    expect(config!.glossary).toBeDefined()
    expect(config!.glossary!['Buchung']).toContain('Booking')
    expect(config!.translationPrompt).toBeDefined()
    expect(config!.localeNotes).toBeDefined()
    expect(config!.examples).toHaveLength(1)
  })

  // Test 2: returns null when no config file exists
  it('returns null when .i18n-mcp.json does not exist', async () => {
    const config = await loadProjectConfig('/tmp')
    expect(config).toBeNull()
  })

  // Test 3: handles minimal config (empty object)
  it('handles minimal config (empty object)', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, '{}', 'utf-8')
      const config = await loadProjectConfig(tmpDir)
      expect(config).not.toBeNull()
      expect(config!.context).toBeUndefined()
      expect(config!.layerRules).toBeUndefined()
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })

  // Test 4: throws on invalid JSON
  it('throws on invalid JSON', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, 'not valid json {{{', 'utf-8')
      await expect(loadProjectConfig(tmpDir)).rejects.toThrow()
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })

  // Test 5: throws when root is not an object (e.g., array)
  it('throws when config root is not an object', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, '[]', 'utf-8')
      await expect(loadProjectConfig(tmpDir)).rejects.toThrow()
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })

  // Test 6: throws when context is not a string
  it('throws when context is not a string', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, JSON.stringify({ context: 123 }), 'utf-8')
      await expect(loadProjectConfig(tmpDir)).rejects.toThrow()
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })

  // Test 7: throws when layerRules items are malformed
  it('throws when layerRules items are missing required fields', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, JSON.stringify({ layerRules: [{ layer: 'root' }] }), 'utf-8')
      await expect(loadProjectConfig(tmpDir)).rejects.toThrow()
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })

  // Test 8: config with only some fields is valid
  it('accepts config with only some fields', async () => {
    await mkdir(tmpDir, { recursive: true })
    const configPath = resolve(tmpDir, '.i18n-mcp.json')
    try {
      await writeFile(configPath, JSON.stringify({ glossary: { hello: 'world' } }), 'utf-8')
      const config = await loadProjectConfig(tmpDir)
      expect(config).not.toBeNull()
      expect(config!.glossary).toEqual({ hello: 'world' })
    } finally {
      if (existsSync(configPath)) await unlink(configPath)
    }
  })
})
