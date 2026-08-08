# DeltaCode

A coding CLI that reads your project, plans around its conventions, and does the work with you — write, edit, run, search, and delegate to specialist agents from one terminal session.

Built with Bun + React + Ink. No Electron, no cloud IDE, no lock-in. Your files stay yours.

## What it does

- **One lead agent, specialist helpers** — the lead agent handles the conversation and hands off to coding, research, or other agents when a task fits them better.
- **Real tool use** — reads and edits files, runs commands, searches with glob/grep, all through a permission prompt you control. Nothing runs outside the current project without asking.
- **Sessions** — every conversation is saved per project. Leave and come back; `deltacode` resumes where you stopped.
- **Delta Free Models** — a managed free tier (GLM-4.7-Flash, no API key needed) with a daily fair-use budget. See Providers below.
- **MCP support** — plug in remote tool servers (Exa is built in) and the agents can use them.

## Install

Requires [Bun](https://bun.sh) (the installer fetches it for you if it's missing).

One-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/wehnnit/DeltaCode/main/install.sh | bash
```

Or clone and install:

```bash
git clone https://github.com/wehnnit/DeltaCode && cd DeltaCode
bash install.sh
```

This builds a `deltacode` binary into `~/.delta/bin` and adds it to your PATH. Reinstall after pulling updates — same command.

Or run straight from source:

```bash
bun install
bun run dev
```

## Quick start

```bash
cd ~/some/project
deltacode
```

First launch opens the setup screen: pick a provider (Delta Free Models needs no key — just accept the fair-use statement) or paste your own API key. Then just ask:

```
You: build a todo app
```

The lead agent explores the project, makes the files, and verifies the result. It only touches files inside the project unless you approve wider scope.

### Slash commands

| Command | What it does |
|---|---|
| `/help` | All commands |
| `/model` | Switch model (opens a picker, or `/model <id>`) |
| `/models` | Delta Free Models catalog |
| `/usage` | Free-model budget used today |
| `/agents` | List specialist agents |
| `/skills` | List loaded skills |
| `/new` | New chat |
| `/clear` | Clear the chat view |
| `/exit` | Quit |

While a turn is running: **esc** interrupts, **esc esc** aborts. Ctrl-C quits.

## Providers

Configured in the setup screen (rerun with `deltacode setup`):

- **Delta Free Models** — GLM-4.7-Flash through the Delta community proxy. No API key. Daily fair-use budget (1M tokens = 10 units, 500 units/day per device), tracked with a random hashed device id — no personal data leaves your machine. The proxy is provided as-is; availability and limits depend on the upstream free tier.
- **Anthropic, OpenAI, OpenRouter, Z.AI, Gemini, ZenMux** — bring your own key via the corresponding environment variable (see `src/providers/index.ts`).

## Configuration

Everything lives under `~/.delta/`:

| Path | Purpose |
|---|---|
| `~/.delta/config.json` | Provider, model, timeouts, permissions |
| `~/.delta/sessions/` | Per-project conversation history |
| `~/.delta/device-id` | Random id for the free-model fair-use pool |
| `~/.delta/usage.json` | Local copy of today's free-model usage |

`bash` permission defaults to **ask** — set `permissions.bash: "allow"` in config if you want it to just run.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # full suite (unit tests, no network)
bun run build       # compile a fresh binary
```

Layout:

```
src/
  cli.tsx           entrypoint (TUI + headless mode)
  tui/              ink screens, markdown renderer, animations
  harness/          agent loop: tool calls, retries, delegation
  providers/        OpenAI-compatible client + provider presets
  tools/            read/write/edit/bash/glob/grep
  agents/           agent definitions
  skills/           skill loader + built-ins
  mcp/              MCP client
  sessions.ts       session persistence
  usage.ts          free-model fair-use tracker
test/               bun test suite
```

Headless mode (one-shot, no TUI):

```bash
deltacode "fix the failing test" -y
```

## License

Apache-2.0 — see [LICENSE](LICENSE). Copyright (c) 2026 WEHNIT STUDIOS.

"DeltaCode" is a trademark of WEHNIT STUDIOS and is not granted under the license.
