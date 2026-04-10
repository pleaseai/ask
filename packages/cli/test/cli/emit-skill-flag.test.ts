import { describe, expect, it } from 'bun:test'

/**
 * Tests verifying that the --emit-skill flag is declared in the installCmd
 * and addCmd citty command definitions (SC-2).
 *
 * We inspect the command arg schema directly rather than mocking runInstall,
 * to avoid polluting the module registry for other test files.
 */

// Import the compiled main command to inspect its subcommand arg definitions.
const { main } = await import('../../src/index.js')

function getSubcmd(name: string) {
  const subCmds = (main as unknown as { subCommands?: Record<string, unknown> }).subCommands
  return subCmds?.[name]
}

describe('--emit-skill flag declaration (SC-2)', () => {
  it('installCmd declares emit-skill as a boolean arg', () => {
    const installCmd = getSubcmd('install') as {
      args?: Record<string, { type?: string, description?: string }>
    }
    expect(installCmd).toBeDefined()
    const arg = installCmd?.args?.['emit-skill']
    expect(arg).toBeDefined()
    expect(arg?.type).toBe('boolean')
  })

  it('addCmd declares emit-skill as a boolean arg', () => {
    const addCmd = getSubcmd('add') as {
      args?: Record<string, { type?: string, description?: string }>
    }
    expect(addCmd).toBeDefined()
    const arg = addCmd?.args?.['emit-skill']
    expect(arg).toBeDefined()
    expect(arg?.type).toBe('boolean')
  })
})
