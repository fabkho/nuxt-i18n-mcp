/**
 * Where an operation is allowed to run.
 *
 * Every tool takes an absolute `projectDir` from its caller, and the caller is
 * an agent acting on text it may have just read out of the project. The
 * report-path guard in core is relative to whatever directory the caller
 * named, so it bounds traversal inside one request and says nothing about
 * which directory that is: without a boundary, `write_translations` or
 * `find_orphan_keys` with `remove` can be aimed at any path the server process
 * can write. A configured root is that boundary.
 *
 * Confinement is opt-in. A server started with no I18N_PROJECT_DIR — `npx` on
 * a developer's machine — accepts any directory, which is what it did before
 * there was a root to compare against.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError, canonicalPath } from '@the-i18n-kit/cli'

/** The `ToolError` code a refused `projectDir` carries. */
export const PROJECT_DIR_OUTSIDE_ROOT = 'PROJECT_DIR_OUTSIDE_ROOT'

export class ProjectScope {
  readonly #configuredRoot: string | undefined

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const configured = env.I18N_PROJECT_DIR
    this.#configuredRoot = configured === undefined || configured === '' ? undefined : configured
  }

  /**
   * The directory to use for startup work that runs before any handler does —
   * resolving the translation backend's base URL from the project config.
   */
  get startupDir(): string {
    return this.#configuredRoot ?? process.cwd()
  }

  /** The confinement boundary, or undefined when nothing configured one. */
  get root(): string | undefined {
    return this.#configuredRoot
  }

  /** The directory an operation runs in, refusing one outside the root. */
  projectDirFor(requested: string | undefined): string {
    const { root } = this
    const dir = requested ?? root ?? process.cwd()
    if (root !== undefined) assertWithinRoot(dir, root)
    return dir
  }
}

function assertWithinRoot(dir: string, root: string): void {
  const candidate = canonicalPath(dir)
  const canonicalRoot = canonicalPath(root)
  // Both spellings of the root: a directory that does not exist yet cannot be
  // resolved through symlinks, so `candidate` is still the path as written and
  // comparing it only against the resolved root would refuse it for the wrong
  // reason. A symlink that does exist is resolved, so one planted inside the
  // root but pointing out of it fails both comparisons.
  if (isWithin(candidate, canonicalRoot) || isWithin(candidate, resolve(root))) return

  throw new ToolError(
    `projectDir "${dir}" resolves to "${candidate}", which is outside the configured project root `
    + `"${canonicalRoot}". Pass a directory inside that root, or start the server with `
    + 'I18N_PROJECT_DIR set to the directory it should work in.',
    PROJECT_DIR_OUTSIDE_ROOT,
  )
}

/** The root counts as within itself — confinement names a tree, not its contents. */
function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
