/**
 * Translation operations: translate_missing and translate_key, plus the
 * prompt builders, placeholder validation, and fallback-context helpers
 * they share.
 *
 * This module is a barrel: the implementations live in ./translate/* and are
 * re-exported here so consumers keep a single stable import path.
 */

export { resolveProtectedLocales } from './translate/targets.js'

export {
  validatePlaceholders,
  comparePlaceholders,
  mergePlaceholderValidation,
  describePlaceholderIssue,
} from './translate/placeholders.js'

export { buildTranslationSystemPrompt, buildTranslationUserMessage } from './translate/prompts.js'

export { extractJsonFromResponse } from './translate/json-salvage.js'

export { computeProgressTotal, translateMissing, translateKey } from './translate/run.js'
