import { existsSync, statSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const NUXT_CONFIG_FILES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] as const

const SKIP_DIRS = new Set([
  'node_modules', '.nuxt', '.output', '.git', 'dist', '.cache',
])

const MAX_DISCOVERY_DEPTH = 4

export function canonicalPath(dir: string): string {
  try {
    return realpathSync(resolve(dir))
  }
  catch {
    return resolve(dir)
  }
}

export function findNuxtConfig(dir: string): string | null {
  for (const name of NUXT_CONFIG_FILES) {
    if (existsSync(resolve(dir, name))) {
      return name
    }
  }
  return null
}

async function hasI18nConfig(configPath: string): Promise<boolean> {
  try {
    const content = await readFile(configPath, 'utf-8')
    return /\bi18n\b/.test(content)
  }
  catch {
    return false
  }
}

/**
 * Discover all Nuxt apps with i18n configuration under a root directory.
 * Scans recursively up to MAX_DISCOVERY_DEPTH levels deep,
 * skipping common non-project directories.
 *
 * Returns sorted absolute paths to directories that:
 * 1. Contain a nuxt.config.{ts,js,mjs} file
 * 2. The config file references i18n
 */
export async function discoverNuxtApps(rootDir: string): Promise<string[]> {
  const apps: string[] = []
  await scanForApps(rootDir, 0, apps)
  const root = resolve(rootDir)
  apps.sort((a, b) => relative(root, a).localeCompare(relative(root, b)))
  return apps
}

async function scanForApps(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) return

  const configFile = findNuxtConfig(dir)
  if (configFile) {
    const configPath = resolve(dir, configFile)
    if (await hasI18nConfig(configPath)) {
      results.push(dir)
    }
    return
  }

  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch {
    return
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue
    const childDir = resolve(dir, entry)
    try {
      const stat = statSync(childDir)
      if (!stat.isDirectory()) continue
    }
    catch {
      continue
    }
    await scanForApps(childDir, depth + 1, results)
  }
}

/**
 * Derive a human-friendly layer name from its root directory.
 * Uses the discovery root as the reference point for naming.
 *
 * When `usedNames` is provided, disambiguates collisions by progressively
 * including parent path segments (e.g., `admin` → `apps/admin`).
 */
export function deriveLayerName(
  layerRootDir: string,
  discoveryRoot: string,
  usedNames?: Set<string>,
): string {
  const rel = relative(discoveryRoot, layerRootDir)
  if (rel === '' || rel === '.') {
    return 'root'
  }

  const posixRel = rel.replace(/\\/g, '/')

  if (!posixRel.startsWith('..')) {
    const segments = posixRel.split('/')
    let candidate = segments[segments.length - 1]

    if (usedNames) {
      for (let i = segments.length - 2; i >= 0; i--) {
        if (!usedNames.has(candidate)) break
        candidate = `${segments[i]}/${candidate}`
      }
    }

    return candidate
  }

  const parts = layerRootDir.replace(/\\/g, '/').split('/')
  let candidate = parts[parts.length - 1]

  if (usedNames) {
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!usedNames.has(candidate)) break
      candidate = `${parts[i]}/${candidate}`
    }
  }

  return candidate
}
