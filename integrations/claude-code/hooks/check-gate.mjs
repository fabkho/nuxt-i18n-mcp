#!/usr/bin/env node
/**
 * Stop hook: refuse to finish while code references undefined i18n keys.
 *
 * Runs `the-i18n-cli check` (keys used in source but defined in no consumed
 * locale layer — the direction that ships raw keys to production). Findings
 * block the stop with a summary so the agent fixes them in-session instead of
 * leaving them for CI.
 *
 * Loop-safe: when Claude Code re-runs the hook after a blocked stop
 * (stop_hook_active), it passes. Skips silently on non-i18n projects and on
 * infrastructure failure. Escape hatch: I18N_KIT_SKIP_CHECK=1.
 */

import { findProjectRoot, readHookInput, runCli } from './lib.mjs'

const MAX_LISTED_KEYS = 10

if (process.env.I18N_KIT_SKIP_CHECK === '1') process.exit(0)

const input = readHookInput()
if (input.stop_hook_active) process.exit(0)

const projectRoot = findProjectRoot(input.cwd ?? process.cwd())
if (!projectRoot) process.exit(0)

const result = runCli(projectRoot, ['check', '--json'], 120_000)
if (!result) process.exit(0)
if (result.status === 0) process.exit(0)

let summary = ''
try {
  const parsed = JSON.parse(result.stdout)
  if (parsed.error) process.exit(0) // config/spawn problems never block the stop
  const keys = collectKeys(parsed)
  const listed = keys.slice(0, MAX_LISTED_KEYS).join(', ')
  const suffix = keys.length > MAX_LISTED_KEYS ? `, … (${keys.length} total)` : ''
  summary = keys.length > 0 ? ` Undefined keys: ${listed}${suffix}.` : ''
} catch {
  // fall through with the generic message
}

process.stderr.write(
  `i18n check failed: source code references translation keys that no locale layer defines — ` +
  `these render as raw keys in production.${summary} ` +
  `Define them via the the-i18n-kit MCP tools (write_translations or translate_key), ` +
  `or remove the stale references. Run the check tool (find_undefined_keys) for full details.\n`,
)
process.exit(2)

/** Pull key names out of the check result without depending on its exact shape. */
function collectKeys(node, found = new Set()) {
  if (found.size > 200 || node === null || typeof node !== 'object') return [...found]
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, found)
    return [...found]
  }
  if (typeof node.key === 'string') found.add(node.key)
  for (const value of Object.values(node)) collectKeys(value, found)
  return [...found]
}
