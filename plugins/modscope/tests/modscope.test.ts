import { describe, expect, mock, test, tier } from 'claude-code/testing'

// modscope loads in the user tier in these tests; the `on` hooks registered
// below sit beneath the mod, where the rest of the world would be.
tier('user')

describe('modscope', () => {
  test('registers /modscope and reports the session', async ($, on) => {
    const commands: string[] = []
    const tools: string[] = []
    mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => {
      commands.push(e.name)
      return { value: { command: e.name } }
    })
    on('tool.register', ($, e) => {
      tools.push(e.name)
      return { value: { tool: `mcp__modscope__${e.name}` } }
    })
    on('ui.log', () => ({ value: undefined }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(commands).toContain('modscope')
    expect(tools).toEqual(
      expect.arrayContaining(['list_mods', 'mod_errors', 'mod_stats', 'read_mod', 'validate_mod']),
    )

    const { text } = await $.command.run({
      command: 'modscope',
      args: '',
      origin: { kind: 'composer' },
    })
    expect(text).toContain('modscope report')
  })

  test('records a rejected dispatch in /modscope errors', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__modscope__${e.name}` } }))
    on('ui.log', () => ({ value: undefined }))
    // A "bad mod" beneath that throws before answering: the engine skips it
    // and, with nothing left under it, the dispatch rejects to our * hook.
    on('tool.call', { tool: 'Bash' }, () => {
      throw new Error('kaboom')
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await expect($.tool.call({ tool: 'Bash', command: 'ls' })).rejects.toThrow()

    const { text } = await $.command.run({
      command: 'modscope',
      args: 'errors',
      origin: { kind: 'composer' },
    })
    expect(text).toContain('tool.call')
    expect(text).toContain('rejected')
  })

  test('serves list_mods and mod_stats through tool.call', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('tool.register', ($, e) => ({ value: { tool: `mcp__modscope__${e.name}` } }))
    on('ui.log', () => ({ value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })

    const mods = await $.tool.call({ tool: 'mcp__modscope__list_mods' })
    expect(String(mods.result)).toContain('modscope')

    const stats = await $.tool.call({ tool: 'mcp__modscope__mod_stats' })
    expect(String(stats.result)).toContain('tool.call')
  })
})
