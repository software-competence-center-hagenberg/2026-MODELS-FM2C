## Tool Usage (Hard Rules)
- `edit` tool: `edits` must be a **flat JSON array** of `{oldText, newText}` objects — never nested, never serialised as a string.

## Kanban Board

You have access to a kanban board using /kanban. Focus on solving tasks from there.

### Task lifecycle
- Use `kanban_task` (action: `list`) to inspect the board at the start of a session.
- Move a task to `in-progress` (action: `move_status`) before starting work on it.
- Update `context` (action: `set_context`) with relevant notes as you make progress.
- Move to `done` when the task is fully complete.

## Swarming

You can use tmux to create new pi instances. Use the already existing tmux instance and append new instances there.

### Semaphore locks (extensions/pi-semaphore)
- Commands:
  - /lock <name> — create a named lock.
  - /release <name> — release a lock.
  - /wait <name> [name...] — wait until a lock is released.
  - /lock-list — list existing locks.
- Tool:
  - semaphore_wait — blocking wait for a lock; use for coordinating tmux agents.

## Decisions

Use the decision extensions if you are unsure on how to implement a feature.

## Searching Documentation

When working with technology where you are unsure about the implementation use the search_docs skill to find up to date information on React, Ionic, dotnet etc.

## MCP Extension (pi-mcp-adapter)

You have the `pi-mcp-adapter` extension installed, which connects you to MCP servers. Here's how to use it:

### Proxy tool: `mcp()`

The `mcp` tool is your gateway to MCP servers. It uses a **two-call pattern**:

1. **Discover** — `mcp({ search: "<keywords>" })` finds tools across all configured servers. Space-separated words are OR'd. Search also includes your built-in Pi tools (they appear first with a `[pi tool]` prefix).
2. **Call** — `mcp({ tool: "<tool_name>", args: '{"key": "value"}' })` executes the tool.

**Important: `args` must be a JSON string, not an object.** `mcp({ tool: "x", args: '{"url": "..."}' })` — never `args: { url: "..." }`.

Other proxy actions:
- `mcp({ })` — server status overview
- `mcp({ server: "<name>" })` — list tools for a specific server
- `mcp({ describe: "<tool_name>" })` — show a tool's parameters
- `mcp({ connect: "<server-name>" })` — force connect / refresh metadata
- `mcp({ action: "ui-messages" })` — get messages from interactive UI sessions

### Direct tools

If a server has `directTools` configured, those tools appear in your normal tool list (e.g. `server_get_file_contents`). Use them directly — no `mcp()` proxy call needed.

### When to use MCP vs built-in tools

- Prefer built-in tools (`read`, `grep`, `bash`, `find_files`) for local file work
- Use the `mcp` proxy or direct MCP tools for external services: browsers, APIs, databases, design tools, CI systems, etc.
- Run `/mcp` for an interactive panel showing all servers, connection status, and tool toggles
- Run `/mcp setup` to configure or import MCP server configs
