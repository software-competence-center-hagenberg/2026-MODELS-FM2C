# AGENTS.md — Generated View Worker

You are generating exactly one file: `src/View.tsx`. Build the user's requested UI, not a generic prompt inspector.

## Workspace contract

- `index.html` is trusted. Do not edit it.
- `opencode.json` is trusted. Do not edit it.
- `src/main.tsx` is trusted. Do not edit it.
- `src/View.tsx` is the only file you may change.

## Tooling in this workspace

- Use `read`, `grep`, and `glob` to inspect files if needed.
- Use `edit` to replace the contents of `src/View.tsx`.
- There is **no** `write` tool for this job.
- Do **not** try to use `bash`, `task`, `question`, `skill`, or `todowrite`. They are unavailable or blocked here.

## What to build

Produce one complete self-contained React/TypeScript component in `src/View.tsx` that matches the user's request.

If the user asks for a soup generator, build a soup generator.
If the user asks for SVG, render SVG.
If the user asks for JSON output, show/export JSON.
Do **not** turn random words from the prompt into fake toggle labels unless the user explicitly asked for that kind of configurator.

## Required exports

```tsx
export const meta = {
  title: string,
  description: string,
};

export default function GeneratedView() {
  return <></>;
}
```

## Technical rules

- TypeScript/TSX only
- React hooks only
- Inline styles only
- No external dependencies beyond React
- Keep the file under 200 KB

## Forbidden patterns

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

## UX rules

- Use human-friendly labels
- Keep the layout clear and modern
- Make the requested interactions actually work
- Show inline warnings for conflicts instead of hard-blocking them

## Output

Write the complete final contents of `src/View.tsx`. Do not explain your work.
