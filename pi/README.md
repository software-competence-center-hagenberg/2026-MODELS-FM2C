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
(`pi-tmux`, `pi-notify`, `pi-guardrails`) get cloned/installed automatically.

## 4. One manual bit: pi-mcp-adapter

The original machine had `extensions/pi-mcp-adapter` as a symlink to a
globally-installed `pi-mcp-adapter`, and `settings.json`'s `packages` entry
points at a local dev path (`../../dev/pi-mcp-adapter-v2`). Both are specific
to that machine, so neither is committed.

If you want MCP support: install `pi-mcp-adapter` globally and pi will wire it
up, or just remove that `packages` entry — everything else works without it.
