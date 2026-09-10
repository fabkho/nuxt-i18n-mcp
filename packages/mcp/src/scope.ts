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
 * Confinement is opt-in. A server started with neither I18N_PROJECT_DIR nor a
 * client-advertised root — `npx` on a developer's machine — accepts any
 * directory, which is what it did before there was a root to compare against.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError, canonicalPath } from '@the-i18n-kit/cli'

/** The `ToolError` code a refused `projectDir` carries. */
export const PROJECT_DIR_OUTSIDE_ROOT = 'PROJECT_DIR_OUTSIDE_ROOT'

export class ProjectScope {
  readonly #configuredRoot: string | undefined
  #clientRoot: string | undefined
  #fetchClientRoots: (() => Promise<readonly string[]>) | undefined
  #pendingClientRoots: Promise<void> | undefined

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const configured = env.I18N_PROJECT_DIR
    this.#configuredRoot = configured === undefined || configured === '' ? undefined : configured
  }

  /**
   * The directory to use before any client has had a chance to advertise
   * roots — startup work that cannot wait for a connection, such as resolving
   * the translation backend's base URL from the project config.
   */
  get startupDir(): string {
    return this.#configuredRoot ?? process.cwd()
  }

  /** The confinement boundary, or undefined when nothing configured one. */
  get root(): string | undefined {
    return this.#configuredRoot ?? this.#clientRoot
  }

  /**
   * Take the client's roots as the default directory and the boundary, unless
   * the operator already named one.
   *
   * I18N_PROJECT_DIR wins when both exist: it is set on the server process by
   * whoever installed the server, while roots are whatever the host happens to
   * have open — often an editor workspace holding several repositories, which
   * as a boundary is wider than the operator asked for.
   *
   * Only the first root is taken. The tools resolve one project at a time, and
   * a second root would have to become a second boundary to mean anything.
   */
  offerClientRoots(fetchRoots: () => Promise<readonly string[]>): void {
    if (this.#configuredRoot !== undefined) return
    this.#fetchClientRoots = fetchRoots
  }

  /**
   * The directory an operation runs in, refusing one outside the root.
   *
   * Async because the roots fetch is a round trip to the client. It runs on
   * first use rather than at connect time: a handler is the first moment the
   * connection is certainly past initialization, and the only moment the
   * answer is needed. Every later call awaits the same in-flight promise, so
   * no two of them can see different boundaries.
   */
  async projectDirFor(requested: string | undefined): Promise<string> {
    await this.#settleClientRoots()

    const { root } = this
    const dir = requested ?? root ?? process.cwd()
    if (root !== undefined) assertWithinRoot(dir, root)
    return dir
  }

  async #settleClientRoots(): Promise<void> {
    const fetchRoots = this.#fetchClientRoots
    if (fetchRoots === undefined) return

    this.#pendingClientRoots ??= fetchRoots()
      .then((roots) => { this.#clientRoot = roots[0] })
      // A client that cannot answer leaves the server exactly as unconfined as
      // one that advertises nothing; the fetcher reports the failure itself.
      .catch(() => {})
    await this.#pendingClientRoots
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
