import type { TranslateFn, TranslateRequest, TranslateResponse } from '../core/types.js'

export type LlmProvider = 'openai' | 'anthropic' | 'google'

// ─── Error classification ───────────────────────────────────────

/** How a provider failure should be handled by the caller. */
export type TranslateProviderErrorKind = 'auth' | 'rate-limit' | 'provider' | 'config'

/**
 * A classified provider failure. `auth` errors are not retryable (the caller
 * should abort the run), `rate-limit` errors should be retried with backoff,
 * and `provider` covers everything else (server errors, network, …).
 * `config` marks an unusable provider setup and is raised while building the
 * TranslateFn, before any request exists — so it surfaces from the command
 * and never reaches the retry loop.
 */
export class TranslateProviderError extends Error {
  public readonly kind: TranslateProviderErrorKind
  public readonly status?: number

  constructor(message: string, kind: TranslateProviderErrorKind, status?: number) {
    super(message)
    this.name = 'TranslateProviderError'
    this.kind = kind
    this.status = status
  }
}

/** Defensively extract an HTTP status code from an unknown error shape. */
function extractStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const e = error as { status?: unknown, response?: unknown }
  if (typeof e.status === 'number') return e.status
  if (e.response !== null && typeof e.response === 'object') {
    const status = (e.response as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

/**
 * Classify a provider error into a TranslateProviderError:
 * 401/403 → auth, 429 → rate-limit, anything else → provider.
 * Already-classified errors pass through unchanged.
 */
export function classifyProviderError(error: unknown): TranslateProviderError {
  if (error instanceof TranslateProviderError) return error
  const status = extractStatus(error)
  const message = error instanceof Error ? error.message : String(error)
  const kind: TranslateProviderErrorKind
    = status === 401 || status === 403 ? 'auth'
      : status === 429 ? 'rate-limit'
        : 'provider'
  return new TranslateProviderError(message, kind, status)
}

export interface LlmProviderConfig {
  provider: LlmProvider
  model: string
  /** Override API key. Falls back to env vars */
  apiKey?: string
  /** Base URL override for proxies / compatible APIs */
  baseUrl?: string
}

/** Environment variable carrying the provider base URL override. */
export const BASE_URL_ENV = 'I18N_BASE_URL'

/**
 * Resolve the provider base URL from its three sources, highest precedence
 * first: an explicit flag, the I18N_BASE_URL env var, then the project
 * config's `providerBaseUrl`.
 *
 * Blank values count as unset. Shells produce them routinely — `--baseUrl
 * "$UNSET"` or an exported-but-empty variable — and a blank must not shadow a
 * real endpoint configured further down the chain. A blank in the config file
 * is a different case: it cannot arise by accident, so the strict schema
 * rejects it at load time rather than letting it reach this function.
 */
export function resolveProviderBaseUrl(sources: {
  flag?: string
  env?: string
  config?: string
}): string | undefined {
  for (const value of [sources.flag, sources.env, sources.config]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

const ENV_KEY_MAP: Record<LlmProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
}

function resolveApiKey(provider: LlmProvider, configKey?: string): string {
  if (configKey) return configKey
  const envKey = ENV_KEY_MAP[provider]
  const key = process.env[envKey]
  if (!key) {
    throw new TranslateProviderError(
      `No API key found for provider "${provider}". Set ${envKey} environment variable or pass apiKey in config.`,
      'config',
    )
  }
  return key
}

// ─── HTTP transport ─────────────────────────────────────────────

/** Default endpoints, each overridable through the base URL sources. */
const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
}

/**
 * Per-request timeout, keeping the ten-minute default the provider SDKs
 * applied before this transport existed. It is deliberately generous: every
 * request asks for the same large token budget, and a slow endpoint — a
 * self-hosted model behind a base URL above all — can take minutes to produce
 * it. The ceiling only exists to stop a hung socket from stalling a run.
 */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

/** Join a base URL with a path, tolerating a trailing slash on the base. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/** Cap an untrusted provider body so it stays readable inside an error. */
function summarize(raw: string): string {
  const text = raw.trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * Pull the human-readable message out of a provider error body. All three
 * providers nest it under `error.message`; anything else — an HTML error page
 * from a proxy, say — is reported verbatim but capped.
 */
function errorDetail(raw: string): string {
  try {
    const body: unknown = JSON.parse(raw)
    if (body !== null && typeof body === 'object') {
      const { error, message } = body as { error?: unknown, message?: unknown }
      const nested = error !== null && typeof error === 'object'
        ? (error as { message?: unknown }).message
        : error
      if (typeof nested === 'string' && nested.trim() !== '') return nested
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  } catch {
    // Not JSON — the raw body is the best detail available.
  }
  return summarize(raw)
}

interface ProviderRequest {
  provider: LlmProvider
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * POST a JSON body and return the parsed response, mapping every failure onto
 * a classified TranslateProviderError: an HTTP status keeps its meaning
 * (401/403 auth, 429 rate limit), while network, timeout and malformed-body
 * failures land on `provider` and are retried by the caller.
 */
async function postJson<T>(request: ProviderRequest): Promise<T> {
  let response: Response
  let raw: string
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    raw = await response.text()
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new TranslateProviderError(
        `Provider "${request.provider}" did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`,
        'provider',
      )
    }
    throw classifyProviderError(error)
  }

  if (!response.ok) {
    const failure = new Error(
      `Provider "${request.provider}" request failed (HTTP ${response.status}): ${errorDetail(raw)}`,
    ) as Error & { status: number }
    failure.status = response.status
    throw classifyProviderError(failure)
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    throw new TranslateProviderError(
      `Provider "${request.provider}" returned a non-JSON response: ${summarize(raw)}`,
      'provider',
      response.status,
    )
  }
}

/** Assemble a TranslateResponse, omitting `truncated` unless it is true. */
function toTranslateResponse(text: string, model: string | undefined, fallbackModel: string, truncated: boolean): TranslateResponse {
  return { text, model: model || fallbackModel, ...(truncated ? { truncated: true } : {}) }
}

// ─── Providers ──────────────────────────────────────────────────

interface OpenAiChatResponse {
  model?: string
  choices?: Array<{
    message?: { content?: string | null }
    finish_reason?: string
  }>
}

function createOpenAiTranslateFn(config: LlmProviderConfig): TranslateFn {
  const apiKey = resolveApiKey('openai', config.apiKey)
  const url = joinUrl(config.baseUrl ?? DEFAULT_BASE_URL.openai, '/chat/completions')

  return async (opts: TranslateRequest): Promise<TranslateResponse> => {
    const response = await postJson<OpenAiChatResponse>({
      provider: 'openai',
      url,
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: config.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userMessage },
        ],
        max_tokens: opts.maxTokens,
        temperature: 0,
        response_format: { type: 'json_object' },
      },
    })

    const choice = response.choices?.[0]
    return toTranslateResponse(
      choice?.message?.content ?? '',
      response.model,
      config.model,
      choice?.finish_reason === 'length',
    )
  }
}

interface AnthropicMessagesResponse {
  model?: string
  stop_reason?: string
  content?: Array<{ type?: string, text?: string }>
}

function createAnthropicTranslateFn(config: LlmProviderConfig): TranslateFn {
  const apiKey = resolveApiKey('anthropic', config.apiKey)
  const url = joinUrl(config.baseUrl ?? DEFAULT_BASE_URL.anthropic, '/v1/messages')

  return async (opts: TranslateRequest): Promise<TranslateResponse> => {
    const response = await postJson<AnthropicMessagesResponse>({
      provider: 'anthropic',
      url,
      headers: {
        'x-api-key': apiKey,
        // Pinned: the Messages API requires a version and an unpinned one would
        // let a future breaking release reshape the response under us.
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        system: opts.systemPrompt,
        messages: [{ role: 'user', content: opts.userMessage }],
        max_tokens: opts.maxTokens,
        temperature: 0,
      },
    })

    // A reply arrives as a list of blocks; only the text ones carry the JSON.
    const text = (response.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    return toTranslateResponse(text, response.model, config.model, response.stop_reason === 'max_tokens')
  }
}

interface GoogleGenerateContentResponse {
  modelVersion?: string
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
}

/**
 * The thinking settings to send with a Gemini request, or undefined for a model
 * that is not a Gemini one (a base URL override can point at anything).
 *
 * Gemini thinks by default and the thinking tokens are spent from the same
 * maxOutputTokens budget as the answer, so an unconfigured request can burn the
 * whole budget and come back MAX_TOKENS with no JSON at all — identically on
 * every retry, since the run asks at temperature 0. Translating UI strings is a
 * simple task in Google's own guidance, so every family gets the least thinking
 * it accepts.
 *
 * The two families disagree on the knob: 2.5 takes a token budget (Pro cannot
 * go below 128; Flash and Flash-Lite take 0) and rejects a level, while 3.x
 * takes a level and rejects a budget. 'low' rather than 'minimal' because
 * 'minimal' errors on part of the 3.x line and 'low' is accepted across all of
 * it.
 */
export function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  const name = model.toLowerCase()
  if (!name.includes('gemini-')) return undefined
  if (name.includes('gemini-2.5')) {
    return /gemini-2\.5-.*pro/.test(name) ? { thinkingBudget: 128 } : { thinkingBudget: 0 }
  }
  return { thinkingLevel: 'low' }
}

/**
 * A 400 naming thinking is the endpoint refusing the thinkingConfig itself —
 * an older model, or a proxy that does not forward the field. Anything else is
 * a real failure and must not be masked by a second request.
 */
function rejectsThinkingConfig(error: unknown): boolean {
  return error instanceof TranslateProviderError
    && error.status === 400
    && /thinking/i.test(error.message)
}

function createGoogleTranslateFn(config: LlmProviderConfig): TranslateFn {
  const apiKey = resolveApiKey('google', config.apiKey)
  // The REST path already carries the `models/` prefix, so accept a model name
  // written either way rather than producing `/models/models/gemini-…`.
  const model = config.model.replace(/^models\//, '')
  const url = joinUrl(config.baseUrl ?? DEFAULT_BASE_URL.google, `/v1beta/models/${model}:generateContent`)
  const thinkingConfig = thinkingConfigFor(model)
  // A rejection is a property of the endpoint, not of one request: once it says
  // no, every later request in this process omits the field instead of paying
  // for a rejected round trip first.
  let sendThinkingConfig = thinkingConfig !== undefined

  return async (opts: TranslateRequest): Promise<TranslateResponse> => {
    const requestBody = (withThinking: boolean) => ({
      contents: [{ role: 'user', parts: [{ text: opts.userMessage }] }],
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        temperature: 0,
        responseMimeType: 'application/json',
        ...(withThinking && thinkingConfig ? { thinkingConfig } : {}),
      },
    })
    const send = (withThinking: boolean) => postJson<GoogleGenerateContentResponse>({
      provider: 'google',
      url,
      headers: { 'x-goog-api-key': apiKey },
      body: requestBody(withThinking),
    })

    let response: GoogleGenerateContentResponse
    try {
      response = await send(sendThinkingConfig)
    }
    catch (error) {
      if (!sendThinkingConfig || !rejectsThinkingConfig(error)) throw error
      sendThinkingConfig = false
      response = await send(false)
    }

    const candidate = response.candidates?.[0]
    const text = (candidate?.content?.parts ?? []).map(part => part.text ?? '').join('')
    return toTranslateResponse(text, response.modelVersion, config.model, candidate?.finishReason === 'MAX_TOKENS')
  }
}

/**
 * Create a TranslateFn from an LLM provider config. Every provider is called
 * over plain HTTP, so nothing beyond the CLI has to be installed.
 * Throws if the API key is missing.
 */
export async function createTranslateFn(config: LlmProviderConfig): Promise<TranslateFn> {
  switch (config.provider) {
    case 'openai':
      return createOpenAiTranslateFn(config)
    case 'anthropic':
      return createAnthropicTranslateFn(config)
    case 'google':
      return createGoogleTranslateFn(config)
    default: {
      const _exhaustive: never = config.provider
      throw new Error(`Unknown provider: ${_exhaustive}`)
    }
  }
}
