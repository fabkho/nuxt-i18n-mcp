/**
 * Shared helpers for the-i18n-kit Claude Code hooks.
 *
 * Dependency-free Node (>= 20). Hooks must never break the editing loop on
 * infrastructure failure, so every resolution step degrades to "not an i18n
 * project" rather than throwing.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const CONFIG_FILES = [
  '.i18n-mcp.json',
  'i18n-kit.config.ts',
  'i18n-kit.config.mts',
  'i18n-kit.config.js',
  'i18n-kit.config.mjs',
]

const DISCOVER_CACHE_TTL_MS = 5 * 60 * 1000

/** Read the hook payload Claude Code passes on stdin. Returns {} on garbage. */
export function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

/** Walk up from `startDir` to the nearest directory holding an i18n-kit config. */
export function findProjectRoot(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    if (CONFIG_FILES.some(name => existsSync(join(dir, name)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve a runnable the-i18n-cli for `projectRoot`, preferring a project-local
 * install, then a global binary, then npx as the slow-but-always-works path.
 * Returns argv as [command, ...args].
 */
export function resolveCli(projectRoot) {
  let dir = projectRoot
  for (;;) {
    const local = join(dir, 'node_modules', '.bin', 'the-i18n-cli')
    if (existsSync(local)) return [local]
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const which = spawnSync('the-i18n-cli', ['--help'], { encoding: 'utf8', timeout: 10_000 })
  // The pre-rename CLI (< v10) lacks `discover`; only trust a binary that has it.
  if (which.status === 0 && which.stdout.includes('discover')) return ['the-i18n-cli']
  return ['npx', '-y', '@the-i18n-kit/cli@latest']
}

/** Run a CLI command, returning { status, stdout } or undefined on spawn failure. */
export function runCli(projectRoot, args, timeoutMs = 60_000) {
  const [command, ...prefix] = resolveCli(projectRoot)
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  if (result.error) return undefined
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/**
 * The project's locale directories (absolute paths), via `discover --json`,
 * cached on disk so the PreToolUse hook stays fast on every edit.
 */
export function getLocaleDirs(projectRoot) {
  const cacheDir = join(tmpdir(), 'the-i18n-kit-hooks')
  const cacheFile = join(cacheDir, createHash('sha256').update(projectRoot).digest('hex').slice(0, 16) + '.json')
  try {
    const age = Date.now() - statSync(cacheFile).mtimeMs
    if (age < DISCOVER_CACHE_TTL_MS) {
      return JSON.parse(readFileSync(cacheFile, 'utf8'))
    }
  } catch {
    // no cache yet
  }

  const result = runCli(projectRoot, ['discover', '--json'])
  if (!result || result.status !== 0) return undefined
  let dirs
  try {
    const parsed = JSON.parse(result.stdout)
    if (parsed.error) return undefined
    dirs = (parsed.localeDirs ?? []).map(entry => resolve(entry.path))
  } catch {
    return undefined
  }

  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(dirs))
  } catch {
    // cache is best-effort
  }
  return dirs
}

/** True when `filePath` lives inside any of `dirs`. */
export function isInside(filePath, dirs) {
  const abs = resolve(filePath)
  return dirs.some(dir => abs === dir || abs.startsWith(dir + sep))
}
