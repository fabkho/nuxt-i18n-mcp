import { describe, it, expect } from 'vitest'
import { detectIndentation } from '../../src/io/json-reader.js'

describe('detectIndentation', () => {
  it('detects tab indentation', () => {
    const content = '{\n\t"key": "value"\n}'
    expect(detectIndentation(content)).toBe('\t')
  })

  it('detects 2-space indentation', () => {
    const content = '{\n  "key": "value"\n}'
    expect(detectIndentation(content)).toBe('  ')
  })

  it('detects 4-space indentation', () => {
    const content = '{\n    "key": "value"\n}'
    expect(detectIndentation(content)).toBe('    ')
  })

  it('detects 2-space from nested content', () => {
    const content = '{\n  "a": {\n    "b": "value"\n  }\n}'
    expect(detectIndentation(content)).toBe('  ')
  })

  it('detects 4-space from nested content', () => {
    const content = '{\n    "a": {\n        "b": "value"\n    }\n}'
    expect(detectIndentation(content)).toBe('    ')
  })

  it('defaults to tab for minified JSON', () => {
    const content = '{"key":"value"}'
    expect(detectIndentation(content)).toBe('\t')
  })

  it('defaults to tab for empty content', () => {
    expect(detectIndentation('')).toBe('\t')
    expect(detectIndentation('{}')).toBe('\t')
  })

  it('detects tabs even with mixed content', () => {
    const content = '{\n\t"a": {\n\t\t"b": "value"\n\t}\n}'
    expect(detectIndentation(content)).toBe('\t')
  })
})
