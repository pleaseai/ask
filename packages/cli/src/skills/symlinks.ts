import fs from 'node:fs'
import path from 'node:path'

/**
 * Create a relative symlink at `linkPath` pointing to `targetPath`. The parent
 * directory of `linkPath` is created on demand.
 *
 * If a symlink already exists and resolves to the exact same target, this is a
 * no-op. If the link exists with a different target, or if a real file/dir
 * sits at the path, we throw unless `force` is set — in which case the
 * existing entry is removed and the new link created.
 */
export interface LinkSkillOptions {
  linkPath: string
  targetPath: string
  force?: boolean
}

export function linkSkill(opts: LinkSkillOptions): void {
  const { linkPath, targetPath, force } = opts
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })

  const relTarget = path.relative(path.dirname(linkPath), targetPath)

  const lstat = safeLstat(linkPath)
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath)
      if (current === relTarget) {
        return // identical — no-op
      }
      if (!force) {
        throw new SymlinkConflictError(linkPath, `symlink points to '${current}', expected '${relTarget}'`)
      }
      fs.unlinkSync(linkPath)
    }
    else {
      if (!force) {
        throw new SymlinkConflictError(linkPath, 'a non-symlink entry already exists')
      }
      fs.rmSync(linkPath, { recursive: true, force: true })
    }
  }

  fs.symlinkSync(relTarget, linkPath, 'dir')
}

/**
 * Remove `linkPath` iff it is a symlink whose target matches `expectedTarget`.
 * Protects user-authored skills that happen to sit under the same name.
 */
export function unlinkIfOwned(linkPath: string, expectedTarget: string): boolean {
  const lstat = safeLstat(linkPath)
  if (!lstat || !lstat.isSymbolicLink()) {
    return false
  }
  const relExpected = path.relative(path.dirname(linkPath), expectedTarget)
  const current = fs.readlinkSync(linkPath)
  if (current !== relExpected) {
    return false
  }
  fs.unlinkSync(linkPath)
  return true
}

export class SymlinkConflictError extends Error {
  constructor(public linkPath: string, reason: string) {
    super(`${linkPath}: ${reason}. Re-run with --force to overwrite.`)
    this.name = 'SymlinkConflictError'
  }
}

function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  }
  catch {
    return null
  }
}
