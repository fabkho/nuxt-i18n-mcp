/**
 * Parsing of a translate response into a key → value object, including the
 * salvage path for responses the provider cut off mid-object.
 */

import { log } from '../../utils/logger.js'

export interface ExtractJsonOptions {
  /**
   * The provider reported it stopped at the token limit. Two things follow:
   * the last pair that parses is no longer trustworthy (a value cut mid-string
   * can still close cleanly, so it is dropped), and the recovery is not warned
   * about here — a caller that already knows the response was cut reports what
   * it kept itself.
   */
  truncated?: boolean
}

export function extractJsonFromResponse(responseText: string, options: ExtractJsonOptions = {}): Record<string, unknown> {
  const trimmed = responseText.trim()

  // Tier 1: direct parse
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {}

  // Tier 2: strip markdown code fences
  if (trimmed.startsWith('```')) {
    const stripped = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    try {
      return JSON.parse(stripped) as Record<string, unknown>
    } catch {}
  }

  // Tier 3: balanced bracket extraction — find first complete {...}
  const start = trimmed.indexOf('{')
  if (start !== -1) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1)
          try {
            return JSON.parse(candidate) as Record<string, unknown>
          }
          catch {
            // Balanced braces are not valid JSON on their own — a stray token
            // between two pairs balances just as well. Fall through to the
            // salvage tier rather than failing the whole response.
          }
          break
        }
      }
    }
  }

  // Tier 4: the object never closed. Salvage the pairs that did arrive.
  //
  // Observed in the wild on a real Gemini response: the complete, correct
  // translation missing only its closing brace. Discarding the whole response
  // over two absent characters left keys untranslated across repeated runs,
  // and each rerun asked the model for them again.
  if (start !== -1) {
    const salvaged = salvageTruncatedObject(trimmed.slice(start), options.truncated ?? false)
    if (salvaged) {
      if (!options.truncated) {
        log.warn(
          `Translate response ended mid-object — recovered ${Object.keys(salvaged).length} complete pair(s). `
          + 'Remaining keys are reported as failed and can be retried.',
        )
      }
      return salvaged
    }

    throw new Error(
      `Response ended mid-object before any pair completed. Preview: ${trimmed.substring(0, 200)}`,
    )
  }

  throw new Error(`No valid JSON object found in response. Preview: ${trimmed.substring(0, 200)}`)
}

/**
 * Close an object that was cut off, keeping the key/value pairs that arrived
 * whole. Tries the string as-is first — a response missing only its brace is
 * the common case — then falls back to the last pair that ended cleanly,
 * dropping whatever was half-written after it.
 *
 * The two candidates carry different guarantees. Everything before the last
 * top-level comma is provably complete: the model wrote the comma after it.
 * The as-is candidate has no such witness — `"key": "Hal` and `"key": "Hallo`
 * both close cleanly once a brace is appended, so a value cut mid-string is
 * indistinguishable from a finished one. `dropSuspectLastPair` discards it,
 * which is what a provider-reported truncation demands and what a merely
 * brace-less response does not.
 */
function salvageTruncatedObject(text: string, dropSuspectLastPair: boolean): Record<string, unknown> | null {
  const candidates: Array<{ text: string, suspectLastPair: boolean }> = [
    { text, suspectLastPair: dropSuspectLastPair },
    { text: text.slice(0, lastCompletePairEnd(text)), suspectLastPair: false },
  ]

  for (const candidate of candidates) {
    if (!candidate.text) continue
    try {
      const parsed = JSON.parse(`${candidate.text}}`) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') continue
      const keys = Object.keys(parsed)
      if (candidate.suspectLastPair) {
        // Key order is insertion order, so the last key is the last one the
        // provider wrote — and the only one truncation can have corrupted.
        const lastKey = keys[keys.length - 1]
        if (lastKey !== undefined) delete parsed[lastKey]
      }
      if (Object.keys(parsed).length > 0) return parsed
    }
    catch {
      // Try the shorter cut.
    }
  }

  return null
}

/**
 * Index of the last top-level comma — the boundary after the last pair that
 * completed. Commas inside strings do not count, which is why this scans
 * rather than searching: a translated value may contain one.
 */
function lastCompletePairEnd(text: string): number {
  let depth = 0
  let inString = false
  let escape = false
  let lastComma = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 1) lastComma = i
  }

  return lastComma
}
