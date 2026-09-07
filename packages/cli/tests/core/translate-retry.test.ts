import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestWithRetry } from '../../src/core/translate/retry.js'
import { extractJsonFromResponse } from '../../src/core/translate/json-salvage.js'
import type { TranslateRunState } from '../../src/core/translate/retry.js'
import type { TranslateFn, TranslateRequest } from '../../src/core/types.js'
import { TranslateProviderError } from '../../src/llm/providers.js'
import { ToolError } from '../../src/utils/errors.js'

/**
 * Unit contract of the request loop shared by translate_missing and
 * translate_key. The seam tests cover it end to end; these pin the outcome
 * mapping and the two fail-fast cases without waiting out the real backoff.
 */

const req: TranslateRequest = { systemPrompt: 'sys', userMessage: 'user', maxTokens: 16384 }

/** The parser translate_missing uses, so salvage behaves as it does in a run. */
const parseBatchResponse = (text: string, truncated: boolean) => extractJsonFromResponse(text, { truncated })

/** Drive a run to completion with the backoff timers fast-forwarded. */
async function runWithFakeTimers<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const pending = start()
  await vi.runAllTimersAsync()
  return pending
}

afterEach(() => {
  vi.useRealTimers()
})

describe('requestWithRetry', () => {
  it('returns the parsed value of a first successful attempt', async () => {
    const translateFn: TranslateFn = async () => ({ text: '{"greeting":"Hi"}', model: 'fake-model' })

    const outcome = await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: text => JSON.parse(text) as Record<string, string>,
    })

    expect(outcome).toEqual({ status: 'ok', value: { greeting: 'Hi' }, model: 'fake-model' })
  })

  it('retries once after a provider error and reports the retry result', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      if (calls === 1) throw new TranslateProviderError('Rate limit exceeded', 'rate-limit', 429)
      return { text: '"ok"', model: 'fake-model' }
    }

    const outcome = await runWithFakeTimers(() => requestWithRetry(translateFn, req, {
      label: 'en',
      parse: text => JSON.parse(text) as string,
    }))

    expect(calls).toBe(2)
    expect(outcome).toEqual({ status: 'ok', value: 'ok', model: 'fake-model' })
  })

  it('gives up after the retry and keeps the last observed model', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      return { text: 'not json', model: 'fake-model' }
    }

    const outcome = await runWithFakeTimers(() => requestWithRetry(translateFn, req, {
      label: 'en',
      parse: text => JSON.parse(text) as string,
    }))

    expect(calls).toBe(2)
    expect(outcome).toEqual({ status: 'failed', model: 'fake-model' })
  })

  it('treats an empty response as a retryable provider error', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      return { text: '   ', model: 'fake-model' }
    }

    const outcome = await runWithFakeTimers(() => requestWithRetry(translateFn, req, {
      label: 'en',
      parse: () => 'never',
    }))

    expect(calls).toBe(2)
    expect(outcome.status).toBe('failed')
  })

  it('does not retry a truncated response that carried nothing usable', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      return { text: '{"greeting": "Hel', model: 'fake-model', truncated: true }
    }

    const outcome = await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: parseBatchResponse,
    })

    expect(calls).toBe(1)
    expect(outcome).toEqual({ status: 'truncated', model: 'fake-model' })
  })

  it('salvages the pairs a truncated response did carry instead of losing the batch', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      return { text: '{"a":"x","b":"y","c":"z', model: 'fake-model', truncated: true }
    }

    const outcome = await requestWithRetry(translateFn, req, {
      label: 'batch 1 in en',
      parse: parseBatchResponse,
    })

    expect(calls).toBe(1)
    expect(outcome).toEqual({ status: 'partial', value: { a: 'x', b: 'y' }, model: 'fake-model' })
  })

  it('tells the parser the response was cut off so it can distrust the tail', async () => {
    const seen: boolean[] = []
    const translateFn: TranslateFn = async () => ({ text: '{"a":"x"}', model: 'fake-model', truncated: true })

    await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: (text, truncated) => {
        seen.push(truncated)
        return JSON.parse(text) as Record<string, string>
      },
    })

    expect(seen).toEqual([true])
  })

  it('reports a truncated response that parsed to nothing as truncated, not partial', async () => {
    const translateFn: TranslateFn = async () => ({ text: '{"a":"x"}', model: 'fake-model', truncated: true })

    const outcome = await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: () => ({}),
    })

    expect(outcome).toEqual({ status: 'truncated', model: 'fake-model' })
  })

  it('does not retry an auth failure and aborts the run', async () => {
    let calls = 0
    const runState: TranslateRunState = { aborted: false }
    const translateFn: TranslateFn = async () => {
      calls++
      throw new TranslateProviderError('Incorrect API key provided', 'auth')
    }

    const error = await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: () => 'never',
      runState,
    }).then(() => null, (e: unknown) => e)

    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe('PROVIDER_AUTH_ERROR')
    expect((error as ToolError).message).toContain('Incorrect API key provided')
    expect(runState.aborted).toBe(true)
  })

  it('issues no request once a sibling aborted the run', async () => {
    let calls = 0
    const translateFn: TranslateFn = async () => {
      calls++
      return { text: '"ok"', model: 'fake-model' }
    }

    const outcome = await requestWithRetry(translateFn, req, {
      label: 'en',
      parse: () => 'never',
      runState: { aborted: true },
    })

    expect(calls).toBe(0)
    expect(outcome).toEqual({ status: 'failed', model: undefined })
  })
})
