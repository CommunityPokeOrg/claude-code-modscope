# modscope — a Claude Code mod that debugs other mods

[Mods](https://claude.com/blog/claude-code-mods) are TypeScript/JavaScript function hooks inside Claude Code plugins (Claude Code 2.1.287+). modscope is a mod for debugging them: it watches which mods load, wraps every engine event and attributes failures to the mod that caused them, times the hook chain per plugin, and hands all of it to you through `/modscope`, a status band, a pane — and to Claude itself through registered tools, so you can ask "why is my mod broken?" and Claude can inspect the session, read the mod's source and suggest a fix.

## What it does

- **Sees every mod that loads.** A `plugin.register` hook records each hooks module with the host's own scan of it: name, version, root dir, tier (`prepend`/`user`/`append`/`builtin`), provenance (`<name>@<marketplace>`, `@inline`, `@builtin`), the exact events it hooks, the `$.` calls it makes, and the env vars it touches — the same data `claude plugin validate` prints. Refused registrations are recorded too.
- **Attributes failures to the mod that caused them.** A `*` hook wraps every event dispatch. After `next(e)` settles, `next.trace` lists each link in the chain with its plugin, outcome (`caught`, `expired`, `kept`, `rejected`, `skipped`, …) and wall time — so a throw, a 10-second budget overrun or a rejection lands on the mod responsible, with the event and a preview of its input. Rejected dispatches (where `next(e)` itself throws) are captured with the error message.
- **Times the chain.** The same trace accumulates hook wall time per plugin — find out which mod is making every event slow.
- **Lets Claude debug.** Five `mcp__modscope__*` tools (`list_mods`, `mod_errors`, `mod_stats`, `read_mod`, `validate_mod`) are registered at session start, so the model can inspect the session's mods, read their failures and their actual source, and re-run `claude plugin validate` on a mod's directory.
- **Diagnoses on demand.** `/modscope fix <name>` bundles a mod's observed failures plus its own source and asks the session's model (`$.model.complete`) for a root-cause analysis and concrete fix.
- **Shows status live.** A one-line `AbovePrompt` band shows loaded-mod and failure counts (turns red when failures appear); `/modscope pane` opens a per-mod health pane. Every captured failure is also appended to the debug log (`claude --debug`) under the plugin's name.

## Install

Requires Claude Code **2.1.287 or later** (`claude --version`). Mods are on by default.

### From the marketplace (recommended)

```
/plugin marketplace add CommunityPokeOrg/claude-code-modscope
/plugin install modscope@community-poke-mods
/reload-plugins
```

### From a local checkout

```bash
git clone https://github.com/CommunityPokeOrg/claude-code-modscope
claude --plugin-dir claude-code-modscope/plugins/modscope
```

The folder is watched while the session runs, so editing `hooks/modscope.mjs` hot-reloads it in place — handy when debugging mods, including modscope itself.

## Usage

```
/modscope             report: mods, failures and event stats
/modscope mods        every mod seen: tier, provenance, hooked events, engine calls
/modscope errors [n]  attributed hook failures (throws, timeouts, rejections)
/modscope events      event dispatch counts and failure counts
/modscope slow        hook wall time per plugin, slowest first
/modscope pane        toggle the modscope pane
/modscope validate [name]  run `claude plugin validate` on mod root(s)
/modscope fix <name>  ask the session's model to diagnose a failing mod
/modscope clear       drop recorded mods and failures
```

Or just ask Claude:

> "Why is the token-weather mod broken?" — Claude calls `mcp__modscope__mod_errors` to see its failures, `mcp__modscope__read_mod` to read its source, and explains the fix.
>
> "Which of my mods is slowing things down?" — `mcp__modscope__mod_stats`.

## Debugging a mod workflow

1. Install modscope and the mod under development.
2. Reproduce the failure (use the mod, run the command, make the edit).
3. `/modscope errors` — see which mod threw, on which event, with what outcome.
4. `/modscope fix <name>` — or ask Claude directly; it reads the mod's live source via `read_mod`.
5. `/modscope validate <name>` — re-check what the engine scans in the mod's source after your edit.

## How it works (verified interfaces only)

Everything above is built from the documented function-hooks API:

| Mechanism | Used for |
| --- | --- |
| `on("plugin.register")` + `PluginRegisterInput.uses` | Inventory of loaded mods with the host's scanned hook/capability list |
| `on("engine.create")` (`e.plugins`) | The set of modules in the `$` build fold |
| `on("*")` + `next.trace` (`TraceEntry.plugin/.outcome/.ms/.reason`) | Per-plugin failure attribution and wall time on every dispatch |
| `$.command.register` / `command.run` hook | `/modscope` and its subcommands |
| `$.tool.register` / `tool.call` hook | `mcp__modscope__*` tools for the model |
| `$.ui.resolve` + `ui.render` on `AbovePrompt`/`Pane`, `$.ui.open/.close/.panes` | Status band and health pane |
| `$.ui.log({ to: "debug" })` | Failure lines in the debug log |
| `$.store` | Mod registry and failure ring survive hot reloads and sessions |
| `$.fs.read` / `$.process.run` | Reading mod sources, running `claude plugin validate` |
| `$.model.complete` | `/modscope fix <name>` diagnosis |

Module state lives in `$.store` where persistence matters (mods, failures); live counters are module-level and reset on hot reload.

## Development

```bash
claude plugin validate plugins/modscope   # static scan: hooks, $ calls, env usage
claude plugin test plugins/modscope       # run the tests in tests/ against the engine harness
```

## Sources

- Announcement: [Customize Claude Code with mods in TypeScript](https://claude.com/blog/claude-code-mods)
- Tutorial: [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/)
- Changelog: `Added Claude Mods` in [anthropics/claude-code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/master/CHANGELOG.md) (v2.1.287)
- Built-in mod sources: [anthropics/claude-code `mods/` directory](https://github.com/anthropics/claude-code/tree/main/mods) (`diff`, `sec-default`, `telemetry`, `agents-md`, `types/claude-code.d.ts`)
- Design discussion: [anthropics/claude-code issue #91870](https://github.com/anthropics/claude-code/issues/91870)
- Marketplace format: [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)

## Notes and limits

- `next.trace` attributes a failure by plugin name; the thrown error's message reaches modscope only when the whole dispatch rejects — otherwise the engine reports it by name to the transcript/debug log (modscope mirrors its findings there too). Run `claude --debug` for the deepest detail.
- The mods API is new and may change between releases; when Claude Code loads a mod it writes the exact type declarations for your build into `.claude-plugin/types/` — those are the authority.
- A modscope that loads *after* a misbehaving mod still sees everything: plugin inventory comes from `engine.create`/`plugin.register`, and failures are attributed by `next.trace` rather than by wrapping order.
