import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeLocaleFile, mutateLocaleFile, writeReportFile } from '../../src/io/json-writer.js'
import { setNestedValue } from '../../src/io/key-operations.js'
import { validateReportPath } from '../../src/server.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'i18n-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('writeLocaleFile', () => {
  it('writes valid JSON with tab indentation by default', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { hello: 'world' })

    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('{\n\t"hello": "world"\n}\n')
  })

  it('writes with custom indentation', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { a: 1 }, { indent: '  ' })

    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('{\n  "a": 1\n}\n')
  })

  it('sorts keys alphabetically by default', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { c: 3, a: 1, b: 2 })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(Object.keys(parsed)).toEqual(['a', 'b', 'c'])
  })

  it('sorts nested keys', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { z: { b: 1, a: 2 }, a: 3 })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(Object.keys(parsed)).toEqual(['a', 'z'])
    expect(Object.keys(parsed.z)).toEqual(['a', 'b'])
  })

  it('can skip sorting', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { c: 3, a: 1 }, { sortKeys: false })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(Object.keys(parsed)).toEqual(['c', 'a'])
  })

  it('adds trailing newline by default', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { a: 1 })

    const content = await readFile(filePath, 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('can skip trailing newline', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeLocaleFile(filePath, { a: 1 }, { trailingNewline: false })

    const content = await readFile(filePath, 'utf-8')
    expect(content.endsWith('\n')).toBe(false)
  })

  it('creates parent directories if needed', async () => {
    const filePath = join(tempDir, 'sub', 'dir', 'test.json')
    await writeLocaleFile(filePath, { a: 1 })

    const content = await readFile(filePath, 'utf-8')
    expect(JSON.parse(content)).toEqual({ a: 1 })
  })

  it('overwrites existing file', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeFile(filePath, '{"old": true}')
    await writeLocaleFile(filePath, { new: true })

    const content = await readFile(filePath, 'utf-8')
    expect(JSON.parse(content)).toEqual({ new: true })
  })
})

describe('mutateLocaleFile', () => {
  it('reads, mutates, and writes back', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeFile(filePath, '{\n\t"a": 1\n}\n')

    await mutateLocaleFile(filePath, (data) => {
      data.b = 2
    })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed).toEqual({ a: 1, b: 2 })
  })

  it('preserves tab indentation from original file', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeFile(filePath, '{\n\t"a": 1\n}\n')

    await mutateLocaleFile(filePath, (data) => {
      data.b = 2
    })

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('\t"a"')
  })

  it('preserves space indentation from original file', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeFile(filePath, '{\n  "a": 1\n}\n')

    await mutateLocaleFile(filePath, (data) => {
      data.b = 2
    })

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('  "a"')
    expect(content).not.toContain('\t')
  })

  it('works with nested mutation via setNestedValue', async () => {
    const filePath = join(tempDir, 'test.json')
    await writeFile(filePath, '{\n\t"common": {\n\t\t"actions": {\n\t\t\t"save": "Save"\n\t\t}\n\t}\n}\n')

    await mutateLocaleFile(filePath, (data) => {
      setNestedValue(data, 'common.actions.delete', 'Delete')
    })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed.common.actions.delete).toBe('Delete')
    expect(parsed.common.actions.save).toBe('Save')
  })
})

describe('writeReportFile', () => {
  it('writes JSON with metadata fields', async () => {
    const filePath = join(tempDir, 'report.json')
    await writeReportFile(filePath, { summary: { total: 5 }, details: ['a', 'b'] }, {
      tool: 'get_missing_translations',
      args: { layer: 'app' },
    })

    const content = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed.tool).toBe('get_missing_translations')
    expect(parsed.args).toEqual({ layer: 'app' })
    expect(parsed.generatedAt).toBeDefined()
    expect(new Date(parsed.generatedAt).getTime()).not.toBeNaN()
    expect(parsed.summary).toEqual({ total: 5 })
    expect(parsed.details).toEqual(['a', 'b'])
  })

  it('ends with trailing newline', async () => {
    const filePath = join(tempDir, 'report.json')
    await writeReportFile(filePath, { summary: {} }, { tool: 'test', args: {} })

    const content = await readFile(filePath, 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('creates parent directories', async () => {
    const filePath = join(tempDir, 'deep', 'nested', 'report.json')
    await writeReportFile(filePath, { summary: {} }, { tool: 'test', args: {} })

    const content = await readFile(filePath, 'utf-8')
    expect(JSON.parse(content).tool).toBe('test')
  })

  it('overwrites existing file', async () => {
    const filePath = join(tempDir, 'report.json')
    await writeFile(filePath, '{"old": true}')
    await writeReportFile(filePath, { summary: { v: 2 } }, { tool: 'test', args: {} })

    const parsed = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(parsed.old).toBeUndefined()
    expect(parsed.summary).toEqual({ v: 2 })
  })

  it('uses 2-space indentation', async () => {
    const filePath = join(tempDir, 'report.json')
    await writeReportFile(filePath, { summary: {} }, { tool: 'test', args: {} })

    const content = await readFile(filePath, 'utf-8')
    expect(content).toContain('  "tool"')
  })

  it('places metadata before output fields', async () => {
    const filePath = join(tempDir, 'report.json')
    await writeReportFile(filePath, { orphanKeys: [], summary: {} }, { tool: 'find_orphan_keys', args: {} })

    const content = await readFile(filePath, 'utf-8')
    const keys = Object.keys(JSON.parse(content))
    expect(keys[0]).toBe('generatedAt')
    expect(keys[1]).toBe('tool')
    expect(keys[2]).toBe('args')
  })
})

describe('validateReportPath', () => {
  it('accepts path inside project directory', () => {
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, '.i18n-reports/report.json')
    expect(() => validateReportPath(baseDir, absPath)).not.toThrow()
  })

  it('accepts path in a subdirectory', () => {
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, 'reports/deep/nested/report.json')
    expect(() => validateReportPath(baseDir, absPath)).not.toThrow()
  })

  it('rejects path traversal with ../', () => {
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, '../../etc/passwd')
    expect(() => validateReportPath(baseDir, absPath)).toThrow('resolves outside the project directory')
  })

  it('rejects path that escapes via ..', () => {
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, '../other-project/file.json')
    expect(() => validateReportPath(baseDir, absPath)).toThrow('resolves outside the project directory')
  })

  it('throws ToolError with INVALID_REPORT_PATH code', async () => {
    const { ToolError } = await import('../../src/utils/errors.js')
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, '../../outside/file.json')
    try {
      validateReportPath(baseDir, absPath)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError)
      expect((error as InstanceType<typeof ToolError>).code).toBe('INVALID_REPORT_PATH')
    }
  })

  it('accepts path at project root (edge case)', () => {
    const baseDir = '/projects/my-app'
    const absPath = resolve(baseDir, 'report.json')
    expect(() => validateReportPath(baseDir, absPath)).not.toThrow()
  })
})
