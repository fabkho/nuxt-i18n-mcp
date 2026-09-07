import { describe, it, expect, vi, afterEach, type Mock } from 'vitest'
import {
  TranslateProviderError,
  classifyProviderError,
  resolveProviderBaseUrl,
  createTranslateFn,
  thinkingConfigFor,
} from '../../src/llm/providers.js'
import type { LlmProvider } from '../../src/llm/providers.js'
import { redactBaseUrl } from '../../src/commands/_shared.js'

/**
 * Unit tests for the provider error classification mapping. Nothing here does
 * I/O — classifyProviderError only inspects plain error shapes.
 */

function errWithStatus(status: number): Error {
  const error = new Error(`HTTP ${status}`)
  ;(error as Error & { status: number }).status = status
  return error
}

describe('classifyProviderError', () => {
  it('classifies 401 as auth', () => {
    const classified = classifyProviderError(errWithStatus(401))
    expect(classified).toBeInstanceOf(TranslateProviderError)
    expect(classified.kind).toBe('auth')
    expect(classified.status).toBe(401)
    expect(classified.message).toBe('HTTP 401')
  })

  it('classifies 403 as auth', () => {
    expect(classifyProviderError(errWithStatus(403)).kind).toBe('auth')
  })

  it('classifies 429 as rate-limit', () => {
    expect(classifyProviderError(errWithStatus(429)).kind).toBe('rate-limit')
  })

  it('classifies other status codes as provider', () => {
    expect(classifyProviderError(errWithStatus(500)).kind).toBe('provider')
    expect(classifyProviderError(errWithStatus(400)).kind).toBe('provider')
  })

  it('classifies errors without a status as provider', () => {
    const classified = classifyProviderError(new Error('socket hang up'))
    expect(classified.kind).toBe('provider')
    expect(classified.status).toBeUndefined()
    expect(classified.message).toBe('socket hang up')
  })

  it('reads a nested response.status defensively', () => {
    const error = new Error('unauthorized') as Error & { response: { status: number } }
    error.response = { status: 401 }
    expect(classifyProviderError(error).kind).toBe('auth')
  })

  it('prefers a top-level status over response.status', () => {
    const error = new Error('rate limited') as Error & { status: number, response: { status: number } }
    error.status = 429
    error.response = { status: 500 }
    expect(classifyProviderError(error).kind).toBe('rate-limit')
  })

  it('handles non-Error and malformed shapes without throwing', () => {
    expect(classifyProviderError('boom').kind).toBe('provider')
    expect(classifyProviderError('boom').message).toBe('boom')
    expect(classifyProviderError(null).kind).toBe('provider')
    expect(classifyProviderError({ status: 'not-a-number', response: 42 }).kind).toBe('provider')
  })

  it('passes an already-classified error through unchanged', () => {
    const original = new TranslateProviderError('key invalid', 'auth')
    expect(classifyProviderError(original)).toBe(original)
  })
})

/**
 * Base URL resolution is a pure precedence decision over three sources, so it
 * is unit-tested without touching the network or the filesystem.
 */
describe('resolveProviderBaseUrl', () => {
  it('prefers the flag over env and config', () => {
    expect(resolveProviderBaseUrl({
      flag: 'https://flag.example',
      env: 'https://env.example',
      config: 'https://config.example',
    })).toBe('https://flag.example')
  })

  it('falls back to env when no flag is given', () => {
    expect(resolveProviderBaseUrl({
      env: 'https://env.example',
      config: 'https://config.example',
    })).toBe('https://env.example')
  })

  it('falls back to config when neither flag nor env is given', () => {
    expect(resolveProviderBaseUrl({ config: 'https://config.example' })).toBe('https://config.example')
  })

  it('returns undefined when every source is unset', () => {
    expect(resolveProviderBaseUrl({})).toBeUndefined()
  })

  it('treats blank values as unset so an empty override cannot mask a real one', () => {
    expect(resolveProviderBaseUrl({ flag: '', env: '   ', config: 'https://config.example' }))
      .toBe('https://config.example')
    expect(resolveProviderBaseUrl({ flag: '  ' })).toBeUndefined()
  })

  it('trims the resolved value', () => {
    expect(resolveProviderBaseUrl({ flag: '  https://flag.example  ' })).toBe('https://flag.example')
  })
})

describe('redactBaseUrl', () => {
  it('keeps origin and path for a plain URL', () => {
    expect(redactBaseUrl('https://gateway.example/v1')).toBe('https://gateway.example/v1')
  })

  it('removes user-info credentials', () => {
    expect(redactBaseUrl('https://user:secret@gateway.example/v1'))
      .toBe('https://<redacted>@gateway.example/v1')
  })

  it('removes a query string that could carry a key', () => {
    const redacted = redactBaseUrl('https://gateway.example/v1?api-key=secret')
    expect(redacted).not.toContain('secret')
    expect(redacted).toBe('https://gateway.example/v1 (query redacted)')
  })

  it('removes a fragment', () => {
    expect(redactBaseUrl('https://gateway.example/v1#token')).not.toContain('token')
  })

  it('keeps a non-default port, which is diagnostic rather than secret', () => {
    expect(redactBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
  })

  it('never echoes an unparseable value', () => {
    expect(redactBaseUrl('not a url')).toBe('<unparseable base URL>')
  })
})

/**
 * Transport tests. Every provider is a single HTTP call, so a stubbed global
 * fetch is the whole seam: the request the kit sends is asserted from the
 * captured call, and the response it returns from a canned body. No SDK, no
 * network, no per-provider mock.
 */

const REQUEST = { systemPrompt: 'be terse', userMessage: '{"a":"b"}', maxTokens: 16384 }

type FetchMock = Mock<(url: string, init: RequestInit) => Promise<Response>>

/** What the stubbed endpoint answers: a body and status, or a thrown error. */
type Outcome = { body: string, status: number } | Error

function jsonBody(body: unknown, status = 200): Outcome {
  return { body: JSON.stringify(body), status }
}

/**
 * Stub the global fetch. The response is built per call, so a test may drive
 * the same endpoint twice without hitting an already-consumed body.
 */
function stubFetch(outcome: Outcome): FetchMock {
  const mock: FetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    if (outcome instanceof Error) throw outcome
    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Stub fetch with one outcome per call, repeating the last one afterwards. */
function stubFetchSequence(outcomes: Outcome[]): FetchMock {
  let call = 0
  const mock: FetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)]!
    if (outcome instanceof Error) throw outcome
    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Read back the body of one of several requests the provider sent. */
function bodyOfCall(mock: FetchMock, index: number): Record<string, unknown> {
  const [, init] = mock.mock.calls[index]!
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function generationConfigOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.generationConfig as Record<string, unknown>
}

interface CapturedRequest {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Read back the single request the provider sent. */
function captured(mock: FetchMock): CapturedRequest {
  expect(mock).toHaveBeenCalledTimes(1)
  const [url, init] = mock.mock.calls[0]!
  return {
    url: String(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }
}

/** Canned success bodies, one per provider protocol. */
const OK_BODY: Record<LlmProvider, unknown> = {
  openai: {
    model: 'gpt-4o-2024-08-06',
    choices: [{ message: { content: '{"greeting":"Hallo"}' }, finish_reason: 'stop' }],
  },
  anthropic: {
    model: 'claude-3-5-sonnet-20241022',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"greeting":"Hallo"}' }],
  },
  google: {
    modelVersion: 'gemini-2.0-flash-001',
    candidates: [{ content: { parts: [{ text: '{"greeting":"Hallo"}' }] }, finishReason: 'STOP' }],
  },
}

const MODEL: Record<LlmProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet-20241022',
  google: 'gemini-2.0-flash',
}

/** Translate once against an endpoint that answers with `body` and HTTP 200. */
async function translateWith(provider: LlmProvider, body: unknown, baseUrl?: string) {
  const mock = stubFetch(jsonBody(body))
  const translate = await createTranslateFn({
    provider,
    model: MODEL[provider],
    apiKey: 'test-key',
    ...(baseUrl ? { baseUrl } : {}),
  })
  const response = await translate(REQUEST)
  return { mock, response }
}

/** Translate once against a failing endpoint and return the rejection. */
async function translateFailure(provider: LlmProvider, outcome: Outcome): Promise<unknown> {
  stubFetch(outcome)
  const translate = await createTranslateFn({ provider, model: MODEL[provider], apiKey: 'test-key' })
  return translate(REQUEST).catch((error: unknown) => error)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('openai over fetch', () => {
  it('posts the chat completion to the default endpoint', async () => {
    const { mock } = await translateWith('openai', OK_BODY.openai)
    const request = captured(mock)

    expect(request.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      'authorization': 'Bearer test-key',
      'content-type': 'application/json',
    })
    expect(request.body).toEqual({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: '{"a":"b"}' },
      ],
      max_tokens: 16384,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
  })

  it('returns the message content and the model the provider reports', async () => {
    const { response } = await translateWith('openai', OK_BODY.openai)
    expect(response).toEqual({ text: '{"greeting":"Hallo"}', model: 'gpt-4o-2024-08-06' })
  })

  it('falls back to the configured model when the response omits one', async () => {
    const { response } = await translateWith('openai', {
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    })
    expect(response.model).toBe('gpt-4o')
  })

  it('flags a response cut off at the token limit as truncated', async () => {
    const { response } = await translateWith('openai', {
      model: 'gpt-4o',
      choices: [{ message: { content: '{"greeting":"Hal' }, finish_reason: 'length' }],
    })
    expect(response.truncated).toBe(true)
  })

  it('returns empty text rather than throwing when the choice carries none', async () => {
    const { response } = await translateWith('openai', { model: 'gpt-4o', choices: [] })
    expect(response).toEqual({ text: '', model: 'gpt-4o' })
  })

  it('sends to a base URL override, tolerating a trailing slash', async () => {
    const { mock } = await translateWith('openai', OK_BODY.openai, 'http://localhost:11434/v1/')
    expect(captured(mock).url).toBe('http://localhost:11434/v1/chat/completions')
  })
})

describe('anthropic over fetch', () => {
  it('posts the message to the default endpoint with the pinned API version', async () => {
    const { mock } = await translateWith('anthropic', OK_BODY.anthropic)
    const request = captured(mock)

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toEqual({
      model: 'claude-3-5-sonnet-20241022',
      system: 'be terse',
      messages: [{ role: 'user', content: '{"a":"b"}' }],
      max_tokens: 16384,
      temperature: 0,
    })
  })

  it('concatenates the text blocks and ignores the others', async () => {
    const { response } = await translateWith('anthropic', {
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: '{"greeting":' },
        { type: 'text', text: '"Hallo"}' },
      ],
    })
    expect(response).toEqual({ text: '{"greeting":"Hallo"}', model: 'claude-3-5-sonnet-20241022' })
  })

  it('flags stop_reason max_tokens as truncated', async () => {
    const { response } = await translateWith('anthropic', {
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"greeting":"Hal' }],
    })
    expect(response.truncated).toBe(true)
  })

  it('sends to a base URL override', async () => {
    const { mock } = await translateWith('anthropic', OK_BODY.anthropic, 'https://gateway.example')
    expect(captured(mock).url).toBe('https://gateway.example/v1/messages')
  })
})

describe('google over fetch', () => {
  it('posts generateContent to the model-specific path with the key in a header', async () => {
    const { mock } = await translateWith('google', OK_BODY.google)
    const request = captured(mock)

    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    )
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      'x-goog-api-key': 'test-key',
      'content-type': 'application/json',
    })
    // The key travels in a header, never in the query string, so it stays out
    // of proxy logs.
    expect(request.url).not.toContain('test-key')
    expect(request.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: '{"a":"b"}' }] }],
      systemInstruction: { parts: [{ text: 'be terse' }] },
      generationConfig: {
        maxOutputTokens: 16384,
        temperature: 0,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'low' },
      },
    })
  })

  it('joins the candidate parts and reports the resolved model version', async () => {
    const { response } = await translateWith('google', {
      modelVersion: 'gemini-2.0-flash-001',
      candidates: [{ content: { parts: [{ text: '{"greeting":' }, { text: '"Hallo"}' }] } }],
    })
    expect(response).toEqual({ text: '{"greeting":"Hallo"}', model: 'gemini-2.0-flash-001' })
  })

  it('flags finishReason MAX_TOKENS as truncated', async () => {
    const { response } = await translateWith('google', {
      candidates: [{ content: { parts: [{ text: '{"greeting":"Hal' }] }, finishReason: 'MAX_TOKENS' }],
    })
    expect(response.truncated).toBe(true)
  })

  it('returns empty text for a candidate with no parts', async () => {
    const { response } = await translateWith('google', { candidates: [{ content: {} }] })
    expect(response.text).toBe('')
  })

  it('honours a base URL override instead of rejecting it', async () => {
    const { mock, response } = await translateWith('google', OK_BODY.google, 'https://gemini-proxy.example')
    expect(captured(mock).url).toBe(
      'https://gemini-proxy.example/v1beta/models/gemini-2.0-flash:generateContent',
    )
    expect(response.text).toBe('{"greeting":"Hallo"}')
  })

  it('accepts a model written with the models/ prefix without doubling it', async () => {
    const mock = stubFetch(jsonBody(OK_BODY.google))
    const translate = await createTranslateFn({
      provider: 'google',
      model: 'models/gemini-2.0-flash',
      apiKey: 'test-key',
    })
    await translate(REQUEST)
    expect(captured(mock).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    )
  })
})

/**
 * Gemini spends thinking tokens from the same maxOutputTokens budget as the
 * answer, so leaving the default in place is what turns a whole batch into a
 * MAX_TOKENS response with no JSON in it. The two model families take different
 * knobs and reject each other's, which is the whole reason this is a function.
 */
describe('thinkingConfigFor', () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ['gemini-2.5-pro', { thinkingBudget: 128 }],
    ['gemini-2.5-pro-preview-06-05', { thinkingBudget: 128 }],
    ['gemini-2.5-flash', { thinkingBudget: 0 }],
    ['gemini-2.5-flash-lite', { thinkingBudget: 0 }],
    ['gemini-3.5-flash', { thinkingLevel: 'low' }],
    ['gemini-3-pro-preview', { thinkingLevel: 'low' }],
    ['gemini-2.0-flash', { thinkingLevel: 'low' }],
    ['GEMINI-3.5-FLASH', { thinkingLevel: 'low' }],
    ['gpt-4o', undefined],
    ['llama3.1:8b', undefined],
  ]

  for (const [model, expected] of cases) {
    it(`maps ${model} to ${JSON.stringify(expected)}`, () => {
      expect(thinkingConfigFor(model)).toEqual(expected)
    })
  }
})

describe('google thinking configuration', () => {
  async function googleTranslate(model: string, outcomes: Outcome[]) {
    const mock = stubFetchSequence(outcomes)
    const translate = await createTranslateFn({ provider: 'google', model, apiKey: 'test-key' })
    return { mock, translate }
  }

  it('sends the model-appropriate thinking budget for a 2.5 model', async () => {
    const { mock, translate } = await googleTranslate('gemini-2.5-flash', [jsonBody(OK_BODY.google)])
    await translate(REQUEST)

    expect(generationConfigOf(bodyOfCall(mock, 0)).thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('retries once without thinkingConfig when the endpoint rejects the field', async () => {
    const { mock, translate } = await googleTranslate('gemini-3.5-flash', [
      jsonBody({ error: { message: 'thinkingLevel is not supported for this model' } }, 400),
      jsonBody(OK_BODY.google),
    ])

    const response = await translate(REQUEST)

    expect(mock).toHaveBeenCalledTimes(2)
    expect(generationConfigOf(bodyOfCall(mock, 0)).thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(generationConfigOf(bodyOfCall(mock, 1))).not.toHaveProperty('thinkingConfig')
    expect(response.text).toBe('{"greeting":"Hallo"}')
  })

  it('stops sending thinkingConfig for the rest of the process after a rejection', async () => {
    const { mock, translate } = await googleTranslate('gemini-3.5-flash', [
      jsonBody({ error: { message: 'Unknown name "thinkingConfig"' } }, 400),
      jsonBody(OK_BODY.google),
    ])

    await translate(REQUEST)
    await translate(REQUEST)

    expect(mock).toHaveBeenCalledTimes(3)
    expect(generationConfigOf(bodyOfCall(mock, 2))).not.toHaveProperty('thinkingConfig')
  })

  it('does not retry a 400 that is about something else', async () => {
    const { mock, translate } = await googleTranslate('gemini-3.5-flash', [
      jsonBody({ error: { message: 'Invalid JSON payload' } }, 400),
      jsonBody(OK_BODY.google),
    ])

    const error = await translate(REQUEST).catch((e: unknown) => e)

    expect(mock).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ kind: 'provider', status: 400 })
  })

  it('sends no thinkingConfig at all for a non-Gemini model behind a base URL', async () => {
    const mock = stubFetch(jsonBody(OK_BODY.google))
    const translate = await createTranslateFn({
      provider: 'google',
      model: 'qwen2.5:14b',
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example',
    })
    await translate(REQUEST)

    expect(generationConfigOf(captured(mock).body)).not.toHaveProperty('thinkingConfig')
  })
})

describe('HTTP failures classify the same way for every provider', () => {
  const providers: LlmProvider[] = ['openai', 'anthropic', 'google']

  for (const provider of providers) {
    it(`maps 401 to auth for ${provider}`, async () => {
      const error = await translateFailure(provider, jsonBody({ error: { message: 'invalid key' } }, 401))
      expect(error).toBeInstanceOf(TranslateProviderError)
      expect(error).toMatchObject({ kind: 'auth', status: 401 })
      // The provider's own explanation survives into the message the run logs.
      expect((error as Error).message).toContain('invalid key')
    })

    it(`maps 429 to rate-limit for ${provider}`, async () => {
      const error = await translateFailure(provider, jsonBody({ error: { message: 'slow down' } }, 429))
      expect(error).toMatchObject({ kind: 'rate-limit', status: 429 })
    })

    it(`maps a server error to provider for ${provider}`, async () => {
      const error = await translateFailure(provider, jsonBody({ error: { message: 'overloaded' } }, 503))
      expect(error).toMatchObject({ kind: 'provider', status: 503 })
    })
  }

  it('surfaces a non-JSON error body verbatim', async () => {
    const error = await translateFailure('openai', { body: '<html>bad gateway</html>', status: 502 })
    expect(error).toMatchObject({ kind: 'provider', status: 502 })
    expect((error as Error).message).toContain('<html>bad gateway</html>')
  })

  it('classifies a network failure as provider, with no status', async () => {
    const error = await translateFailure('anthropic', new TypeError('fetch failed'))
    expect(error).toMatchObject({ kind: 'provider', message: 'fetch failed' })
    expect((error as TranslateProviderError).status).toBeUndefined()
  })

  it('reports a timeout as a provider error naming the budget', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const error = await translateFailure('google', timeout)
    expect(error).toMatchObject({ kind: 'provider' })
    expect((error as Error).message).toMatch(/did not respond within 600s/)
  })

  it('classifies a success body that is not JSON as provider', async () => {
    const error = await translateFailure('openai', { body: 'not json', status: 200 })
    expect(error).toMatchObject({ kind: 'provider', status: 200 })
  })
})

describe('createTranslateFn setup errors', () => {
  it('rejects a missing API key as a config error, before any request', async () => {
    const mock = stubFetch(jsonBody(OK_BODY.openai))
    vi.stubEnv('OPENAI_API_KEY', '')
    await expect(createTranslateFn({ provider: 'openai', model: 'gpt-4o' }))
      .rejects.toMatchObject({ name: 'TranslateProviderError', kind: 'config' })
    expect(mock).not.toHaveBeenCalled()
  })

  it('names the environment variable to set', async () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    await expect(createTranslateFn({ provider: 'google', model: 'gemini-2.0-flash' }))
      .rejects.toThrow(/GEMINI_API_KEY/)
  })

  it('reads the API key from the environment when the config omits it', async () => {
    const mock = stubFetch(jsonBody(OK_BODY.anthropic))
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env')
    const translate = await createTranslateFn({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' })
    await translate(REQUEST)
    expect(captured(mock).headers['x-api-key']).toBe('from-env')
  })
})
