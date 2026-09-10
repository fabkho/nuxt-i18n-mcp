import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../../..')
const binPath = resolve(import.meta.dirname, '../../dist/bin.js')

/**
 * Behavioural tests for the shipped CI templates (#254): the job scripts are
 * extracted from the real YAML and executed against the real CLI, so the
 * exit-code contract is verified by running it rather than by grepping the
 * template. Requires a built dist (CI builds before testing).
 *
 * A `the-i18n-cli` shim on PATH stands in for the globally installed CLI that
 * the templates' before_script would provide.
 */

interface Run { stdout: string, stderr: string, code: number }

/**
 * GitLab job scripts run under busybox sh in the default alpine image, so they
 * are exercised with a POSIX shell — running them under bash would hide
 * bash-isms the runner would reject. `dash` is preferred where present because
 * macOS `/bin/sh` is bash in POSIX mode and still accepts constructs a real
 * POSIX shell rejects (`set -o pipefail` among them), which would let a
 * portability regression pass locally and fail on CI. The action's steps
 * declare `shell: bash` and use bash arrays, so those are exercised with bash.
 */
const posixShell = existsSync('/bin/dash') ? '/bin/dash' : 'sh'
async function runScript(
  script: string,
  cwd: string,
  env: Record<string, string>,
  binDir: string,
  shell: string = posixShell,
): Promise<Run> {
  const scriptPath = join(cwd, '.job.sh')
  await writeFile(scriptPath, script)
  try {
    const { stdout, stderr } = await execFileAsync(shell, [scriptPath], {
      cwd,
      env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string, stderr?: string, code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

interface Job { script?: string[], variables?: Record<string, string>, extends?: string }

/**
 * The job as GitLab assembles it: `extends` is followed, hash keys merged and
 * list keys replaced. The two report jobs share one script through a hidden
 * base, so a test that read the job's own keys would find nothing to run.
 */
async function readJob(name: string): Promise<Required<Pick<Job, 'script' | 'variables'>>> {
  const raw = await readFile(join(repoRoot, 'gitlab-ci.yml'), 'utf-8')
  const doc = parse(raw) as Record<string, Job>

  const chain: Job[] = []
  for (let job = doc[name]; job; job = job.extends ? doc[job.extends] : undefined) {
    chain.unshift(job)
  }
  if (chain.length === 0) throw new Error(`job ${name} not found in gitlab-ci.yml`)

  let script: string[] | undefined
  let variables: Record<string, string> = {}
  for (const link of chain) {
    variables = { ...variables, ...link.variables }
    script = link.script ?? script
  }
  if (!script) throw new Error(`job ${name} resolves to no script`)
  return { script, variables }
}

async function jobScript(name: string): Promise<string> {
  return (await readJob(name)).script.join('\n')
}

/**
 * The `variables:` block, which GitLab exports into the job. Taken from the
 * template rather than restated here: the scripts run under `set -u`, so a
 * variable declared there but missing from a test aborts the script silently
 * mid-run, which reads as a template bug rather than a fixture gap.
 */
async function jobVariables(name: string): Promise<Record<string, string>> {
  return (await readJob(name)).variables
}

describe('gitlab-ci.yml job scripts, executed', () => {
  let projectDir: string
  let binDir: string

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'i18n-tpl-exec-'))

    // Shim standing in for the globally installed CLI.
    binDir = join(projectDir, '.bin')
    await mkdir(binDir, { recursive: true })
    const shim = join(binDir, 'the-i18n-cli')
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${binPath}" "$@"\n`)
    await chmod(shim, 0o755)

    await mkdir(join(projectDir, 'locales'), { recursive: true })
    await mkdir(join(projectDir, 'src'), { recursive: true })
    await writeFile(
      join(projectDir, '.i18n-mcp.json'),
      JSON.stringify({ defaultLocale: 'en', localeDirs: ['locales'], locales: ['en'] }),
    )
    await writeFile(
      join(projectDir, 'locales/en.json'),
      JSON.stringify({ common: { greeting: 'Hello', farewell: 'Goodbye' } }),
    )
    // Only common.greeting is referenced, so common.farewell is an orphan.
    await writeFile(join(projectDir, 'src/app.ts'), `export const a = t('common.greeting')\n`)
  })

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  async function scanEnv(job: string, overrides: Record<string, string> = {}) {
    return { ...await jobVariables(job), ...overrides }
  }

  describe('.i18n-cleanup', () => {
    it('exits 0 on findings when the gate is not requested', async () => {
      const run = await runScript(await jobScript('.i18n-cleanup'), projectDir, await scanEnv('.i18n-cleanup'), binDir)

      expect(run.code).toBe(0)
      // The findings are still reported — the gate governs the outcome, not the report.
      expect(run.stdout).toContain('"orphanCount": 1')
    })

    it('exits 2 on findings when I18N_FAIL_ON_ORPHANS is true', async () => {
      const env = await scanEnv('.i18n-cleanup', { I18N_FAIL_ON_ORPHANS: 'true' })
      const run = await runScript(await jobScript('.i18n-cleanup'), projectDir, env, binDir)

      expect(run.code).toBe(2)
      expect(run.stdout).toContain('"orphanCount": 1')
    })

    it('still writes the Code Quality artifact when the gate trips', async () => {
      const env = await scanEnv('.i18n-cleanup', { I18N_FAIL_ON_ORPHANS: 'true' })
      await runScript(await jobScript('.i18n-cleanup'), projectDir, env, binDir)

      const report = JSON.parse(await readFile(join(projectDir, 'gl-codequality.json'), 'utf-8'))
      expect(Array.isArray(report)).toBe(true)
      expect(report.length).toBeGreaterThan(0)
    })

    // Exit 1 and exit 2 must not look alike: allow_failure.exit_codes: [2]
    // only tells warnings from failures if a broken run exits something else.
    it('exits 1, not 2, when the scan itself fails', async () => {
      const brokenDir = await mkdtemp(join(tmpdir(), 'i18n-tpl-broken-'))
      const env = await scanEnv('.i18n-cleanup', { I18N_FAIL_ON_ORPHANS: 'true' })
      const run = await runScript(await jobScript('.i18n-cleanup'), brokenDir, env, binDir)

      expect(run.code).toBe(1)
      expect(run.stdout).toContain('CONFIG_ERROR')
      await rm(brokenDir, { recursive: true, force: true })
    })
  })

  // Same script, second command: `check` gates unconditionally, so a project
  // with nothing undefined has to come back green through the shared job.
  describe('.i18n-check', () => {
    it('exits 0 when every used key resolves', async () => {
      const run = await runScript(await jobScript('.i18n-check'), projectDir, await scanEnv('.i18n-check'), binDir)

      expect(run.code).toBe(0)
      expect(run.stdout).toContain('"undefinedCount": 0')
    })
  })

  /**
   * The translate job needs a real provider, so its CLI call is stubbed. Its
   * STATUS branching is the part under test, and I18N_DRY_RUN keeps the run
   * short of the git and push stages that follow it — except in the commit-path
   * test, which needs those stages to prove the gate outlives them.
   */
  describe('.i18n-translate STATUS branching', () => {
    /** The translation memory the CLI wrote, as the job finds it on disk. */
    type Memory = 'absent' | 'written' | 'ignored'

    const MEMORY_FILE = '.i18n-kit.lock.json'

    /**
     * Stands the job up on a repo whose locale file has uncommitted changes,
     * as it would be after a real translate wrote to it. `git push` is shimmed
     * to succeed (there is no remote) while everything before it stays real, so
     * the commit is genuinely made rather than simulated.
     */
    async function seedRepoWithTranslations(dir: string, stubBin: string, memory: Memory): Promise<void> {
      const git = { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }
      await execFileAsync('git', ['init', '-q'], git)
      await mkdir(join(dir, 'i18n/locales'), { recursive: true })
      await writeFile(join(dir, 'i18n/locales/de.json'), '{}\n')
      await execFileAsync('git', ['add', 'i18n/locales/de.json'], git)
      if (memory === 'ignored') {
        await writeFile(join(dir, '.gitignore'), '.i18n-kit.lock.json\n')
        await execFileAsync('git', ['add', '.gitignore'], git)
      }
      await execFileAsync('git', ['commit', '-q', '-m', 'root'], git)
      await writeFile(join(dir, 'i18n/locales/de.json'), '{"a":"Hallo"}\n')
      // What a real run leaves beside the translations it wrote.
      if (memory !== 'absent') {
        await writeFile(join(dir, MEMORY_FILE), '{"version":2,"sourceLocale":"de","entries":{}}\n')
      }

      const realGit = (await execFileAsync('sh', ['-c', 'command -v git'])).stdout.trim()
      await writeFile(
        join(stubBin, 'git'),
        `#!/bin/sh\nif [ "$1" = push ]; then echo "push $2 $3"; exit 0; fi\nexec '${realGit}' "$@"\n`,
      )
      await chmod(join(stubBin, 'git'), 0o755)
    }

    /** The stub records the args it was handed, so flag wiring is observable. */
    async function runTranslate(
      stubResult: string,
      stubExit: number,
      env: Record<string, string> = {},
      seedRepo = false,
      memory: Memory = 'absent',
    ): Promise<Run & { args: string, log: string, files: string }> {
      const dir = await mkdtemp(join(tmpdir(), 'i18n-tpl-translate-'))
      const stubBin = join(dir, '.bin')
      await mkdir(stubBin, { recursive: true })
      const shim = join(stubBin, 'the-i18n-cli')
      const argsFile = join(dir, 'args.txt')
      await writeFile(
        shim,
        `#!/bin/sh\nprintf '%s ' "$@" > '${argsFile}'\ncat <<'JSON'\n${stubResult}\nJSON\nexit ${stubExit}\n`,
      )
      await chmod(shim, 0o755)
      if (seedRepo) await seedRepoWithTranslations(dir, stubBin, memory)

      const run = await runScript(await jobScript('.i18n-translate'), dir, {
        ...await jobVariables('.i18n-translate'),
        CI_COMMIT_REF_NAME: 'feat/translate',
        CI_SERVER_HOST: 'gitlab.test',
        CI_PROJECT_PATH: 'group/project',
        CI_JOB_TOKEN: 'stub',
        I18N_PROVIDER: 'openai',
        I18N_MODEL: 'stub-model',
        I18N_API_KEY: 'secret-key',
        I18N_DRY_RUN: 'true',
        ...env,
      }, stubBin)

      const args = existsSync(argsFile) ? await readFile(argsFile, 'utf-8') : ''
      const log = seedRepo
        ? (await execFileAsync('git', ['log', '--format=%s'], { cwd: dir })).stdout
        : ''
      const files = seedRepo
        ? (await execFileAsync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir })).stdout
        : ''
      await rm(dir, { recursive: true, force: true })
      return { ...run, args, log, files }
    }

    it('exits 0 on a successful run', async () => {
      const run = await runTranslate(JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } }), 0)

      expect(run.code).toBe(0)
      // The CLI's own result reaches the job log unaltered.
      expect(run.stdout).toContain('"totalTranslated":3')
    })

    it('exits 1 and explains the failure when the run itself failed', async () => {
      const run = await runTranslate(JSON.stringify({ error: { code: 'CONFIG_ERROR', message: 'nope' } }), 1)

      expect(run.code).toBe(1)
      expect(run.stdout).toContain('translate failed (exit 1)')
    })

    it('exits 2 on a tripped gate, distinctly from a failure', async () => {
      const run = await runTranslate(JSON.stringify({
        summary: { totalTranslated: 5, totalFailed: 0 },
        gatesTripped: [{ name: 'fail-on-missing', observed: 12, threshold: 0 }],
      }), 2)

      expect(run.code).toBe(2)
      expect(run.stdout).toContain('"fail-on-missing"')
      expect(run.stdout).not.toContain('translate failed')
    })

    it('trusts the exit code over the counts when they disagree', async () => {
      const failLooking = JSON.stringify({ summary: { totalTranslated: 0, totalFailed: 9 } })

      expect((await runTranslate(failLooking, 0)).code).toBe(0)
    })

    // The gate must outlive the steps that follow it rather than short-circuit
    // them. Exiting at the status check threw away whatever the run did
    // translate — 54 keys discarded because 3 failed, seen on a real project.
    // Proven here by the job reaching a later step before it goes red.
    it('reports the gate after continuing, not at the status check', async () => {
      const partial = JSON.stringify({
        summary: { totalTranslated: 54, totalFailed: 3 },
        gatesTripped: [{ name: 'fail-on-failed', observed: 3, threshold: 0 }],
      })
      const run = await runTranslate(partial, 2)

      expect(run.code).toBe(2)
      expect(run.stdout).toContain('Dry run complete')
    })

    // The case the dry run cannot reach: with a gate tripped, the work the run
    // did produce must still be committed and pushed before the job goes red.
    it('commits and pushes the partial result, then exits 2', async () => {
      const partial = JSON.stringify({
        summary: { totalTranslated: 54, totalFailed: 3 },
        gatesTripped: [{ name: 'fail-on-failed', observed: 3, threshold: 0 }],
      })
      const run = await runTranslate(partial, 2, { I18N_DRY_RUN: 'false' }, true)

      expect(run.code).toBe(2)
      expect(run.log).toContain('i18n: auto-translate missing keys')
      expect(run.stdout).toContain('Pushed to feat/translate')
    })

    // The memory is the record of what each translation was made from. Left out
    // of the commit it goes with the runner, and the next run — reading no
    // memory — reports nothing as stale however far the sources have moved.
    it('commits the translation memory beside the translations it describes', async () => {
      const clean = JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } })
      const run = await runTranslate(clean, 0, { I18N_DRY_RUN: 'false' }, true, 'written')

      expect(run.code).toBe(0)
      expect(run.files).toContain('.i18n-kit.lock.json')
      expect(run.files).toContain('i18n/locales/de.json')
    })

    it('commits the translations alone when no memory was written', async () => {
      const clean = JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } })
      const run = await runTranslate(clean, 0, { I18N_DRY_RUN: 'false' }, true, 'absent')

      expect(run.code).toBe(0)
      expect(run.files).toContain('i18n/locales/de.json')
      expect(run.files).not.toContain('.i18n-kit.lock.json')
    })

    // A project that ignores the memory has decided not to keep it; staging it
    // anyway is the one way `git add` can fail the job outright.
    it('leaves an ignored translation memory out of the commit, and still succeeds', async () => {
      const clean = JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } })
      const run = await runTranslate(clean, 0, { I18N_DRY_RUN: 'false' }, true, 'ignored')

      expect(run.code).toBe(0)
      expect(run.files).toContain('i18n/locales/de.json')
      expect(run.files).not.toContain('.i18n-kit.lock.json')
    })

    it('requests the partial-failure gate only when asked', async () => {
      const clean = JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } })

      expect((await runTranslate(clean, 0)).args).not.toContain('--fail-on-failed')
      expect((await runTranslate(clean, 0, { I18N_FAIL_ON_FAILED: 'true' })).args)
        .toContain('--fail-on-failed')
    })

    // The gate is opt-in, so the ungated run is the one most projects get. Its
    // only trace of a partial failure is the CLI's own summary.message, which
    // the job surfaces by printing the result rather than by parsing it.
    it('surfaces the CLI guidance on a partial failure it does not gate on', async () => {
      const partial = JSON.stringify({
        summary: {
          totalTranslated: 795,
          totalFailed: 141,
          message: '141 key(s) failed to translate (locales: da-DK, fr-FR). Those keys remain missing — re-run to retry them.',
        },
      })
      const run = await runTranslate(partial, 0)

      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Those keys remain missing')
    })

    // The key belongs in the environment, not in argv: the CLI resolves it from
    // the provider's own variable, and a command line is readable by `ps`.
    it('hands the API key to the CLI through the environment', async () => {
      const clean = JSON.stringify({ summary: { totalTranslated: 1, totalFailed: 0 } })

      expect((await runTranslate(clean, 0)).args).not.toContain('secret-key')
    })
  })
})

/**
 * The action's translate step needs a real provider, so it cannot be driven
 * end-to-end here. Its exit-code branching can be: a stub CLI returns a chosen
 * result and exit code, and the step must react to the code rather than to the
 * counts in the payload — including when the two disagree.
 */
describe('action.yml translate step, executed against a stub CLI', () => {
  let workDir: string

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'i18n-action-exec-'))
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  /** Input values the runner would resolve the step's `env:` expressions to. */
  const ACTION_INPUTS: Record<string, string> = {
    provider: 'openai',
    model: 'stub-model',
    api_key: 'stub-key',
    layer: 'root',
    batch_size: '50',
    locales: '',
    source_locale: '',
    keys: '',
    dry_run: 'false',
    fail_on_failed: 'false',
  }

  /**
   * The step's script plus the environment it declares. Both come from the
   * manifest: the script runs under `set -u`, so an env var the step adds but a
   * test does not know about would abort it mid-run.
   */
  async function translateStep(): Promise<{ run: string, env: Record<string, string> }> {
    const raw = await readFile(join(repoRoot, 'action.yml'), 'utf-8')
    const doc = parse(raw) as {
      runs: { steps: Array<{ id?: string, run?: string, env?: Record<string, string> }> }
    }
    const step = doc.runs.steps.find(s => s.id === 'translate')
    if (!step?.run) throw new Error('translate step not found in action.yml')

    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(step.env ?? {})) {
      const input = /\$\{\{\s*inputs\.(\w+)\s*\}\}/.exec(value)?.[1]
      if (input === undefined) throw new Error(`env ${name} is not an action input: ${value}`)
      const resolved = ACTION_INPUTS[input]
      if (resolved === undefined) throw new Error(`no test value for input ${input}`)
      env[name] = resolved
    }
    return { run: step.run, env }
  }

  async function runStep(
    stubResult: string,
    stubExit: number,
    inputs: Record<string, string> = {},
  ): Promise<Run & { outputs: string }> {
    const dir = await mkdtemp(join(workDir, 'case-'))
    const binDir = join(dir, '.bin')
    await mkdir(binDir, { recursive: true })
    const shim = join(binDir, 'the-i18n-cli')
    await writeFile(shim, `#!/bin/sh\ncat <<'JSON'\n${stubResult}\nJSON\nexit ${stubExit}\n`)
    await chmod(shim, 0o755)

    const outputFile = join(dir, 'github_output')
    await writeFile(outputFile, '')

    const step = await translateStep()
    const run = await runScript(step.run, dir, {
      ...step.env,
      ...inputs,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: dir,
    }, binDir, 'bash')

    return { ...run, outputs: await readFile(outputFile, 'utf-8') }
  }

  it('succeeds when the CLI exits 0', async () => {
    const run = await runStep(JSON.stringify({ summary: { totalTranslated: 3, totalFailed: 0 } }), 0)

    expect(run.code).toBe(0)
    expect(run.outputs).toContain('translated_count=3')
    expect(run.outputs).toContain('failed_count=0')
  })

  it('counts what a dry run would have translated', async () => {
    const run = await runStep(JSON.stringify({ summary: { totalWouldTranslate: 7 } }), 0, { DRY_RUN: 'true' })

    expect(run.code).toBe(0)
    expect(run.outputs).toContain('translated_count=7')
  })

  it('propagates exit 1 as a run failure', async () => {
    const run = await runStep(JSON.stringify({ error: { code: 'CONFIG_ERROR', message: 'nope' } }), 1)

    expect(run.code).toBe(1)
    expect(run.stdout).toContain('translate failed (exit 1)')
  })

  // A gate is a finding, not a broken run: the step passes the CLI's exit 2
  // straight through, and the counts are written before it does — a follow-up
  // step guarded with `if: '!cancelled()'` still commits what the run produced.
  it('propagates a tripped gate as exit 2, counts written first', async () => {
    const run = await runStep(JSON.stringify({
      summary: { totalTranslated: 5, totalFailed: 0 },
      gatesTripped: [{ name: 'fail-on-missing', observed: 12, threshold: 0 }],
    }), 2)

    expect(run.code).toBe(2)
    expect(run.outputs).toContain('translated_count=5')
    expect(run.stdout).not.toContain('translate failed')
  })

  // The old implementation decided from these counts, so a payload whose
  // counts and exit code disagree is exactly what would regress.
  it('trusts the exit code over the counts when they disagree', async () => {
    const failLooking = JSON.stringify({ summary: { totalTranslated: 0, totalFailed: 9 } })

    expect((await runStep(failLooking, 0)).code).toBe(0)
    expect((await runStep(JSON.stringify({ summary: { totalTranslated: 9, totalFailed: 0 } }), 1)).code).toBe(1)
  })

  it('still emits counts for the step outputs when the run failed', async () => {
    const run = await runStep(JSON.stringify({ summary: { totalTranslated: 0, totalFailed: 4 } }), 1)

    expect(run.outputs).toContain('failed_count=4')
  })

  // A payload the step cannot parse must not mask the CLI's exit code.
  it('survives a result jq cannot read', async () => {
    const run = await runStep('not json at all', 0)

    expect(run.code).toBe(0)
  })
})

describe('gitlab-ci.yml gate configuration', () => {
  async function template(): Promise<Record<string, {
    allow_failure?: { exit_codes?: number[] }
    before_script?: string[]
    script?: string[]
    variables?: Record<string, string>
    extends?: string
  }>> {
    const raw = await readFile(join(repoRoot, 'gitlab-ci.yml'), 'utf-8')
    return parse(raw) as Record<string, never>
  }

  // Both findings jobs draw the same line: findings are informational, a scan
  // that fell over is not. `check` could not do this while its findings and
  // its failures were both exit 1 (#369).
  it.each(['.i18n-cleanup', '.i18n-check'])('allows exit 2 only in %s, so a broken scan still fails it red', async (job) => {
    const doc = await template()
    const base = doc[doc[job]!.extends!]!

    expect(doc[job]!.allow_failure ?? base.allow_failure).toEqual({ exit_codes: [2] })
  })

  // allow_failure.exit_codes covers the whole job, before_script included. A
  // setup step that happened to exit 2 would be read as findings, and the job
  // would pass yellow having never run the scan it exists to run.
  it('keeps setup failures off exit 2 in every job that allowlists it', async () => {
    const doc = await template()

    const allowlisted = Object.entries(doc)
      .filter(([, job]) => job?.allow_failure?.exit_codes?.includes(2))
    expect(allowlisted.length).toBeGreaterThan(0)

    for (const [name, job] of allowlisted) {
      // The setup is inherited, so it is checked wherever the chain provides it.
      const setup = job.before_script ?? doc[job.extends ?? '']?.before_script ?? []
      expect(setup.length, `${name}: inherits no before_script`).toBeGreaterThan(0)
      for (const line of setup) {
        expect(line, `${name}: "${line}" can end the job on its own exit code`).toContain('|| exit 1')
      }
    }
  })

  it('declares the orphan gate as an opt-in variable defaulting to off', async () => {
    const doc = await template()
    const cleanup = doc['.i18n-cleanup']!

    const variables = { ...doc[cleanup.extends!]!.variables, ...cleanup.variables }
    expect(variables.I18N_FAIL_ON_ORPHANS).toBe('false')
  })

  it('never decides an outcome from a parsed count', async () => {
    // Both shipped templates, so the regression cannot come back through
    // whichever one is not under active edit.
    const gitlabDoc = await template()

    const actionRaw = await readFile(join(repoRoot, 'action.yml'), 'utf-8')
    const actionDoc = parse(actionRaw) as { runs: { steps: Array<{ name?: string, id?: string, run?: string }> } }

    const scripts: Array<[string, string]> = [
      ...Object.entries(gitlabDoc)
        .filter(([, job]) => job?.script)
        .map(([name, job]) => [`gitlab-ci.yml ${name}`, job.script!.join('\n')] as [string, string]),
      ...actionDoc.runs.steps
        .filter(step => step.run)
        .map(step => [`action.yml ${step.id ?? step.name ?? 'step'}`, step.run!] as [string, string]),
    ]

    // Both templates must be represented, or a rename could silently empty this.
    expect(scripts.some(([name]) => name.startsWith('gitlab-ci.yml'))).toBe(true)
    expect(scripts.some(([name]) => name.startsWith('action.yml'))).toBe(true)

    for (const [name, script] of scripts) {
      for (const line of script.split('\n')) {
        // A jq result may be echoed or assigned, but must never be the
        // subject of a test that exits.
        if (/\bexit\b/.test(line) && /\bjq\b/.test(line)) {
          throw new Error(`${name}: exit decided from a jq expression: ${line.trim()}`)
        }
      }
      // Counts parsed for display must not feed a numeric comparison guarding an exit.
      expect(script).not.toMatch(/if \[ "\$(ORPHAN_COUNT|TRANSLATED|FAILED)"/)
      expect(script).not.toMatch(/if \[ "\$\{?(count|failed)\}?" -(gt|eq|lt) 0 \].*\n?\s*(exit|echo "::error)/)
    }
  })
})
