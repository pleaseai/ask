import { describe, expect, it } from 'bun:test'
import { main } from '../../src/index.js'

/**
 * Smoke tests for the `ask src` and `ask docs` subcommand registration
 * (T006 of lazy-ask-src-docs). The runtime behavior of each command is
 * exercised in test/commands/{src,docs}.test.ts via direct calls to
 * runSrc/runDocs — here we only verify that the citty subCommands map
 * exposes them so `ask src` / `ask docs` resolve at the CLI surface.
 */

describe('ask CLI registration — src and docs', () => {
  it('main.subCommands exposes src', async () => {
    const subs = await resolveSubCommands(main)
    expect(subs).toBeTruthy()
    expect(subs!.src).toBeDefined()
  })

  it('main.subCommands exposes docs', async () => {
    const subs = await resolveSubCommands(main)
    expect(subs!.docs).toBeDefined()
  })

  it('src command has expected meta name and required spec arg', async () => {
    const subs = await resolveSubCommands(main)
    const cmd = await resolveCommand(subs!.src)
    expect(cmd.meta?.name).toBe('src')
    expect(cmd.args?.spec).toBeDefined()
    expect((cmd.args!.spec as { type: string }).type).toBe('positional')
  })

  it('docs command has expected meta name and required spec arg', async () => {
    const subs = await resolveSubCommands(main)
    const cmd = await resolveCommand(subs!.docs)
    expect(cmd.meta?.name).toBe('docs')
    expect(cmd.args?.spec).toBeDefined()
  })

  it('src command exposes a --no-fetch flag', async () => {
    const subs = await resolveSubCommands(main)
    const cmd = await resolveCommand(subs!.src)
    expect(cmd.args?.['no-fetch']).toBeDefined()
  })

  it('docs command exposes a --no-fetch flag', async () => {
    const subs = await resolveSubCommands(main)
    const cmd = await resolveCommand(subs!.docs)
    expect(cmd.args?.['no-fetch']).toBeDefined()
  })
})

// Citty allows subCommands and meta/args fields to be either a value or
// a thunk returning a promise. Resolve them lazily so we don't depend
// on which form the project happens to use.
async function resolveSubCommands(cmd: { subCommands?: unknown }): Promise<Record<string, unknown> | null> {
  const sc = cmd.subCommands
  if (!sc)
    return null
  if (typeof sc === 'function') {
    return await (sc as () => Promise<Record<string, unknown>>)()
  }
  return sc as Record<string, unknown>
}

async function resolveCommand(maybeCmd: unknown): Promise<{ meta?: { name?: string }, args?: Record<string, unknown> }> {
  if (typeof maybeCmd === 'function') {
    return await (maybeCmd as () => Promise<{ meta?: { name?: string }, args?: Record<string, unknown> }>)()
  }
  return maybeCmd as { meta?: { name?: string }, args?: Record<string, unknown> }
}
