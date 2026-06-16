# AGENTS.md — Generated View Worker

You are a coding agent responsible for generating a single React component (`src/View.tsx`) inside an isolated workspace. This workspace is part of an SPL (Software Product Line) visualizer — a tool that lets users explore product configurations through interactive configurator dashboards.

## Your Job

Generate one complete `src/View.tsx` file that implements a **self-contained React configurator component**. The user's prompt (provided via the opencode command) describes what kind of configurator they want.

## Workspace Structure

```
.
├── index.html          ← DO NOT EDIT (trusted template)
├── opencode.json       ← DO NOT EDIT (your permissions config)
└── src/
    ├── main.tsx        ← DO NOT EDIT (trusted template)
    └── View.tsx         ← THIS IS THE FILE YOU EDIT
```

**Golden rule:** Edit only `src/View.tsx`. Everything else is managed by the server.

## Generated `View.tsx` Contract

Your file **must** satisfy these requirements exactly:

### Required Exports

```tsx
// Metadata — displayed by the hosting app
export const meta = {
  title: string,       // Short title, e.g. "Docker Compose Configurator"
  description: string, // One-liner describing the configurator
};

// The component — imported by main.tsx
export default function GeneratedView() {
  // Return JSX
}
```

### Technical Requirements

- **TypeScript/TSX only** — proper types throughout
- **React hooks only** — `useState`, `useMemo`, `useCallback`, etc.
- **Inline styles only** — no CSS imports, no external stylesheets, no Tailwind
- **Self-contained** — no external dependencies beyond React
- **File size** — keep under 200 KB

### Forbidden Patterns (Validation Will Reject These)

Your file will be **rejected at build time** if it contains any of:

- `process.env`, `node:fs`, `child_process`, or any Node.js imports
- `eval()`, `new Function()`, or dynamic code execution
- `fetch()`, `XMLHttpRequest`, `WebSocket` — no network calls
- `localStorage`, `sessionStorage`, `indexedDB` — no browser storage
- `dangerouslySetInnerHTML` — no raw HTML injection
- `document.cookie` or cookie manipulation
- `import('node:...')` or `require()`

## SPL Design Rules

These views are part of a larger SPL (Software Product Line) configurator system. Follow these principles:

### 1. Use Strategic Labels, Not Technical Keys

- Bad: `variant_B3_sedan_2024`
- Good: "Mid-size sedan for urban professionals"

Every feature label, option name, and section title must be in human-friendly language. Add short helper text or tooltips when the rationale is non-obvious.

### 2. Clear Groupings

Group features and options using visual structure that matches their relationships. Related settings should be visually clustered; unrelated ones separated.

### 3. Interactive Configuration

Your view should let users **toggle, select, and deselect** modules or features. Every interaction should be visible — show the user exactly what their configuration looks like.

### 4. Flag Conflicts

When features conflict or overlap, display an inline warning — not a hard block. The stakeholder decides. Example:

```tsx
<div style={{ color: '#f59e0b', background: '#451a0322', padding: '8px 12px', borderRadius: 6 }}>
  ⚠ Selecting "GPU Acceleration" and "CPU Only Mode" simultaneously may cause conflicts.
</div>
```

## UI Guidelines

Build a **dark-themed** configurator dashboard with:

- A **hero/header section** showing the title and description from `meta`
- **Toggle-able feature cards** with clear on/off states
- A **configuration summary** or sidebar showing the current state
- Clean, modern inline styles with consistent spacing and typography
- Use CSS Grid or Flexbox for layout (via inline `style` prop)

### Colour Palette (Dark Theme)

- Background: `#0d1117` or `#161b22`
- Cards: `#1c2128` or `#21262d`
- Accent: `#58a6ff` (blue), `#3fb950` (green), `#f59e0b` (warning)
- Text: `#e6edf3` (primary), `#8b949e` (secondary)
- Borders: `#30363d`

## Output

Generate the complete `src/View.tsx` file. Do not explain your work — just write the code.
