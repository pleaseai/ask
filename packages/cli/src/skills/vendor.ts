import fs from 'node:fs'
import path from 'node:path'

export const VENDOR_ROOT = '.ask/skills'

export interface VendorResult {
  /** Absolute path to `.ask/skills/<specKey>/`. */
  vendorDir: string
  /** Skill basenames that were copied in. */
  skillNames: string[]
}

/**
 * Copy each source skill directory into `.ask/skills/<specKey>/<basename>/`.
 *
 * Refresh-safe: if `.ask/skills/<specKey>/` already exists it is wiped and
 * replaced, so a re-install leaves no stale files. The new contents are
 * staged under a sibling `.<specKey>.tmp` directory first and renamed into
 * place on success, so a mid-copy crash cannot leave a half-populated
 * vendor directory.
 *
 * Skill basenames collide only when the caller passes two source paths
 * with the same final segment. In that case the later copy wins — the
 * caller is responsible for deduping if needed.
 */
export function vendorSkills(projectDir: string, specKey: string, sources: string[]): VendorResult {
  const root = path.join(projectDir, VENDOR_ROOT)
  const vendorDir = path.join(root, specKey)
  fs.mkdirSync(root, { recursive: true })

  const staging = path.join(root, `.${specKey}.tmp`)
  if (fs.existsSync(staging)) {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  fs.mkdirSync(staging, { recursive: true })

  const skillNames: string[] = []
  for (const source of sources) {
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      continue
    }
    const name = path.basename(source)
    const target = path.join(staging, name)
    fs.cpSync(source, target, { recursive: true })
    skillNames.push(name)
  }

  if (fs.existsSync(vendorDir)) {
    fs.rmSync(vendorDir, { recursive: true, force: true })
  }
  fs.renameSync(staging, vendorDir)

  return { vendorDir, skillNames }
}

export function removeVendorDir(projectDir: string, specKey: string): void {
  const vendorDir = path.join(projectDir, VENDOR_ROOT, specKey)
  if (fs.existsSync(vendorDir)) {
    fs.rmSync(vendorDir, { recursive: true, force: true })
  }
}
