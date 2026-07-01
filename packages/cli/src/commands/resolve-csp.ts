import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// Windows extensions that require a shell interpreter to launch. `ask
// search` spawns csp without a shell, so these are never resolvable.
const SHELL_ONLY_EXTS = new Set(['.cmd', '.bat', '.ps1'])

/**
 * Locate the `csp` (code-search) binary without importing it — ask
 * spawns csp as a separate process (INV-4: the ask<->csp contract is a
 * path, not an in-process API), and csp is an OPTIONAL dependency
 * (INV-3: ask must never fail solely because csp is absent).
 *
 * Resolution order (FR-B2):
 *   1. `CSP_BIN` env override — an explicit absolute/relative path.
 *   2. `csp` discovered on `PATH`.
 *   3. `null` — caller degrades gracefully to a printed recipe.
 *
 * Cross-platform (NFR-4): honours `PATHEXT` on Windows so `csp.exe` /
 * `csp.cmd` resolve, and checks the executable bit on POSIX.
 */
export interface ResolveCspDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test seam: returns true when `p` exists and is executable. */
  isExecutable?: (p: string) => boolean
}

function defaultIsExecutable(p: string): boolean {
  try {
    // X_OK is meaningless on Windows (always readable), but F_OK still
    // confirms existence; the PATHEXT loop below supplies the filter.
    accessSync(p, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

export function resolveCsp(deps: ResolveCspDeps = {}): string | null {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const isExecutable = deps.isExecutable ?? defaultIsExecutable

  // 1. Explicit override wins, no existence probe — let the spawn fail
  //    loudly if the user pointed CSP_BIN at something bogus.
  const override = env.CSP_BIN?.trim()
  if (override)
    return override

  // 2. PATH scan.
  const pathVar = env.PATH ?? env.Path ?? ''
  if (!pathVar)
    return null

  const isWin = platform === 'win32'
  // `ask search` spawns csp WITHOUT a shell (`spawnSync`, no `shell: true`),
  // and Node cannot execute `.cmd`/`.bat`/`.ps1` shims that way — resolving
  // one would return a path that then fails to launch. csp ships as a native
  // `.exe`, so probe only shell-free-executable extensions and drop shims
  // even if the user's PATHEXT lists them.
  const exts = isWin
    ? (env.PATHEXT ?? '.EXE;.COM')
        .split(';')
        .filter(Boolean)
        .filter(ext => !SHELL_ONLY_EXTS.has(ext.toLowerCase()))
    : ['']

  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir)
      continue
    for (const ext of exts) {
      const candidate = path.join(dir, `csp${ext.toLowerCase()}`)
      if (isExecutable(candidate))
        return candidate
      // Windows PATHEXT is conventionally upper-case; probe both.
      if (isWin) {
        const upper = path.join(dir, `csp${ext.toUpperCase()}`)
        if (isExecutable(upper))
          return upper
      }
    }
  }

  return null
}
