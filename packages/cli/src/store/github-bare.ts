import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { consola } from 'consola'
import { githubCheckoutPath, githubDbPath } from './index.js'

/**
 * Check whether `git` is available on the system PATH.
 */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/**
 * Use a shared bare clone to materialize a specific ref into a checkout
 * directory. Returns the checkout path on success, `null` when `git` is
 * unavailable so the caller can fall back to the tar.gz download.
 *
 * Design:
 * - `<ASK_HOME>/github/db/<owner>__<repo>.git/` — shared bare clone
 * - `<ASK_HOME>/github/checkouts/<owner>__<repo>/<ref>/` — per-ref checkout
 *
 * Subsequent calls for different refs of the same repo reuse the bare
 * clone's object store, avoiding redundant network downloads.
 */
export function withBareClone(
  askHome: string,
  owner: string,
  repo: string,
  ref: string,
): string | null {
  if (!hasGit()) {
    consola.debug('git not found on PATH — falling back to tar.gz download')
    return null
  }

  const dbPath = githubDbPath(askHome, owner, repo)
  const checkoutDir = githubCheckoutPath(askHome, owner, repo, ref)

  // If checkout already exists, skip (immutable entries).
  if (fs.existsSync(checkoutDir)) {
    return checkoutDir
  }

  try {
    // Initialize bare repo if it doesn't exist yet.
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(dbPath, { recursive: true })
      execFileSync('git', ['init', '--bare'], {
        cwd: dbPath,
        stdio: 'ignore',
      })
      execFileSync(
        'git',
        ['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`],
        { cwd: dbPath, stdio: 'ignore' },
      )
    }

    // Fetch the specific ref.
    execFileSync(
      'git',
      ['fetch', 'origin', ref, '--depth=1'],
      { cwd: dbPath, stdio: 'ignore' },
    )

    // Extract the ref into the checkout directory via `git archive | tar`.
    fs.mkdirSync(checkoutDir, { recursive: true })
    const archiveBuffer = execFileSync(
      'git',
      ['archive', '--format=tar', 'FETCH_HEAD'],
      { cwd: dbPath, maxBuffer: 100 * 1024 * 1024 },
    )
    execFileSync('tar', ['xf', '-'], {
      cwd: checkoutDir,
      input: archiveBuffer,
      stdio: ['pipe', 'ignore', 'ignore'],
    })

    return checkoutDir
  }
  catch (err) {
    consola.warn(
      `Bare clone failed for ${owner}/${repo}@${ref}: `
      + `${err instanceof Error ? err.message : String(err)}. `
      + 'Falling back to tar.gz download.',
    )
    // Clean up partial checkout
    try {
      if (fs.existsSync(checkoutDir)) {
        fs.rmSync(checkoutDir, { recursive: true, force: true })
      }
    }
    catch {
      // best-effort
    }
    return null
  }
}
