# AGENTS.md — SPL Visualizer Working Notes

This project is a React/Vite Docker SPL configurator with a generated-view backend. Treat the main app as trusted code and generated workspaces as untrusted runtime artefacts.

## Golden rules

- Do **not** put generated user code under `src/`.
- Generated views belong in `generated-workspaces/:id/src/View.tsx` and build to `generated-dist/:id/`.
- Keep `index.html` and `src/main.tsx` in generated workspaces as trusted templates controlled by the server.
- The only file the coding agent/opencode should edit for a generated job is `src/View.tsx`.
- Do not write API keys or secrets into `opencode.json`, generated source files, logs, or static artefacts.
- Run validation before building generated views.
- Build generated views with `vite.generated.config.ts`, not the main Vite config.

## Important files

```text
src/views/GeneratedViews/GeneratedViews.tsx  # user-facing prompt/upload/status UI
server/index.js                              # HTTP API, SSE, main app/static generated serving
server/worker.js                             # queue and generation lifecycle
server/opencode.js                           # opencode/vLLM integration
server/validation.js                         # generated View.tsx policy checks
server/store.js                              # SQLite metadata
server/config.js                             # env vars, paths, models config
vite.generated.config.ts                     # generated-view Vite build
```

## Runtime artefacts

These are intentionally git-ignored:

```text
generated-workspaces/
generated-dist/
data/
```

Do not commit them. If you create smoke-test artefacts, clean them up afterwards.

## opencode/vLLM workflow — single view per job

The generation worker creates **one View.tsx per job**. Each job produces exactly one generated view.
If the user wants to improve it, they use the "Enhance" feature which triggers a second opencode pass
on the same workspace to rewrite View.tsx with the enhancement instructions.

The generation worker reads model defaults from:

```text
~/.pi/agent/models.json
```

Default provider is `llm2go`.

Relevant env vars:

```bash
PI_MODELS_CONFIG=/home/wegerer/.pi/agent/models.json
PI_MODEL_PROVIDER=llm2go
VLLM_BASE_URL=...
VLLM_MODEL=...
VLLM_API_KEY=...

OPENCODE_BIN=npx
OPENCODE_ARGS='-y opencode-ai@latest'
OPENCODE_ENABLED=true
OPENCODE_TIMEOUT_MS=300000
OPENCODE_FALLBACK_TEMPLATE=false
```

`server/opencode.js` writes a per-workspace `opencode.json` using `@ai-sdk/openai-compatible`. It maps a safe opencode model alias to the actual vLLM model ID. The API key must be referenced as `{env:VLLM_API_KEY}`, not inlined.

## Generated `View.tsx` contract

Generated views must:

- export `meta`
- export a default React component
- be self-contained
- use TypeScript/TSX
- avoid external network calls unless explicitly allowed
- avoid secrets, environment variables, browser storage for sensitive data, tracking code, and dangerous APIs
- stay reasonably small

Validation currently rejects suspicious patterns including `process.env`, `eval`, `fetch`, `WebSocket`, `localStorage`, `sessionStorage`, `dangerouslySetInnerHTML`, and Node/process imports.

## Development commands

```bash
npm install
npm run dev
npm run server
npm run build
npm run lint
```

For local full-stack development, run `npm run server` and `npm run dev` in separate terminals. Vite proxies `/api` and `/gen` to the server on port `8787`.

For production-ish testing:

```bash
npm run build
npm run server
```

## Validation before handover

At minimum run:

```bash
npm run build
npm run lint
```

If touching generation, run a smoke test. For deterministic fallback smoke tests:

```bash
OPENCODE_ENABLED=0 OPENCODE_FALLBACK_TEMPLATE=true npm run server
```

Then create a job via the UI or API and verify it reaches `ready` and serves `/gen/:id`.

## Security posture

This is prototype isolation, not a bulletproof sandbox. Keep process boundaries clean so the worker can later move into a separate container. Do not loosen validation, CSP, or permissions casually — that is how things get spicy in the wrong way.

## Enhance workflow

When a view reaches `ready`, the user can submit enhancement instructions via the UI.
The server triggers a new opencode pass on the existing workspace (same `src/View.tsx`).

**Enhance API**: `POST /api/generation-jobs/:id/enhance` with `{ instructions: string }`.

**Enhance stages**: `enhancing` → `validating` → `building` → `publishing` → `ready`.

**Enhance prompt**: Includes the current View.tsx content so opencode knows what to improve.

The enhance feature uses the same model and permissions as initial generation.
