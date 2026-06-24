# pi agent setup (recreation)

This folder is a snapshot of a `pi` coding-agent profile, minus all the
runtime junk (session logs, cloned repos, binaries, caches, secrets). Copy it
into place to recreate the setup.

## 1. Install pi

pi is a global npm package:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Verify:

```bash
pi --version
```

## 2. Drop this folder into ~/.pi/agent

```bash
mkdir -p ~/.pi
cp -a pi/. ~/.pi/agent/
```

That's the whole profile — settings, MCP config, extensions, skills, themes,
prompts, and the append-system rules.

## 3. What regenerates on its own

On first launch pi recreates the bits we deliberately left out:

| Path              | Why it's not committed                  |
|-------------------|------------------------------------------|
| `sessions/`       | 4 GB+ of session logs, per-machine       |
| `git/`            | cloned package repos (see `settings.json` `packages`) |
| `bin/`            | downloaded `fd` binary                   |
| `pi-fff/`         | fff index, rebuilt on demand             |
| `.kanban/`        | live kanban board state                  |
| `mcp-cache.json`  | MCP metadata cache                       |
| `auth.json`       | **secrets** — re-auth with `pi login`    |
| `models.json`     | may contain API keys/endpoints           |

So after copying, just run `pi login` (or whatever auth your provider needs)
and start `pi`. The `packages` listed in `settings.json`
(`pi-tmux`, `pi-notify`, `pi-guardrails`, `pi-mcp-adapter`) get cloned/installed automatically.

## 4. pi-mcp-adapter

`pi-mcp-adapter` is referenced as `npm:pi-mcp-adapter@2.5.4` in `settings.json`
`packages` — pi installs it from npm on first run, same as the other packages.
No manual step needed. The original machine used a local dev path and a symlink
into `/usr/lib`; both are replaced by the pinned npm reference so the setup is
fully reproducible off this machine.
