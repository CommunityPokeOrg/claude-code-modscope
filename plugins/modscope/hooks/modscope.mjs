// modscope — a Claude Code mod that debugs other mods.
//
// Built on the verified function-hooks API (Claude Code 2.1.287+):
//   on("plugin.register") — sees every hooks module the engine loads, with the
//     host's own scan of what it hooks and calls (PluginRegisterInput.uses).
//   on("engine.create")   — the fold that builds `$`; e.plugins lists the
//     modules in the build.
//   on("*")               — wraps every dispatch. Once next(e) settles,
//     next.trace attributes each link to a plugin with an outcome and wall
//     time, so throws, budget timeouts and rejections land on the mod that
//     caused them.
//   $.command.register    — /modscope: report, errors, stats, validator, pane,
//     and "fix <name>" (model-assisted diagnosis).
//   $.tool.register       — mcp__modscope__* tools so Claude itself can inspect
//     the session's mods, read their failures and their source.

const PANE_ID = 'modscope'
const COMMAND = 'modscope'
const SELF = 'modscope'
const MAX_FAILURES = 200
const INPUT_PREVIEW = 400
const SOURCE_LIMIT = 60000
const REPORT_ROWS = 25

// Every link outcome that means a hook failed, per the TraceOutcome docs:
// caught (threw, .catch answered), expired (budget ran out), kept (failed
// after next), rejected, and skipped-without-reason (failed before next; a
// reason means a next.to bypass, which is not a failure).
const FAILURE_OUTCOMES = new Set(['caught', 'expired', 'kept', 'rejected'])

const TOOLS = [
  {
    name: 'list_mods',
    description:
      "List the mods (plugins with hooks modules) loaded in this Claude Code session: name, version, root directory, tier, provenance, and the host-scanned list of the events each one hooks and the engine calls it makes — the same data `claude plugin validate` prints. Use to inspect which mods are installed and what each one can touch.",
    inputSchema: { type: 'object' },
  },
  {
    name: 'mod_errors',
    description:
      "Recent hook failures observed across the session's loaded mods — throws, budget timeouts, post-next failures and rejections — attributed to the plugin that caused them, with the event, outcome, wall time and a preview of the event input. Use to find which mod is misbehaving.",
    inputSchema: {
      type: 'object',
      properties: {
        plugin: { type: 'string', description: 'Only failures attributed to this mod.' },
      },
    },
  },
  {
    name: 'mod_stats',
    description:
      "Event and plugin timing statistics gathered by wrapping every engine dispatch: event counts and failure counts, plus total hook wall time per plugin (slowest mods first).",
    inputSchema: { type: 'object' },
  },
  {
    name: 'read_mod',
    description:
      "Read a loaded mod's own files — its hooks/hooks.json manifest and each hooks module it declares — to inspect or debug its source code.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The mod name, as list_mods reports it.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'validate_mod',
    description:
      "Run `claude plugin validate` on a loaded mod's directory and return the report: the hook registrations and engine calls its source is scanned as using.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The mod name; validates every known mod when omitted.' },
      },
    },
  },
]

const TOOL_NAMES = TOOLS.map(t => `mcp__${SELF}__${t.name}`)

const HELP = [
  `/${COMMAND} — debug the session's loaded mods`,
  `  /${COMMAND}             report: mods, failures and event stats`,
  `  /${COMMAND} mods        every mod seen: tier, provenance, hooked events, engine calls`,
  `  /${COMMAND} errors [n]  attributed hook failures (throws, timeouts, rejections)`,
  `  /${COMMAND} events      event dispatch counts and failure counts`,
  `  /${COMMAND} slow        hook wall time per plugin, slowest first`,
  `  /${COMMAND} pane        toggle the modscope pane`,
  `  /${COMMAND} validate [name]  run \`claude plugin validate\` on mod root(s)`,
  `  /${COMMAND} fix <name>  ask the session's model to diagnose a failing mod`,
  `  /${COMMAND} clear       drop recorded mods and failures`,
].join('\n')

/** name -> registration record (PluginRegisterInput + outcome) */
const mods = new Map()
/** attributed failures, oldest first */
const failures = []
/** event name -> { count, failures } */
const eventStats = new Map()
/** plugin -> { ms, links }: hook-chain wall time from next.trace */
const pluginTime = new Map()

export function register(on) {
  on('engine.create', async ($, e, next) => {
    for (const name of e.plugins) noteModule(name)
    return next(e)
  })

  on('plugin.register', async ($, e, next) => {
    const result = await next(e)
    noteRegistration(e, result)
    persist($)
    return result
  })

  on('*', async ($, e, next) => {
    // At engine.create `$` is the empty table; there is nothing to inspect yet.
    if (next.is('engine.create', e)) return next(e)
    let result
    try {
      result = await next(e)
    } catch (error) {
      inspectTrace($, next)
      recordFailure($, {
        plugin: String(next.origin?.plugin ?? '(dispatch)'),
        event: eventName(next),
        outcome: 'rejected',
        reason: messageOf(error),
      })
      throw error
    }
    inspectTrace($, next)
    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await restore($).catch(() => undefined)
    await $.command
      .register({
        name: COMMAND,
        description: "Debug the session's loaded mods: failures, stats, sources, diagnosis.",
        argumentHint: '[mods|errors|events|slow|pane|validate|fix|clear|help]',
      })
      .catch(error => $.ui.log(`modscope: command.register refused: ${messageOf(error)}`, { to: 'debug' }))
    for (const tool of TOOLS) {
      await $.tool
        .register(tool)
        .catch(error => $.ui.log(`modscope: tool.register ${tool.name} refused: ${messageOf(error)}`, { to: 'debug' }))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    persist($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    try {
      return { text: await runCommand($, args) }
    } catch (error) {
      return { text: `modscope: ${messageOf(error)}\n\n${HELP}` }
    }
  })

  on('tool.call', { tool: TOOL_NAMES }, async ($, e) => {
    try {
      return { result: await serveTool($, e) }
    } catch (error) {
      return { result: `modscope: ${messageOf(error)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    const count = failures.length
    return Box({
      flexDirection: 'column',
      children: [
        below,
        Text({
          color: count > 0 ? 'red' : 'gray',
          dimColor: count === 0,
          children: `⛨ ${mods.size} mod${mods.size === 1 ? '' : 's'} · ${count} failure${count === 1 ? '' : 's'} · /${COMMAND}`,
        }),
      ],
    })
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: paneLines().map(line => Text({ children: line === '' ? ' ' : line })),
    })
  })
}

/* ---------------- recording ---------------- */

function eventName(next) {
  return String(next.event ?? '?')
}

function noteModule(name) {
  const key = String(name)
  if (mods.has(key)) return
  mods.set(key, {
    name: key,
    root: '',
    version: null,
    provenance: '',
    tier: '',
    events: [],
    calls: [],
    admitted: true,
    seenAt: Date.now(),
    via: 'engine.create',
  })
}

function noteRegistration(e, result) {
  const uses = e.uses ?? {}
  mods.set(e.name, {
    name: String(e.name),
    root: String(e.root ?? ''),
    version: e.version ?? null,
    provenance: String(e.provenance ?? ''),
    tier: String(e.tier ?? ''),
    events: Array.isArray(uses.events) ? uses.events.map(String) : [],
    calls: Array.isArray(uses.calls) ? uses.calls.map(String) : [],
    env: uses.env
      ? {
          reads: Array.isArray(uses.env.reads) ? uses.env.reads.map(String) : [],
          writes: Array.isArray(uses.env.writes) ? uses.env.writes.map(String) : [],
        }
      : undefined,
    admitted: result?.allow === true,
    refused: typeof result?.refuse === 'string' ? result.refuse : undefined,
    seenAt: Date.now(),
  })
}

function inspectTrace($, next) {
  const trace = next.trace
  if (!Array.isArray(trace)) return
  const event = eventName(next)
  const stat = eventStats.get(event) ?? { count: 0, failures: 0 }
  stat.count += 1
  let bad = false
  for (const link of trace) {
    if (!link || typeof link !== 'object') continue
    const plugin = String(link.plugin ?? 'engine')
    if (plugin !== 'engine' && typeof link.ms === 'number') {
      const t = pluginTime.get(plugin) ?? { ms: 0, links: 0 }
      t.ms += link.ms
      t.links += 1
      pluginTime.set(plugin, t)
    }
    const outcome = String(link.outcome ?? '')
    const failed = FAILURE_OUTCOMES.has(outcome) || (outcome === 'skipped' && !link.reason)
    if (!failed) continue
    bad = true
    stat.failures += 1
    recordFailure($, {
      plugin,
      event,
      outcome,
      reason: link.reason ? String(link.reason) : undefined,
      ms: typeof link.ms === 'number' ? link.ms : undefined,
      input: preview(link.received),
    })
  }
  eventStats.set(event, stat)
  if (bad) void $.store.set('failures', failures.slice(-MAX_FAILURES)).catch(() => undefined)
}

function recordFailure($, entry) {
  failures.push({ ...entry, at: Date.now() })
  if (failures.length > MAX_FAILURES) failures.splice(0, failures.length - MAX_FAILURES)
  $.ui.log(
    `modscope: ${entry.plugin} ${entry.event} ${entry.outcome}${entry.reason ? ` — ${entry.reason}` : ''}`,
    { to: 'debug' },
  )
}

function preview(value) {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const picked = {}
    for (const key of ['tool', 'command', 'component', 'file_path', 'id']) {
      if (key in value && typeof value[key] === 'string') picked[key] = value[key].slice(0, 120)
    }
    const source = Object.keys(picked).length > 0 ? picked : value
    const text = JSON.stringify(source)
    return text.length > INPUT_PREVIEW ? `${text.slice(0, INPUT_PREVIEW)}…` : text
  } catch {
    return undefined
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------- persistence ---------------- */

async function restore($) {
  const savedMods = await $.store.get('mods').catch(() => undefined)
  if (Array.isArray(savedMods)) {
    for (const m of savedMods) {
      if (m && typeof m === 'object' && typeof m.name === 'string' && !mods.has(m.name)) {
        mods.set(m.name, m)
      }
    }
  }
  const savedFailures = await $.store.get('failures').catch(() => undefined)
  if (Array.isArray(savedFailures)) {
    for (const f of savedFailures) {
      if (f && typeof f === 'object' && typeof f.event === 'string') failures.push(f)
    }
    if (failures.length > MAX_FAILURES) failures.splice(0, failures.length - MAX_FAILURES)
  }
}

function persist($) {
  void $.store.set('mods', [...mods.values()]).catch(() => undefined)
  void $.store.set('failures', failures.slice(-MAX_FAILURES)).catch(() => undefined)
}

/* ---------------- reports ---------------- */

async function runCommand($, args) {
  const sub = args[0] ?? 'report'
  switch (sub) {
    case 'report':
      return report()
    case 'mods':
      return modsReport()
    case 'errors':
      return errorsReport(args[1] ? Number(args[1]) : 15, args[2])
    case 'events':
      return eventsReport()
    case 'slow':
      return slowReport()
    case 'pane':
      return await togglePane($)
    case 'validate':
      return await validate($, args[1])
    case 'fix':
      return await fix($, args[1])
    case 'clear':
      return await clear($)
    case 'help':
      return HELP
    default:
      return `modscope: unknown subcommand "${sub}"\n\n${HELP}`
  }
}

async function serveTool($, e) {
  const short = String(e.tool).replace(`mcp__${SELF}__`, '')
  switch (short) {
    case 'list_mods':
      return modsReport()
    case 'mod_errors':
      return errorsReport(25, typeof e.plugin === 'string' ? e.plugin : undefined)
    case 'mod_stats':
      return `${eventsReport()}\n\n${slowReport()}`
    case 'read_mod':
      return await readMod($, String(e.name ?? ''))
    case 'validate_mod':
      return await validate($, typeof e.name === 'string' ? e.name : undefined)
    default:
      return `modscope: unknown tool ${e.tool}`
  }
}

function report() {
  const bad = failures.length
  const lines = [
    `modscope report — ${mods.size} mod${mods.size === 1 ? '' : 's'} seen, ${bad} recorded failure${bad === 1 ? '' : 's'}`,
    '',
  ]
  for (const mod of mods.values()) {
    const flag = mod.refused ? `  REFUSED: ${mod.refused}` : mod.admitted ? '' : '  (outcome unknown)'
    lines.push(
      `• ${mod.name}${mod.version ? `@${mod.version}` : ''} [${mod.tier || '?'}] ${mod.provenance || mod.via || ''}${flag}`,
    )
  }
  if (bad > 0) {
    lines.push('', 'recent failures:')
    for (const f of failures.slice(-8)) {
      lines.push(`  ${f.plugin} ${f.event} ${f.outcome}${f.reason ? ` — ${f.reason}` : ''}`)
    }
  }
  lines.push('', `/${COMMAND} mods · errors · events · slow · pane · validate · fix <name>`)
  return lines.join('\n')
}

function modsReport() {
  if (mods.size === 0) return 'modscope: no mods seen yet this session.'
  const lines = []
  for (const mod of mods.values()) {
    lines.push(`${mod.name}${mod.version ? `@${mod.version}` : ''}`)
    lines.push(`  root: ${mod.root || '?'}  tier: ${mod.tier || '?'}  provenance: ${mod.provenance || '?'}`)
    if (mod.refused) lines.push(`  REFUSED: ${mod.refused}`)
    if (mod.events?.length) lines.push(`  hooks: ${mod.events.join(', ')}`)
    if (mod.calls?.length) lines.push(`  calls: ${mod.calls.join(', ')}`)
    if (mod.env && (mod.env.reads.length || mod.env.writes.length)) {
      lines.push(`  env: reads [${mod.env.reads.join(', ')}] writes [${mod.env.writes.join(', ')}]`)
    }
  }
  return lines.join('\n')
}

function errorsReport(limit = 15, plugin) {
  const rows = plugin ? failures.filter(f => f.plugin === plugin) : failures
  if (rows.length === 0) {
    return plugin ? `modscope: no failures recorded for "${plugin}".` : 'modscope: no failures recorded.'
  }
  const lines = [`${rows.length} failure${rows.length === 1 ? '' : 's'}${plugin ? ` for ${plugin}` : ''} (newest last):`]
  for (const f of rows.slice(-limit)) {
    const when = f.at ? new Date(f.at).toISOString().slice(11, 19) : '?'
    lines.push(`[${when}] ${f.plugin} ${f.event} ${f.outcome}${typeof f.ms === 'number' ? ` ${Math.round(f.ms)}ms` : ''}`)
    if (f.reason) lines.push(`    ${f.reason}`)
    if (f.input) lines.push(`    input: ${f.input}`)
  }
  return lines.join('\n')
}

function eventsReport() {
  if (eventStats.size === 0) return 'modscope: no events seen yet.'
  const rows = [...eventStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, REPORT_ROWS)
  const lines = ['event dispatches (count · failures):']
  for (const [event, s] of rows) {
    lines.push(`  ${String(s.count).padStart(6)}  ${String(s.failures).padStart(4)}  ${event}`)
  }
  return lines.join('\n')
}

function slowReport() {
  if (pluginTime.size === 0) return 'modscope: no plugin timing yet.'
  const rows = [...pluginTime.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, REPORT_ROWS)
  const lines = ['hook wall time per plugin (next.trace):']
  for (const [plugin, t] of rows) {
    lines.push(`  ${String(Math.round(t.ms)).padStart(8)}ms  ${String(t.links).padStart(6)} links  ${plugin}`)
  }
  return lines.join('\n')
}

async function togglePane($) {
  const open = (await $.ui.panes()).some(p => p.id === PANE_ID)
  if (open) {
    await $.ui.close({ id: PANE_ID })
    return 'modscope: pane closed'
  }
  await $.ui.open({ id: PANE_ID, title: 'modscope — mod debugger' })
  return 'modscope: pane opened (Esc closes it)'
}

function paneLines() {
  const lines = [`modscope — ${mods.size} mods · ${failures.length} failures`, '']
  for (const mod of mods.values()) {
    const bad = failures.filter(f => f.plugin === mod.name).length
    lines.push(
      `${bad > 0 ? '✗' : '✓'} ${mod.name}${mod.version ? `@${mod.version}` : ''} [${mod.tier || '?'}] ${bad ? `${bad} failures` : ''}`,
    )
  }
  if (failures.length > 0) {
    lines.push('', 'latest failures:')
    for (const f of failures.slice(-6)) {
      lines.push(`  ${f.plugin} ${f.event} ${f.outcome}${f.reason ? ` — ${f.reason.slice(0, 80)}` : ''}`)
    }
  }
  lines.push('', `/${COMMAND} help`)
  return lines
}

async function validate($, name) {
  const targets = name
    ? [mods.get(name)].filter(Boolean)
    : [...mods.values()].filter(m => m.root)
  if (targets.length === 0) {
    return name
      ? `modscope: no mod named "${name}" is loaded.`
      : 'modscope: no mods with a known root directory.'
  }
  const out = []
  for (const mod of targets.slice(0, 10)) {
    const run = await $.process
      .run(['claude', 'plugin', 'validate', '--json', mod.root], { timeoutMs: 60000 })
      .catch(error => ({ error: messageOf(error) }))
    out.push(`== ${mod.name} (${mod.root}) ==`)
    out.push(run.error ? `validate failed to run: ${run.error}` : (run.stdout || '(no output)').slice(0, 4000))
  }
  return out.join('\n')
}

async function readMod($, name) {
  const mod = mods.get(name)
  if (!mod) {
    return `modscope: no mod named "${name}" is loaded. Known: ${[...mods.keys()].join(', ') || 'none'}`
  }
  if (!mod.root) return `modscope: no root directory known for "${name}".`
  const manifest = await $.fs.read(`${mod.root}/hooks/hooks.json`)
  const chunks = [`${mod.root}/hooks/hooks.json`, manifest]
  try {
    const parsed = JSON.parse(manifest)
    const modules = Array.isArray(parsed.modules) ? parsed.modules : []
    for (const m of modules.slice(0, 4)) {
      const rel = String(m).replace(/^\.\//, '')
      const path = `${mod.root}/hooks/${rel}`
      const source = await $.fs.read(path)
      chunks.push(
        `${path}`,
        source.length > SOURCE_LIMIT ? `${source.slice(0, SOURCE_LIMIT)}\n…[truncated]` : source,
      )
    }
  } catch (error) {
    chunks.push(`(source read failed: ${messageOf(error)})`)
  }
  return chunks.join('\n\n')
}

async function fix($, name) {
  if (!name) return `usage: /${COMMAND} fix <mod-name>`
  const mod = mods.get(name)
  if (!mod) {
    return `modscope: no mod named "${name}" is loaded. Known: ${[...mods.keys()].join(', ') || 'none'}`
  }
  const modFailures = failures.filter(f => f.plugin === name)
  const source = mod.root
    ? await readMod($, name).catch(error => `(could not read mod files: ${messageOf(error)})`)
    : '(root directory unknown)'
  const prompt = [
    `You are debugging a Claude Code mod — a plugin whose TypeScript/JavaScript hooks module intercepts engine events via register(on) with hooks of the form on(event, matcher?, ($, e, next) => result).`,
    ``,
    `Mod: ${name} (provenance ${mod.provenance || '?'}, tier ${mod.tier || '?'}, root ${mod.root || '?'})`,
    `Hooked events: ${mod.events?.join(', ') || '?'}`,
    `Engine calls used: ${mod.calls?.join(', ') || '?'}`,
    ``,
    `Observed hook failures attributed to this mod (${modFailures.length}, newest last):`,
    JSON.stringify(modFailures.slice(-10), null, 2),
    ``,
    `Mod files:`,
    source,
    ``,
    `Explain the most likely root cause of the failures and suggest a concrete fix, referencing the specific code.`,
  ].join('\n')
  const text = await $.model.complete({
    model: 'haiku',
    prompt,
    maxTokens: 2048,
    system: 'You are a precise debugger of Claude Code mods. Be concrete: name the code, the failure mode, and the fix.',
  })
  return `modscope diagnosis for ${name}:\n\n${text}`
}

async function clear($) {
  mods.clear()
  failures.length = 0
  eventStats.clear()
  pluginTime.clear()
  await $.store.delete('mods').catch(() => undefined)
  await $.store.delete('failures').catch(() => undefined)
  return 'modscope: cleared.'
}
