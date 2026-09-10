import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { FrameworkAdapter, LocaleFileFormat } from '../types'
import type { I18nConfig, LocaleDefinition, LocaleDir, ProjectConfig } from '../../config/types'
import { loadProjectConfig } from '../../config/project-config'
import { detectFormatInDir, getFormat } from '../../io/formats'
import { log } from '../../utils/logger'
import { ConfigError } from '../../utils/errors'

/**
 * Where a project that declares no `localeDirs` plausibly keeps its locale
 * files, probed in order. Deliberately short and framework-neutral: it holds
 * the layouts a Vue, Svelte or plain-bundler project ends up with by
 * convention, and none that belong to an adapter of their own (`lang/` is
 * Laravel's, `messages/` and `public/locales` are React's).
 *
 * Ordered the way `init` probes the same layouts, so that a project with two
 * of them resolves to the directory init writes down rather than to a
 * different one.
 */
const COMMON_LOCALE_DIRS = [
  'locales',
  'src/locales',
  'i18n/locales',
  'src/i18n/locales',
  'src/i18n',
]

/** A declaration beats every other adapter's signals. */
const DECLARED = 10

/**
 * A probed directory beats nothing: every framework adapter scores at least
 * this much on a project it recognizes, so discovery only decides projects no
 * adapter claims.
 */
const DISCOVERED = 1

export class GenericAdapter implements FrameworkAdapter {
  readonly name = 'generic'
  readonly label = 'Generic'
  readonly localeFileFormat: LocaleFileFormat = 'json'

  // No memo of its own: the adapter is registered once for the life of the
  // process, so anything remembered here would outlive a cache clear and keep
  // reporting a config the user has already edited. A caller that has already
  // read the declaration hands it down instead; only one that has not makes
  // this read the two files itself.
  async detect(projectDir: string, projectConfig?: ProjectConfig | null): Promise<number> {
    const config = projectConfig === undefined ? await loadProjectConfig(projectDir) : projectConfig
    if (config?.localeDirs && config.localeDirs.length > 0 && config.defaultLocale) {
      return DECLARED
    }

    const probed = await findLocaleDir(projectDir)
    return probed ? DISCOVERED : 0
  }

  async resolve(projectDir: string, projectConfig: ProjectConfig | null): Promise<I18nConfig> {
    const localeDirs = await resolveLocaleDirs(projectDir, projectConfig)

    for (const dir of localeDirs) {
      if (!existsSync(dir.path)) {
        throw new ConfigError(`Locale directory does not exist: ${dir.path}`)
      }
    }

    // Non-empty by resolveLocaleDirs, which throws rather than returning none.
    const detectedFormat = await detectFormatInDir(localeDirs[0]!.path) ?? 'json'
    const discoveredLocales = projectConfig?.locales ?? await discoverLocales(localeDirs, detectedFormat)

    const [firstLocale] = discoveredLocales
    if (firstLocale === undefined) {
      throw new ConfigError(
        `No locale files found in ${localeDirs.map(d => d.path).join(', ')}`,
      )
    }

    // Declared beats discovered. Falling through to the first locale is
    // alphabetical order dressed up as a decision, so it is the last resort.
    const defaultLocale = projectConfig?.defaultLocale ?? firstLocale

    const locales: LocaleDefinition[] = await Promise.all(discoveredLocales.map(async code => ({
      code,
      language: code,
      // `file` names the flat file to read and write. A namespaced PHP layout
      // (Laravel's lang/<locale>/<namespace>.php) has no single file, and
      // resolveLocaleEntries discovers those from disk instead.
      ...(await flatFileFor(localeDirs, code, detectedFormat)),
    })))

    log.info(
      `Generic adapter: ${locales.length} locale(s), format=${detectedFormat}, `
      + `dirs=${localeDirs.map(d => d.layer).join(', ')}`,
    )

    return {
      rootDir: projectDir,
      defaultLocale,
      fallbackLocale: { default: [defaultLocale] },
      locales,
      localeDirs,
      layerRootDirs: [projectDir],
      ...(projectConfig ? { projectConfig } : {}),
      localeFileFormat: detectedFormat,
      apps: [{ name: 'default', rootDir: projectDir, layers: localeDirs.map(d => d.layer) }],
    }
  }
}

/**
 * The directories to read, declared first: a project that writes down where
 * its locale files are has settled the question, and probing is only for the
 * one that has not.
 */
async function resolveLocaleDirs(projectDir: string, projectConfig: ProjectConfig | null): Promise<LocaleDir[]> {
  const declared = projectConfig?.localeDirs ?? []
  if (declared.length > 0) {
    return declared.map(entry => (typeof entry === 'string'
      ? { path: resolve(projectDir, entry), layer: 'default', layerRootDir: projectDir }
      : { path: resolve(projectDir, entry.path), layer: entry.layer, layerRootDir: projectDir }))
  }

  const probed = await findLocaleDir(projectDir)
  if (!probed) {
    throw new ConfigError(
      'GenericAdapter requires both "localeDirs" and "defaultLocale" in .i18n-mcp.json '
      + `when the locale files are not in a conventional directory. Looked in ${projectDir} for: `
      + `${COMMON_LOCALE_DIRS.join(', ')}.`,
    )
  }

  // One probed directory, one layer. Several directories are a layout only the
  // project can describe, so `localeDirs` names them and their layers.
  return [{ path: probed, layer: 'default', layerRootDir: projectDir }]
}

/**
 * The first conventional directory that holds locales, by the same rule that
 * resolves one. Judging a candidate on its contents rather than its existence
 * is what keeps an empty `src/i18n` beside a populated `locales` from claiming
 * a project and then resolving to nothing.
 *
 * Runs on every project the CLI is pointed at, including ones this adapter
 * will lose, so it reads directory entries and nothing else — no project code.
 */
async function findLocaleDir(projectDir: string): Promise<string | null> {
  for (const candidate of COMMON_LOCALE_DIRS) {
    const path = join(projectDir, candidate)
    if (!existsSync(path)) continue

    const format = await detectFormatInDir(path)
    if (!format) continue

    const dir: LocaleDir = { path, layer: 'default', layerRootDir: projectDir }
    if ((await discoverLocales([dir], format)).length > 0) return path
  }
  return null
}

/**
 * The flat file for a locale, when there is one. Absent for a namespaced
 * layout, where each namespace is its own file and no single name applies.
 */
async function flatFileFor(
  localeDirs: Array<{ path: string }>,
  code: string,
  format: LocaleFileFormat,
): Promise<{ file?: string }> {
  for (const ext of getFormat(format).extensions) {
    for (const dir of localeDirs) {
      if (existsSync(join(dir.path, `${code}${ext}`))) return { file: `${code}${ext}` }
    }
  }
  return {}
}

const NON_LOCALE_NAMES = new Set([
  'index', 'readme', 'config', 'vendor', 'node_modules', '.git', '.DS_Store',
])

async function discoverLocales(localeDirs: LocaleDir[], format: LocaleFileFormat): Promise<string[]> {
  const codes = new Set<string>()

  for (const dir of localeDirs) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir.path, { withFileTypes: true })
    }
    catch {
      continue
    }

    const extensions = getFormat(format).extensions

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const flatExt = extensions.find(ext => entry.name.toLowerCase().endsWith(ext))
      if (entry.isFile() && flatExt) {
        const code = entry.name.slice(0, -flatExt.length)
        if (!NON_LOCALE_NAMES.has(code.toLowerCase())) {
          codes.add(code)
        }
      }
      else if (entry.isDirectory() && !NON_LOCALE_NAMES.has(entry.name.toLowerCase())) {
        const subFiles = await readdir(join(dir.path, entry.name)).catch(() => [] as string[])
        if (subFiles.some(f => extensions.some(ext => f.toLowerCase().endsWith(ext)))) {
          codes.add(entry.name)
        }
      }
    }
  }

  return [...codes].sort()
}
