# AGENTS.md — Generated View Worker

## Project Overview

This project generates a single settings/configuration UI view for an application. Given an application name, its current configuration file (INI/config format), and a user prompt describing the desired UI, the agent produces a self-contained React component that exposes the configuration through a user-friendly interface.

The goal is to turn cryptic, error-prone config files into safe, discoverable settings UIs that prevent users from creating invalid states.

## Inputs

The agent will receive:

1. **Application name** -- used in titles, headings, and branding.
2. **Configuration file** -- the current INI/config file. Every key in this file is a setting that must be representable in the generated UI.
3. **User prompt** -- natural-language description of what the view should look like or do.
4. **MCP Server** -- Access to a React/Vite MCP server that should be used for setup.

## Workspace contract

- `index.html` is trusted. Do not edit it.
- `opencode.json` is trusted. Do not edit it.
- `src/main.tsx` is trusted. Do not edit it.
- `src/View.tsx` is the only file you may change.

## Tooling in this workspace

- Use `read`, `grep`, `glob`, and `list` to inspect files if needed.
- Use `edit` to replace the contents of `src/View.tsx`.
- There is **no** `write` tool for this job.
- Do **not** try to use `bash`, `task`, `question`, `skill`, or `todowrite` for this job.

## Required Output

A single self-contained React/TypeScript component in `src/View.tsx` that exposes all settings from the input config file. The component must match the user's prompt while faithfully representing every config key.

### Required exports

```tsx
export const meta = {
  title: string,
  description: string,
};

export default function GeneratedView() {
  return <></>;
}
```

## Design Rules

### 1. Use descriptive labels, not config keys

- Bad: `max_conn_retries`
- Good: "Maximum connection retry attempts"

Add short helper text or tooltips when the setting's purpose is non-obvious.

### 2. No ambiguous inputs

Pick the most constrained input control that fits the value's domain:

| Value domain | Use |
|---|---|
| Fixed set of options (6 or fewer) | Radio group or segmented control |
| Fixed set of options (more than 6) | Dropdown / select |
| Boolean | Toggle / switch |
| Bounded numeric range | Slider with numeric input |
| Free-form string with format rules (URL, regex, path, email, etc.) | Text field with placeholder showing the format and client-side validation |
| Color | Color picker |
| File / directory path | Path input with picker if possible |

If a text field accepts only a few values, it must become a dropdown. If it accepts many values but with a known format, the format must be documented inline and validated.

### 3. Warn on incompatible combinations

When two or more settings should not be enabled together (or require each other), display an inline warning (not a silent block) explaining the conflict and the recommended fix.

### 4. Match the user prompt

If the user asks for SVG output, render SVG. If they ask for JSON export, show/export JSON. Do **not** turn random words from the prompt into fake toggle labels unless the user explicitly asked for that kind of configurator. Every setting from the input config must be representable in the UI.

## Technical Rules

- TypeScript/TSX only
- React hooks only
- Inline styles only
- No external dependencies beyond React
- Keep the file under 200 KB

## Forbidden Patterns

Do not use:

- `process.env`
- `node:fs` or other Node imports
- `child_process`
- `eval()` or `new Function()`
- `fetch`, `XMLHttpRequest`, `WebSocket`
- `localStorage`, `sessionStorage`, `indexedDB`
- `dangerouslySetInnerHTML`
- `document.cookie`
- `require()`

## Definition of Done

Before considering the task complete, verify:

- [ ] Every setting from the input config is representable in the UI.
- [ ] No raw config keys are exposed as visible labels.
- [ ] No plain text field is used for a value with a fixed set of options.
- [ ] Every free-form text field with a non-trivial format has both a placeholder and validation.
- [ ] Incompatible setting combinations trigger a visible warning.
- [ ] The component exports `meta` and a default `GeneratedView` function.
- [ ] The file contains no forbidden patterns.

## Things to Avoid

- Exposing raw INI keys as labels in the UI.
- Silent validation — always tell the user what is wrong and how to fix it.
- Hard-blocking conflicting settings instead of warning. The user decides.
- Inventing settings that aren't in the input config.
- Over-engineering the layout — keep it clear and functional.

## Output

Write the complete final contents of `src/View.tsx`. Do not explain your work.
