import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { TranslateFn } from '../../src/core/types.js'
import { parseBatch, fakeTranslator } from '../fixtures/translate-harness.js'
import { translateMissing, translateKey } from '../../src/core/operations.js'
import { clearConfigCache } from '../../src/config/detector.js'
import { TranslateProviderError } from '../../src/llm/providers.js'
import { ToolError } from '../../src/utils/errors.js'

/**
 * Seam tests: drive the real translateMissing pipeline end to end with fake
 * translate functions against a real temp project (resolved by the generic
 * adapter — no mocks anywhere). Batching, response parsing, placeholder
 * validation, file writes, and result shapes are asserted from observable
 * outputs only.
 */

let projectDir: string
let localesDir: string

const deContent = {
  greeting: 'Hallo {name}',
  actions: {
    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
  },
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'i18n-seam-'))
  localesDir = join(projectDir, 'i18n', 'locales')
  await mkdir(localesDir, { recursive: true })
  await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
    localeDirs: [{ path: 'i18n/locales', layer: 'root' }],
    defaultLocale: 'de',
    locales: ['de', 'en', 'fr'],
  }, null, 2))
  await writeFile(join(localesDir, 'de.json'), JSON.stringify(deContent, null, 2))
  await writeFile(join(localesDir, 'en.json'), '{}\n')
  await writeFile(join(localesDir, 'fr.json'), '{}\n')
  clearConfigCache()
})

afterEach(async () => {
  await chmod(localesDir, 0o755).catch(() => {})
  await rm(projectDir, { recursive: true, force: true })
  clearConfigCache()
})

async function readLocale(code: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(localesDir, `${code}.json`), 'utf-8')) as Record<string, unknown>
}

describe('translateMissing through the translate seam', () => {
  it('translates missing keys and writes them to the target locale files', async () => {
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
    })

    expect(result.summary.totalTranslated).toBe(8) // 4 keys × en + fr
    expect(result.summary.totalFailed).toBe(0)
    expect(result.summary.mode).toBe('provider')
    expect(result.results.en).toMatchObject({
      mode: 'provider',
      missing: 4,
      model: 'fake-model',
      failed: [],
      skipped: [],
    })
    expect(result.results.en.translated).toHaveLength(4)

    const en = await readLocale('en')
    expect(en).toMatchObject({
      greeting: '[t] Hallo {name}',
      actions: { save: '[t] Speichern', cancel: '[t] Abbrechen', delete: '[t] Löschen' },
    })
    const fr = await readLocale('fr')
    expect(fr).toMatchObject({ greeting: '[t] Hallo {name}' })
  })

  it('parses responses wrapped in markdown code fences', async () => {
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      translateFn: fakeTranslator((_k, v) => `[t] ${v}`, json => '```json\n' + json + '\n```'),
    })

    expect(result.results.en.translated).toHaveLength(4)
    expect((await readLocale('en')).greeting).toBe('[t] Hallo {name}')
  })

  it('rejects translations with placeholder mismatches and does not write them', async () => {
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      translateFn: fakeTranslator((k, v) =>
        k === 'greeting' ? 'Hello {nom}' : `[t] ${v}`),
    })

    expect(result.results.en.failed).toEqual([{ key: 'greeting', reason: 'placeholder-mismatch' }])
    expect(result.results.en.translated).toHaveLength(3)
    expect(result.results.en.placeholderValidation?.ok).toBe(false)

    const en = await readLocale('en')
    expect(en.greeting).toBeUndefined()
    expect((en.actions as Record<string, string>).save).toBe('[t] Speichern')
  })

  it('splits keys into batches of batchSize', async () => {
    let calls = 0
    const counting: TranslateFn = async (req) => {
      calls++
      const batch = parseBatch(req.userMessage)
      expect(Object.keys(batch).length).toBeLessThanOrEqual(2)
      return {
        // keep source values so placeholder validation passes
        text: JSON.stringify(Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, `[t] ${v}`]))),
        model: 'fake-model',
      }
    }

    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      batchSize: 2,
      translateFn: counting,
    })

    expect(calls).toBe(2) // 4 keys / batchSize 2
    expect(result.results.en.batches).toBe(2)
    expect(result.results.en.translated).toHaveLength(4)
  })

  // generous timeout: the production retry waits 4s before the second attempt
  it('fails the whole batch when the backend returns unusable output twice', { timeout: 15_000 }, async () => {
    let calls = 0
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      translateFn: async () => {
        calls++
        return { text: 'sorry, no JSON here', model: 'fake-model' }
      },
    })

    expect(calls).toBe(2) // initial attempt + one retry
    expect(result.results.en.translated).toEqual([])
    expect(result.results.en.failed).toHaveLength(4)
    expect(result.summary.totalFailed).toBe(4)
    expect(await readLocale('en')).toEqual({})
  })

  it('accounts for keys omitted by the backend as failed', async () => {
    // The backend drops one key from its response — it must land in failed
    // with an explicit reason so totals always reconcile.
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      translateFn: async ({ userMessage }) => {
        const batch = parseBatch(userMessage)
        delete batch.greeting
        return {
          text: JSON.stringify(Object.fromEntries(Object.keys(batch).map(k => [k, `x-${k}`]))),
          model: 'fake-model',
        }
      },
    })

    expect(result.results.en.translated).toHaveLength(3)
    expect(result.results.en.failed).toEqual([{ key: 'greeting', reason: 'omitted-by-model' }])
    expect(result.results.en.missing).toBe(4) // translated + failed reconcile
    expect((await readLocale('en')).greeting).toBeUndefined()
  })

  it.skipIf(process.getuid?.() === 0)('reports writeError when the locale file cannot be written', async () => {
    await chmod(localesDir, 0o555)

    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
    })

    expect(result.results.en.writeError).toBeDefined()
    expect(result.results.en.translated).toEqual([])
    expect(result.results.en.failed).toHaveLength(4)
  })

  describe('plural variant validation', () => {
    beforeEach(async () => {
      // Replace the source locale with vue-i18n pipe plurals (and one value
      // with a bare pipe that must NOT be treated as plural).
      await writeFile(join(localesDir, 'de.json'), JSON.stringify({
        requests: '{count} Anfrage | {count} Anfragen',
        mode: 'Drücke {key} für A|B-Modus',
      }, null, 2))
    })

    it('rejects a plural dropping a placeholder in one variant as placeholder-mismatch', async () => {
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: fakeTranslator((k, v) =>
          // whole-value {count} set still matches — only the singular drops it
          k === 'requests' ? 'One request | {count} requests' : `[t] ${v}`),
      })

      expect(result.results.en.failed).toEqual([{ key: 'requests', reason: 'placeholder-mismatch' }])
      expect(result.results.en.translated).toEqual(['mode'])
      expect((await readLocale('en')).requests).toBeUndefined()
    })

    it('rejects a translation with more variants than the source as plural-mismatch', async () => {
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: fakeTranslator((k, v) =>
          k === 'requests' ? '{count} request | {count} requests | {count} many requests' : `[t] ${v}`),
      })

      expect(result.results.en.failed).toEqual([{ key: 'requests', reason: 'plural-mismatch' }])
      expect(result.results.en.placeholderValidation?.errors).toEqual([
        expect.objectContaining({ key: 'requests', kind: 'plural-count', sourceVariants: 2, targetVariants: 3 }),
      ])
      expect((await readLocale('en')).requests).toBeUndefined()
    })

    it('accepts a valid plural and writes it', async () => {
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: fakeTranslator((k, v) =>
          k === 'requests' ? '{count} request | {count} requests' : `[t] ${v}`),
      })

      expect(result.results.en.failed).toEqual([])
      expect(result.results.en.translated).toEqual(expect.arrayContaining(['requests', 'mode']))
      expect((await readLocale('en')).requests).toBe('{count} request | {count} requests')
    })

    it('does not treat a bare pipe without surrounding spaces as a plural', async () => {
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: fakeTranslator((k, v) =>
          k === 'mode' ? 'Press {key} for A|B mode' : `[t] ${v}`),
      })

      expect(result.results.en.failed).toEqual([])
      expect((await readLocale('en')).mode).toBe('Press {key} for A|B mode')
    })
  })

  describe('classified provider failures', () => {
    it('aborts the whole run on an auth error without retrying', async () => {
      let calls = 0
      const error = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          throw new TranslateProviderError('Incorrect API key provided', 'auth')
        },
      }).then(() => null, (e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe('PROVIDER_AUTH_ERROR')
      expect((error as ToolError).message).toContain('Incorrect API key provided')
      expect(calls).toBe(1) // no retry — auth failures are not transient
      expect(await readLocale('en')).toEqual({})
    })

    it('propagates the auth abort across concurrent locales without writing files', async () => {
      const error = await translateMissing({
        projectDir,
        layer: 'root', // en + fr run in a Promise.all
        translateFn: async () => {
          throw new TranslateProviderError('Incorrect API key provided', 'auth')
        },
      }).then(() => null, (e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe('PROVIDER_AUTH_ERROR')
      expect(await readLocale('en')).toEqual({})
      expect(await readLocale('fr')).toEqual({})
    })

    it('suppresses in-flight sibling writes once the auth abort is observed', async () => {
      // fr fails auth immediately; en's request is still in flight and
      // resolves with valid translations afterwards — but the run is doomed,
      // so en must not write either.
      const error = await translateMissing({
        projectDir,
        layer: 'root', // en + fr run in a Promise.all
        translateFn: async ({ userMessage }) => {
          if (userMessage.includes(' to fr')) {
            throw new TranslateProviderError('Incorrect API key provided', 'auth')
          }
          await new Promise(r => setTimeout(r, 150))
          const batch = parseBatch(userMessage)
          return {
            text: JSON.stringify(Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, `[t] ${v}`]))),
            model: 'fake-model',
          }
        },
      }).then(() => null, (e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe('PROVIDER_AUTH_ERROR')
      expect(await readLocale('en')).toEqual({})
      expect(await readLocale('fr')).toEqual({})
    })

    it('fails batch keys with reason "truncated" when not even a single key fits', async () => {
      let calls = 0
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          return { text: '{"greeting": "Hel', model: 'fake-model', truncated: true }
        },
      })

      // No batch is ever re-issued unchanged — the same budget would truncate
      // again — but it is split: 4 → 2 + 2 → (1 + 1) + (1 + 1).
      expect(calls).toBe(7)
      expect(result.results.en.translated).toEqual([])
      expect(result.results.en.failed).toHaveLength(4)
      expect(result.results.en.failed).toEqual(
        expect.arrayContaining([{ key: 'greeting', reason: 'truncated' }]),
      )
      expect(result.results.en.failed.every((f: { reason: string }) => f.reason === 'truncated')).toBe(true)
      expect(await readLocale('en')).toEqual({})
    })

    /**
     * A batch cut off at the token limit still carries the pairs that arrived.
     * Discarding them costs the whole batch for the sake of its last key, which
     * is what turned a real 30-locale run into "translated 795 and lost 141".
     *
     * The three cases differ only in where the cut lands, and that is exactly
     * what decides how much is provably complete: a pair followed by a top-level
     * comma is witnessed by the model itself, while the last pair before the cut
     * never is — `"Hal` and `"Hallo` close identically once a brace is appended.
     */
    describe('salvage of a batch cut off at the token limit', () => {
      const SCOPE = ['greeting', 'actions.save', 'actions.cancel']

      /** Answer every batch with one fixed, cut-off body. */
      async function truncatedRun(text: string) {
        return translateMissing({
          projectDir,
          layer: 'root',
          targetLocales: ['en'],
          keys: SCOPE,
          translateFn: async () => ({ text, model: 'fake-model', truncated: true }),
        })
      }

      it('keeps every pair a top-level comma proved complete', async () => {
        const result = await truncatedRun(
          '{"greeting":"[t] Hallo {name}","actions.save":"[t] Speichern","actions.cancel":"[t] Abbre',
        )

        expect(result.results.en.translated).toEqual(['greeting', 'actions.save'])
        expect(result.results.en.failed).toEqual([{ key: 'actions.cancel', reason: 'truncated' }])
        expect(await readLocale('en')).toEqual({
          greeting: '[t] Hallo {name}',
          actions: { save: '[t] Speichern' },
        })
      })

      it('drops a value cut mid-string', async () => {
        const result = await truncatedRun('{"greeting":"[t] Hallo {name}","actions.save":"[t] Spei')

        expect(result.results.en.translated).toEqual(['greeting'])
        expect(result.results.en.failed).toEqual([
          { key: 'actions.save', reason: 'truncated' },
          { key: 'actions.cancel', reason: 'truncated' },
        ])
        expect(await readLocale('en')).toEqual({ greeting: '[t] Hallo {name}' })
      })

      it('drops a last pair that closed cleanly but has no comma to witness it', async () => {
        const result = await truncatedRun('{"greeting":"[t] Hallo {name}","actions.save":"[t] Speichern"')

        expect(result.results.en.translated).toEqual(['greeting'])
        expect(result.results.en.failed).toEqual([
          { key: 'actions.save', reason: 'truncated' },
          { key: 'actions.cancel', reason: 'truncated' },
        ])
        expect(await readLocale('en')).toEqual({ greeting: '[t] Hallo {name}' })
      })

      it('keeps missing = translated + failed + skipped for a salvaged batch', async () => {
        const result = await truncatedRun(
          '{"greeting":"[t] Hallo {name}","actions.save":"[t] Speichern","actions.cancel":"[t] Abbre',
        )
        const en = result.results.en

        expect(en.missing).toBe(3)
        expect(en.missing).toBe(en.translated.length + en.failed.length + en.skipped.length)
        expect(result.summary.totalTranslated + result.summary.totalFailed + result.summary.totalSkipped)
          .toBe(en.missing)
      })

      it('does not report a salvaged batch\'s lost keys as omitted by the model', async () => {
        const result = await truncatedRun(
          '{"greeting":"[t] Hallo {name}","actions.save":"[t] Speichern","actions.cancel":"[t] Abbre',
        )

        expect(result.results.en.failed.map((f: { reason: string }) => f.reason))
          .not.toContain('omitted-by-model')
      })
    })

    // generous timeout: the production retry waits 4s before the second attempt
    it('retries after a rate-limit error and succeeds', { timeout: 15_000 }, async () => {
      let calls = 0
      const good = fakeTranslator((_k, v) => `[t] ${v}`)
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async (req) => {
          calls++
          if (calls === 1) throw new TranslateProviderError('Rate limit exceeded', 'rate-limit', 429)
          return good(req)
        },
      })

      expect(calls).toBe(2)
      expect(result.results.en.translated).toHaveLength(4)
      expect(result.results.en.failed).toEqual([])
      expect((await readLocale('en')).greeting).toBe('[t] Hallo {name}')
    })

    // generous timeout: the production retry waits 4s before the second attempt
    it('reports an empty response as a provider error, not JSON-parse noise', { timeout: 15_000 }, async () => {
      let calls = 0
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          return { text: '', model: 'fake-model' }
        },
      })

      expect(calls).toBe(2) // empty responses are retried like other provider errors
      expect(result.results.en.translated).toEqual([])
      expect(result.results.en.failed).toEqual(
        expect.arrayContaining([{ key: 'greeting', reason: 'provider-error' }]),
      )
      expect(result.results.en.failed).toHaveLength(4)
      expect(await readLocale('en')).toEqual({})
    })
  })

  /**
   * A batch is a guess at what fits in one response, and a wrong guess used to
   * cost every key in it. The run answers a cut-off response by asking for
   * less — and stops splitting before the request count runs away.
   */
  describe('reactive split of a batch the provider cut off', () => {
    /** Ten keys, more than any fake below answers in one response. */
    const tenKeys = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`item${i}`, `Hilfetext Nummer ${i}`]),
    )

    /** Cut off before a single pair completed: nothing to salvage. */
    const CUT_BEFORE_FIRST_PAIR = '{"item0":"[t] Hilfetext Numm'

    beforeEach(async () => {
      await writeFile(join(localesDir, 'de.json'), JSON.stringify(tenKeys, null, 2))
      clearConfigCache()
    })

    /** Answer a batch the way a well-behaved provider would. */
    function answer(batch: Record<string, string>) {
      return {
        text: JSON.stringify(Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, `[t] ${v}`]))),
        model: 'fake-model',
      }
    }

    /** A backend that cannot answer more than `limit` keys in one response. */
    function capacityLimited(limit: number): { fn: TranslateFn, callCount: () => number } {
      let calls = 0
      const fn: TranslateFn = async ({ userMessage }) => {
        calls++
        const batch = parseBatch(userMessage)
        if (Object.keys(batch).length > limit) {
          return { text: CUT_BEFORE_FIRST_PAIR, model: 'fake-model', truncated: true }
        }
        return answer(batch)
      }
      return { fn, callCount: () => calls }
    }

    it('halves a truncated batch until it fits and translates every key', async () => {
      const { fn, callCount } = capacityLimited(3)

      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: fn,
      })

      expect(result.results.en.translated).toHaveLength(10)
      expect(result.results.en.failed).toEqual([])
      // 10 → 5 + 5 → (3 + 2) + (3 + 2): three cut-off requests, four answered —
      // a split tree, not one request per key.
      expect(callCount()).toBe(7)
      expect(result.results.en.batches).toBe(7)
      expect((await readLocale('en')).item9).toBe('[t] Hilfetext Nummer 9')
    })

    it('re-asks only for the keys a partial response did not carry', async () => {
      let calls = 0
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async ({ userMessage }) => {
          calls++
          const batch = parseBatch(userMessage)
          const pairs = Object.entries(batch)
          if (pairs.length < 10) return answer(batch)
          // Six pairs, each witnessed by the comma the model wrote after it,
          // then the cut mid-value.
          const carried = pairs.slice(0, 6)
            .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(`[t] ${v}`)}`)
            .join(',')
          return { text: `{${carried},"item6":"[t] Hilfe`, model: 'fake-model', truncated: true }
        },
      })

      expect(calls).toBe(2) // the cut batch, then its four-key remainder
      expect(result.results.en.translated).toHaveLength(10)
      expect(result.results.en.failed).toEqual([])
      expect((await readLocale('en')).item6).toBe('[t] Hilfetext Nummer 6')
    })

    it('gives up as truncated on keys that do not fit even alone, within a bounded request count', async () => {
      let calls = 0
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          return { text: CUT_BEFORE_FIRST_PAIR, model: 'fake-model', truncated: true }
        },
      })
      const en = result.results.en

      expect(en.translated).toEqual([])
      expect(en.failed).toHaveLength(10)
      expect(en.failed.every((f: { reason: string }) => f.reason === 'truncated')).toBe(true)
      // Splitting stops at depth 4, so one planned batch costs at most
      // 2^5 - 1 requests however badly the provider behaves.
      expect(calls).toBe(19)
      expect(calls).toBeLessThanOrEqual(2 ** 5 - 1)
      expect(en.missing).toBe(en.translated.length + en.failed.length + en.skipped.length)
      expect(await readLocale('en')).toEqual({})
    })

    // generous timeout: the production retry waits 4s before the second attempt
    it('does not split a batch that failed for a reason a smaller batch would not fix', { timeout: 15_000 }, async () => {
      let calls = 0
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          throw new TranslateProviderError('Connection reset by peer', 'provider')
        },
      })

      expect(calls).toBe(2) // one attempt plus the retry, and no split tree
      expect(result.results.en.translated).toEqual([])
      expect(result.results.en.failed).toHaveLength(10)
      expect(result.results.en.failed.every((f: { reason: string }) => f.reason === 'provider-error')).toBe(true)
    })

    it('reports progress in keys and still lands on the announced step total', async () => {
      const messages: string[] = []
      let announced = -1
      const { fn } = capacityLimited(3)

      await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['en'],
        batchSize: 4,
        translateFn: fn,
        onProgressTotal: (total) => { announced = total },
        progressFn: async (message) => { messages.push(message) },
      })

      // Batches of 4, 4 and 2; the two full ones are split in half by the
      // backend's capacity — which changes the request count, not the steps.
      expect(messages).toEqual([
        'Starting en: 10 missing keys',
        'en: 2/10 keys',
        'en: 6/10 keys',
        'en: 10/10 keys',
        'Complete en',
      ])
      expect(messages).toHaveLength(announced)
    })
  })

  describe('translateKey classified provider failures', () => {
    it('aborts on an auth error', async () => {
      const error = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        targetLocales: ['en'],
        translateFn: async () => {
          throw new TranslateProviderError('Incorrect API key provided', 'auth')
        },
      }).then(() => null, (e: unknown) => e)

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe('PROVIDER_AUTH_ERROR')
      expect(await readLocale('en')).toEqual({})
    })

    it('fails a locale with reason "truncated" when the response was cut off', async () => {
      const result = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        targetLocales: ['en'],
        translateFn: async () => ({ text: '{"greeting": "Hel', model: 'fake-model', truncated: true }),
      })

      expect(result.translated).toEqual([])
      expect(result.failed).toEqual([{ locale: 'en', reason: 'truncated' }])
      expect(await readLocale('en')).toEqual({})
    })

    // The requested key is complete here — a comma after it proves so — and only
    // the model's own trailing invention was cut.
    it('writes the requested key when only what followed it was cut off', async () => {
      const result = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        targetLocales: ['en'],
        translateFn: async () => ({
          text: '{"greeting":"Hello {name}","note":"trailing chat',
          model: 'fake-model',
          truncated: true,
        }),
      })

      expect(result.translated).toEqual(['en'])
      expect(result.failed).toEqual([])
      expect((await readLocale('en')).greeting).toBe('Hello {name}')
    })

    // generous timeout: the retry waits 4s before the second attempt
    it('retries a rate-limited request once and succeeds', { timeout: 15_000 }, async () => {
      let calls = 0
      const result = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        targetLocales: ['en'],
        translateFn: async () => {
          calls++
          if (calls === 1) {
            throw new TranslateProviderError('Rate limit exceeded', 'rate-limit', 429)
          }
          return { text: JSON.stringify({ greeting: '[t] Hallo {name}' }), model: 'fake-model' }
        },
      })

      expect(calls).toBe(2)
      expect(result.translated).toEqual(['en'])
      expect(result.failed).toEqual([])
      expect((await readLocale('en')).greeting).toBe('[t] Hallo {name}')
    })
  })

  describe('protectedLocales', () => {
    async function writeConfig(protectedLocales: string[]): Promise<void> {
      await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
        localeDirs: [{ path: 'i18n/locales', layer: 'root' }],
        defaultLocale: 'de',
        locales: ['de', 'en', 'fr'],
        protectedLocales,
      }, null, 2))
      clearConfigCache()
    }

    /** Run translateMissing with default targets and a well-behaved backend. */
    async function runDefaultTranslate() {
      return translateMissing({
        projectDir,
        layer: 'root',
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })
    }

    it('excludes protected locales from default targets and reports their missing keys as skipped', async () => {
      await writeConfig(['fr'])

      const result = await runDefaultTranslate()

      // Only en was translated — fr was withheld but is still reported.
      expect(result.summary.totalTranslated).toBe(4)
      expect(result.summary.totalSkipped).toBe(4)
      expect(result.summary.targetLocales).toEqual([expect.objectContaining({ code: 'en' })])
      expect(result.results.fr).toMatchObject({
        mode: 'provider',
        missing: 4,
        translated: [],
        failed: [],
      })
      expect(result.results.fr.skipped).toHaveLength(4)
      expect(result.results.fr.skipped).toEqual(
        expect.arrayContaining([{ key: 'greeting', reason: 'protected-locale' }]),
      )

      // The protected locale's file is untouched; the other target was written.
      expect(await readLocale('fr')).toEqual({})
      expect((await readLocale('en')).greeting).toBe('[t] Hallo {name}')
    })

    it('translates a protected locale when it is explicitly named in targetLocales', async () => {
      await writeConfig(['fr'])

      const result = await translateMissing({
        projectDir,
        layer: 'root',
        targetLocales: ['fr'],
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })

      expect(result.results.fr.translated).toHaveLength(4)
      expect(result.results.fr.skipped).toEqual([])
      expect((await readLocale('fr')).greeting).toBe('[t] Hallo {name}')
    })

    it('ignores protectedLocales entries that do not match a known locale', async () => {
      await writeConfig(['xx-nope', 'fr'])

      const result = await runDefaultTranslate()

      // The unknown entry changes nothing; the valid one still protects fr.
      expect(result.summary.totalTranslated).toBe(4)
      expect(result.results.en.translated).toHaveLength(4)
      expect(result.results.fr.skipped).toHaveLength(4)
      expect(await readLocale('fr')).toEqual({})
    })

    it('translateKey skips protected locales in the default target set and overrides on explicit request', async () => {
      await writeConfig(['fr'])

      const defaultRun = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })

      expect(defaultRun.translated).toEqual(['en'])
      expect(defaultRun.skipped).toEqual([{ locale: 'fr', reason: 'protected-locale' }])
      expect(await readLocale('fr')).toEqual({})

      const explicitRun = await translateKey({
        projectDir,
        layer: 'root',
        key: 'greeting',
        sourceLocale: 'de',
        targetLocales: ['fr'],
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })

      expect(explicitRun.translated).toEqual(['fr'])
      expect(explicitRun.skipped).toEqual([])
      expect((await readLocale('fr')).greeting).toBe('[t] Hallo {name}')
    })
  })

  describe('all-layers mode (layer omitted)', () => {
    let shopLocalesDir: string

    const shopDeContent = {
      shop: { checkout: 'Zur Kasse', cart: 'Warenkorb' },
    }

    beforeEach(async () => {
      shopLocalesDir = join(projectDir, 'app-shop', 'i18n', 'locales')
      await mkdir(shopLocalesDir, { recursive: true })
      await writeFile(join(projectDir, '.i18n-mcp.json'), JSON.stringify({
        localeDirs: [
          { path: 'i18n/locales', layer: 'root' },
          { path: 'app-shop/i18n/locales', layer: 'app-shop' },
        ],
        defaultLocale: 'de',
        locales: ['de', 'en', 'fr'],
      }, null, 2))
      await writeFile(join(shopLocalesDir, 'de.json'), JSON.stringify(shopDeContent, null, 2))
      await writeFile(join(shopLocalesDir, 'en.json'), '{}\n')
      await writeFile(join(shopLocalesDir, 'fr.json'), '{}\n')
      clearConfigCache()
    })

    async function readShopLocale(code: string): Promise<Record<string, unknown>> {
      return JSON.parse(await readFile(join(shopLocalesDir, `${code}.json`), 'utf-8')) as Record<string, unknown>
    }

    /** The `missing = translated + wouldTranslate + failed + skipped` invariant. */
    function expectLocaleInvariant(r: {
      missing: number
      translated: string[]
      wouldTranslate?: string[]
      failed: unknown[]
      skipped: unknown[]
    }): void {
      expect(r.missing).toBe(
        r.translated.length + (r.wouldTranslate?.length ?? 0) + r.failed.length + r.skipped.length,
      )
    }

    it('translates every layer, writes per-layer files, and aggregates totals with a byLayer breakdown', async () => {
      const result = await translateMissing({
        projectDir,
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })

      // Cross-layer totals under the existing field names: root has 4 keys,
      // app-shop has 2, each translated into en + fr.
      expect(result.summary.totalTranslated).toBe(12)
      expect(result.summary.totalFailed).toBe(0)
      expect(result.summary.totalSkipped).toBe(0)
      expect(result.summary.mode).toBe('provider')
      expect(result.summary.dryRun).toBe(false)
      expect(result.summary.layers).toEqual(['root', 'app-shop'])
      expect(result.summary.byLayer).toEqual([
        { layer: 'root', totalTranslated: 8, totalFailed: 0, totalSkipped: 0, totalWouldTranslate: 0 },
        { layer: 'app-shop', totalTranslated: 4, totalFailed: 0, totalSkipped: 0, totalWouldTranslate: 0 },
      ])

      // Per-layer sections reuse the single-layer result shape.
      const rootSection = result.layers.root as { results: Record<string, any>, summary: Record<string, unknown> }
      const shopSection = result.layers['app-shop'] as { results: Record<string, any>, summary: Record<string, unknown> }
      expect(rootSection.summary).toMatchObject({ layer: 'root', mode: 'provider', totalTranslated: 8 })
      expect(shopSection.summary).toMatchObject({ layer: 'app-shop', mode: 'provider', totalTranslated: 4 })
      for (const section of [rootSection, shopSection]) {
        for (const localeResult of Object.values(section.results)) {
          expectLocaleInvariant(localeResult)
        }
      }

      // Both physical dirs were filled.
      expect((await readLocale('en')).greeting).toBe('[t] Hallo {name}')
      expect(await readShopLocale('en')).toMatchObject({
        shop: { checkout: '[t] Zur Kasse', cart: '[t] Warenkorb' },
      })
      expect((await readShopLocale('fr') as any).shop.cart).toBe('[t] Warenkorb')
    })

    it('aggregates totalWouldTranslate across layers in dry-run mode without writing', async () => {
      const result = await translateMissing({ projectDir, dryRun: true })

      expect(result.summary.mode).toBe('dry-run')
      expect(result.summary.totalWouldTranslate).toBe(12)
      expect(result.summary.totalTranslated).toBe(0)
      expect(result.summary.byLayer).toEqual([
        { layer: 'root', totalTranslated: 0, totalFailed: 0, totalSkipped: 0, totalWouldTranslate: 8 },
        { layer: 'app-shop', totalTranslated: 0, totalFailed: 0, totalSkipped: 0, totalWouldTranslate: 4 },
      ])
      for (const section of Object.values(result.layers as Record<string, { results: Record<string, any> }>)) {
        for (const localeResult of Object.values(section.results)) {
          expectLocaleInvariant(localeResult)
        }
      }
      expect(await readLocale('en')).toEqual({})
      expect(await readShopLocale('en')).toEqual({})
    })

    it('keeps the single-layer result byte-compatible when --layer is passed', async () => {
      const result = await translateMissing({
        projectDir,
        layer: 'root',
        translateFn: fakeTranslator((_k, v) => `[t] ${v}`),
      })

      // Exactly the pre-all-layers shape: no layers section, no byLayer,
      // no extra summary fields.
      expect(Object.keys(result).sort()).toEqual(['results', 'summary'])
      expect(Object.keys(result.summary).sort()).toEqual([
        'dryRun', 'layer', 'mode', 'referenceLocale', 'targetLocales',
        'totalFailed', 'totalSkipped', 'totalTranslated',
      ])
      expect(result.summary.layer).toBe('root')
      expect(result.summary.totalTranslated).toBe(8)
      expect(await readShopLocale('en')).toEqual({})
    })
  })

  it('returns fallback contexts instead of translating when no backend is provided', async () => {
    const result = await translateMissing({
      projectDir,
      layer: 'root',
      targetLocales: ['en'],
      // no translateFn
    })

    expect(result.summary.mode).toBe('agent')
    expect(result.summary.totalSkipped).toBe(4)
    expect(result.fallbackContexts?.en).toMatchObject({
      keysToTranslate: expect.objectContaining({ greeting: 'Hallo {name}' }),
    })
    expect(result.results.en.mode).toBe('agent')
    expect(result.results.en.skipped).toEqual(
      expect.arrayContaining([{ key: 'greeting', reason: 'no-provider' }]),
    )
    expect(result.results.en.failed).toEqual([])
    expect(await readLocale('en')).toEqual({})
  })
})
