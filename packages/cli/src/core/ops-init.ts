/**
 * init: produce a schema-valid .i18n-mcp.json for a cold project.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { detectFrameworkMatch } from '../adapters/registry.js'
import { CONFIG_FILENAME, validateProjectConfig } from '../config/project-config.js'
import { writeLocaleFile } from '../io/json-writer.js'
import { ToolError } from '../utils/errors.js'
import { log } from '../utils/logger.js'
import type { FrameworkMatch } from '../adapters/registry.js'

/**
 * The config `init` emits. Only fields the matched adapter cannot derive:
 * writing a copy of what the framework already states creates a second source
 * of truth that drifts silently (#305). The generic path is the exception —
 * without localeDirs and defaultLocale nothing resolves at all.
 */
export interface GeneratedProjectConfig {
  $schema: string
  context: string
  glossary: Record<string, string>
  translationPrompt: string
  localeNotes: Record<string, string>
  /** Matches localeDirEntrySchema: a bare path, or a path bound to a layer. */
  localeDirs?: Array<string | { path: string; layer: string }>
  defaultLocale?: string
  locales?: string[]
}

export interface InitProjectConfigResult {
  config: GeneratedProjectConfig
  detected: {
    adapter: string
    label: string
    /** Detection score. 0 when nothing matched and generic was assumed. */
    confidence: number
    /**
     * Whether the matched adapter resolves locales, layers and the default
     * locale from framework config. False only for the generic adapter, which
     * cannot resolve without them written into `.i18n-mcp.json`. Independent
     * of whether this run carried locale settings forward from an existing
     * file under `--force`.
     */
    derivesLocaleConfig: boolean
    /** Other adapters that also scored, best first. */
    runnersUp?: Array<{ name: string; confidence: number }>
    /** Present when init could not find anything to point the config at. */
    note?: string
  }
  /** Path relative to the project dir. */
  configPath: string
  written: boolean
  overwritten: boolean
}

type Detected = InitProjectConfigResult['detected']
type CarriedLocaleConfig = Pick<GeneratedProjectConfig, 'localeDirs' | 'defaultLocale' | 'locales'>

/** Where a project with no detected framework plausibly keeps its locales. */
const COMMON_LOCALE_DIRS = [
  'locales',
  'src/locales',
  'i18n/locales',
  'src/i18n/locales',
  'i18n',
  'src/i18n',
  'lang',
  'public/locales',
  'messages',
]

/** The one adapter that cannot resolve without locale config in the file. */
const GENERIC_ADAPTER = 'generic'

const SCHEMA_URL = 'https://raw.githubusercontent.com/fabkho/the-i18n-kit/main/packages/mcp/schema.json'

/**
 * Authoring fields no adapter can derive — the reason a config file exists at
 * all once the framework supplies the rest. Emitted as empty scaffolding so
 * the shape is discoverable without reading the schema.
 */
function authoringScaffold(): GeneratedProjectConfig {
  return {
    $schema: SCHEMA_URL,
    context: '',
    glossary: {},
    translationPrompt: '',
    localeNotes: {},
  }
}

/**
 * Probe for a locale directory in a project with no framework. Returns paths
 * relative to the project dir — `.i18n-mcp.json` is committed, so absolute
 * paths would break for everyone but the author.
 */
async function probeLocaleDirs(projectDir: string): Promise<string[]> {
  const found: string[] = []
  for (const candidate of COMMON_LOCALE_DIRS) {
    const full = join(projectDir, candidate)
    if (!existsSync(full)) continue
    try {
      const entries = await readdir(full)
      if (entries.some(e => e.endsWith('.json') || e.endsWith('.php'))) found.push(candidate)
    }
    catch {
      // Unreadable — not a candidate.
    }
  }
  return found
}

/** Locale codes from the file names in a probed directory. */
async function probeLocaleCodes(projectDir: string, localeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectDir, localeDir))
    return entries
      .filter(e => e.endsWith('.json'))
      .map(e => e.slice(0, -5))
      .sort()
  }
  catch {
    return []
  }
}

/** Leaf-key count of a locale file, or -1 when it cannot be read. */
async function countKeys(path: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    const walk = (v: unknown): number =>
      v !== null && typeof v === 'object'
        ? Object.values(v as Record<string, unknown>).reduce<number>((n, child) => n + walk(child), 0)
        : 1
    return walk(parsed)
  }
  catch {
    return -1
  }
}

/**
 * Guess the reference locale for a project with no framework config.
 *
 * The fullest file, not the alphabetically first: a source locale is the one
 * everything else is translated from, so it has the most keys. Picking
 * alphabetically is how a project ends up silently treating German as its
 * source because `de` sorts before `en` (cf. #296). Ties break alphabetically
 * so the result stays deterministic.
 */
async function guessDefaultLocale(
  projectDir: string,
  localeDir: string,
  codes: string[],
): Promise<string | undefined> {
  let best: { code: string; keys: number } | undefined
  for (const code of codes) {
    const keys = await countKeys(join(projectDir, localeDir, `${code}.json`))
    if (!best || keys > best.keys) best = { code, keys }
  }
  return best?.code
}

/**
 * Config for a project whose framework was detected by an adapter that derives
 * its own locale settings.
 *
 * Deliberately minimal: an adapter that derives locales, layers and the
 * default locale gets none of them written down. Generating a copy of what
 * `nuxt.config.ts` already states creates the second source of truth that
 * #305 exists to remove, and it goes stale silently.
 */
function detectedProject(
  match: FrameworkMatch,
  carried: CarriedLocaleConfig,
): { config: GeneratedProjectConfig; detected: Detected } {
  return {
    config: { ...authoringScaffold(), ...carried },
    detected: {
      adapter: match.adapter.name,
      label: match.adapter.label,
      confidence: match.confidence,
      // A property of the adapter, not of this run: forcing over a config that
      // happens to carry localeDirs must not make Nuxt look like it needs them.
      derivesLocaleConfig: true,
      ...(match.runnersUp.length > 0 ? { runnersUp: match.runnersUp } : {}),
    },
  }
}

/**
 * Locale settings already present in the file being overwritten.
 *
 * `--force` regenerates the scaffolding, and for a project whose config is
 * load-bearing — anything relying on the generic adapter — dropping
 * `localeDirs` would leave it unresolvable. Preserving them is not
 * adapter-specific: no `--force` should ever silently delete locale settings
 * someone wrote by hand.
 */
async function carryLocaleConfig(configPath: string): Promise<CarriedLocaleConfig> {
  if (!existsSync(configPath)) return {}
  try {
    const existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>
    const carried: CarriedLocaleConfig = {}
    if (Array.isArray(existing.localeDirs)) carried.localeDirs = existing.localeDirs as string[]
    if (typeof existing.defaultLocale === 'string') carried.defaultLocale = existing.defaultLocale
    if (Array.isArray(existing.locales)) carried.locales = existing.locales as string[]
    return carried
  }
  catch {
    // Unreadable or malformed — nothing to preserve, and init is about to
    // replace it anyway.
    return {}
  }
}

/**
 * Config for a project the generic adapter resolves: one no adapter claimed,
 * or one it claimed by probing a conventional directory rather than by reading
 * a declaration. Its locale settings are written down — the one case where
 * init writes locale data it inferred rather than read — because a committed
 * path is the only thing that survives moving the files somewhere less
 * conventional.
 *
 * A file that already declares both keys is left to say what it says: probing
 * over it would add a locale list nobody asked for.
 */
async function genericProject(
  projectDir: string,
  carried: CarriedLocaleConfig,
  match: FrameworkMatch | undefined,
): Promise<{ config: GeneratedProjectConfig; detected: Detected }> {
  const declared = carried.localeDirs !== undefined && carried.defaultLocale !== undefined
  const probe = declared ? null : await probeLocaleConfig(projectDir)

  return {
    config: {
      ...authoringScaffold(),
      ...probe?.config,
      ...carried,
    },
    detected: {
      adapter: GENERIC_ADAPTER,
      label: 'Generic',
      confidence: match?.confidence ?? 0,
      derivesLocaleConfig: false,
      ...(match && match.runnersUp.length > 0 ? { runnersUp: match.runnersUp } : {}),
      ...(probe?.note ? { note: probe.note } : {}),
    },
  }
}

/** The locale settings a probe of the conventional directories yields. */
async function probeLocaleConfig(
  projectDir: string,
): Promise<{ config: CarriedLocaleConfig; note?: string }> {
  const localeDirs = await probeLocaleDirs(projectDir)
  const [firstDir] = localeDirs
  const locales = firstDir ? await probeLocaleCodes(projectDir, firstDir) : []
  const guessed = firstDir ? await guessDefaultLocale(projectDir, firstDir, locales) : undefined

  // A directory of flat .php files is matched as a locale dir but cannot be
  // resolved: the generic adapter infers the format from the directory and has
  // no flat-PHP branch (#308). Emitting locale codes for it would be worse than
  // emitting none — the adapter would then treat them as JSON and read every
  // file as empty. Say so instead of shipping a config that quietly does that.
  const phpOnly = firstDir !== undefined && locales.length === 0

  return {
    config: {
      localeDirs: localeDirs.length > 0 ? localeDirs : ['locales'],
      defaultLocale: guessed ?? 'en',
      ...(locales.length > 0 ? { locales } : {}),
    },
    ...(localeDirs.length === 0
      ? { note: 'No framework and no locale directory found. Wrote a template — set localeDirs and defaultLocale before running other commands.' }
      : {}),
    ...(phpOnly
      ? { note: `Found ${firstDir} but no JSON locale files in it. Flat PHP locale files are not resolvable by the generic adapter — see the-i18n-kit#308.` }
      : {}),
  }
}

export async function initProjectConfig(opts: {
  projectDir?: string
  force?: boolean
  /** Resolve the config without touching disk. */
  dryRun?: boolean
}): Promise<InitProjectConfigResult> {
  const dir = resolve(opts.projectDir ?? process.cwd())
  const configPath = join(dir, CONFIG_FILENAME)
  const exists = existsSync(configPath)

  if (exists && !opts.force) {
    throw new ToolError(
      `${CONFIG_FILENAME} already exists at ${configPath}. `
      + 'Pass --force to overwrite it, or --json to see what would be written.',
      'CONFIG_EXISTS',
    )
  }

  const carried = await carryLocaleConfig(configPath)
  const match = await detectFrameworkMatch(dir)
  const { config, detected } = match && match.adapter.name !== GENERIC_ADAPTER
    ? detectedProject(match, carried)
    : await genericProject(dir, carried, match)

  // A generated config the tool would then reject is a bug in init, not
  // something to hand the user.
  const validation = validateProjectConfig(config)
  if (!validation.ok) {
    throw new ToolError(
      `init generated a config that fails its own schema: ${validation.error}`,
      'INVALID_GENERATED_CONFIG',
    )
  }

  const result: InitProjectConfigResult = {
    config,
    detected,
    configPath: relative(dir, configPath).split(sep).join('/'),
    written: false,
    overwritten: false,
  }

  if (opts.dryRun) return result

  // sortKeys: false — a config reads best in authored order ($schema first,
  // scaffolding after), not alphabetised.
  await writeLocaleFile(configPath, config as unknown as Record<string, unknown>, {
    indent: '  ',
    sortKeys: false,
  })
  log.info(`Wrote ${CONFIG_FILENAME} (${detected.label}${detected.confidence > 0 ? `, confidence ${detected.confidence}` : ''})`)
  return { ...result, written: true, overwritten: exists }
}
