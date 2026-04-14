import { describe, expect, it } from 'bun:test'
import { main } from '../../src/index.js'

describe('ask CLI registration — skills namespace', () => {
  it('main.subCommands exposes skills', async () => {
    const subs = await resolveSubCommands(main)
    expect(subs!.skills).toBeDefined()
  })

  it('skills has list, install, remove subcommands', async () => {
    const subs = await resolveSubCommands(main)
    const skillsCmd = await resolveCommand(subs!.skills)
    const skillsSubs = await resolveSubCommands(skillsCmd)
    expect(skillsSubs!.list).toBeDefined()
    expect(skillsSubs!.install).toBeDefined()
    expect(skillsSubs!.remove).toBeDefined()
  })

  it('skills list exposes --no-fetch', async () => {
    const subs = await resolveSubCommands(main)
    const skillsCmd = await resolveCommand(subs!.skills)
    const skillsSubs = await resolveSubCommands(skillsCmd)
    const list = await resolveCommand(skillsSubs!.list)
    expect(list.args?.['no-fetch']).toBeDefined()
  })

  it('skills install exposes --force and --agent', async () => {
    const subs = await resolveSubCommands(main)
    const skillsCmd = await resolveCommand(subs!.skills)
    const skillsSubs = await resolveSubCommands(skillsCmd)
    const install = await resolveCommand(skillsSubs!.install)
    expect(install.args?.force).toBeDefined()
    expect(install.args?.agent).toBeDefined()
  })

  it('skills remove exposes --ignore-missing', async () => {
    const subs = await resolveSubCommands(main)
    const skillsCmd = await resolveCommand(subs!.skills)
    const skillsSubs = await resolveSubCommands(skillsCmd)
    const remove = await resolveCommand(skillsSubs!.remove)
    expect(remove.args?.['ignore-missing']).toBeDefined()
  })
})

async function resolveSubCommands(cmd: { subCommands?: unknown }): Promise<Record<string, unknown> | null> {
  const sc = cmd.subCommands
  if (!sc)
    return null
  if (typeof sc === 'function') {
    return await (sc as () => Promise<Record<string, unknown>>)()
  }
  return sc as Record<string, unknown>
}

async function resolveCommand(maybeCmd: unknown): Promise<{ meta?: { name?: string }, args?: Record<string, unknown>, subCommands?: unknown }> {
  if (typeof maybeCmd === 'function') {
    return await (maybeCmd as () => Promise<{ meta?: { name?: string }, args?: Record<string, unknown> }>)()
  }
  return maybeCmd as { meta?: { name?: string }, args?: Record<string, unknown> }
}
