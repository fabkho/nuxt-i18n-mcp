#!/usr/bin/env node
/**
 * PreToolUse hook: deny hand-edits to managed locale files.
 *
 * Agents that edit one locale file directly drift it from its siblings —
 * broken key ordering, missing counterparts in other locales, format quirks.
 * The kit's tools (write_translations, translate_missing, remove, move) keep
 * every locale consistent, so file edits inside a locale directory are blocked
 * and the agent is pointed at them.
 *
 * Exit codes: 0 allows, 2 blocks (stderr is fed back to the model).
 * Escape hatch: I18N_KIT_ALLOW_DIRECT_EDITS=1.
 */

import { extname } from 'node:path'
import { findProjectRoot, getLocaleDirs, isInside, readHookInput } from './lib.mjs'

const LOCALE_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.php'])

if (process.env.I18N_KIT_ALLOW_DIRECT_EDITS === '1') process.exit(0)

const input = readHookInput()
const filePath = input.tool_input?.file_path
if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0)
if (!LOCALE_EXTENSIONS.has(extname(filePath).toLowerCase())) process.exit(0)

const projectRoot = findProjectRoot(input.cwd ?? process.cwd())
if (!projectRoot) process.exit(0)

const localeDirs = getLocaleDirs(projectRoot)
if (!localeDirs || localeDirs.length === 0) process.exit(0)

if (isInside(filePath, localeDirs)) {
  process.stderr.write(
    `${filePath} is a managed locale file. Do not edit locale files directly — ` +
    `that drifts them from their sibling locales. Use the the-i18n-kit MCP tools instead: ` +
    `write_translations to add or change keys, translate_missing to fill gaps, ` +
    `remove_translations / move_translation_key for restructuring. ` +
    `(Set I18N_KIT_ALLOW_DIRECT_EDITS=1 to bypass this guard.)\n`,
  )
  process.exit(2)
}

process.exit(0)
