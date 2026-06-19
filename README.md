# Docker SPL Configurator + Generated View Workflow

A React/Vite Software Product Line (SPL) configurator for Docker Compose stacks, with a chat-driven pipeline for generating standalone configurator views.

The key thing: the trusted main app is built once. User-generated configurator pages are AI-generated, validated, built, and served through a separate pipeline under `/gen/:id`.

---

## Project Structure

```
spl-visualizer/
├── src/                          # Trusted frontend (built once, never regenerated)
│   ├── App.tsx                   # Root — currently just wraps GeneratedViews
│   ├── main.tsx                  # Vite entry point
│   ├── index.css                 # Global styles
│   └── views/
│       └── GeneratedViews/
│           └── GeneratedViews.tsx  # Main UI — prompt input, job list, SSE progress, preview
│
├── server/                       # Node.js API server (no Express, just node:http)
│   ├── index.js                  # HTTP router — handles /api/*, /gen/:id, /gen-preview/:id, static
│   ├── worker.js                 # Queue worker — orchestrates preparing → generating → validating → building → publishing
│   ├── opencode.js               # Spawns opencode run inside isolated workspaces
│   ├── validation.js             # Checks generated View.tsx (exports, blocked APIs, TS parse)
│   ├── store.js                  # SQLite persistence for jobs and uploaded files
│   ├── events.js                 # SSE event helpers for real-time progress
│   └── config.js                 # Paths, env vars, model config (env vars)
│
├── data/                         # Runtime only (gitignored)
│   └── generated-views.sqlite    # Job metadata + uploaded files
│
├── generated-workspaces/         # Runtime only (gitignored)
│   └── :id/
│       ├── index.html            # Trusted template (fixed)
│       ├── opencode.json         # AI provider + permission config
│       ├── AGENTS.md             # Copied from project root (agent instructions)
│       └── src/
│           ├── main.tsx          # Trusted template (imports View)
│           └── View.tsx          # AI-generated file — the only thing opencode edits
│
├── generated-dist/               # Runtime only (gitignored)
│   ├── .tmp/:id/                 # Staging build output
│   └── :id/                      # Published static artefact (served at /gen/:id)
│
├── vite.config.ts                # Trusted main app build pipeline
├── vite.generated.config.ts      # Per-view build pipeline (roots at generated-workspaces/:id/)
├── package.json
└── AGENTS.md                     # Agent instructions (copied into each workspace)
```

---

## Two Pipelines, One Server

### 1. Trusted Frontend

Built once with `npm run build`. Served statically from `dist/`. Never touches generated code. Currently contains a single view (`GeneratedViews`) that lets users:

- Type a prompt (and optionally upload files)
- Trigger AI generation via `POST /api/generation-jobs`
- Watch real-time progress via SSE (`GET /api/generation-jobs/:id/events`)
- Preview in-progress builds via `POST /api/generation-jobs/:id/preview`
- Enhance existing views via `POST /api/generation-jobs/:id/enhance`
- Browse and delete past jobs

### 2. Generated View Pipeline

Each job gets its own isolated workspace under `generated-workspaces/:id/`. The worker processes jobs sequentially through these stages:

```
queued → preparing → generating → validating → building → publishing → ready
                                                       ↘ error
```

| Stage | What happens |
|---|---|
| **preparing** | Creates workspace, writes trusted `index.html` + `src/main.tsx`, copies `AGENTS.md` |
| **generating** | Runs `opencode run --pure` to produce `src/View.tsx`. Falls back to deterministic regex template if opencode leaves placeholder behind |
| **validating** | Checks for `meta` export, default export, blocked APIs (`eval`, `fetch`, `fs`, etc.), TypeScript parse |
| **building** | Runs `vite build` via `vite.generated.config.ts` → `generated-dist/.tmp/:id/` |
| **publishing** | Atomic rename from `.tmp/:id/` → `:id/` |

---

## Security Isolation

The generated code is untrusted. Safeguards include:

- Generated code lives **outside** `src/` — never dynamically imported into the main app
- Opencode runs in an isolated workspace with no network access (`webfetch: "deny"`)
- Generated `View.tsx` is validated before build (blocked APIs, size limits, TypeScript parse)
- Generated pages are **static** — no server-side rendering or dynamic evaluation
- Served with a restrictive CSP: `default-src 'none'; script-src 'self' 'unsafe-inline'; ...`
- Iframe previews use `sandbox="allow-scripts"`
- Path escape checks prevent directory traversal in static serving

**For production:** split the API server and generation worker into separate containers with a restricted filesystem and no production secrets. That's the sensible next hardening step — otherwise it gets a bit dodgy.

---

## API Routes

```http
POST   /api/generation-jobs             # Create a new generation job
GET    /api/generation-jobs             # List recent jobs
GET    /api/generation-jobs/:id         # Get job status
GET    /api/generation-jobs/:id/events  # SSE stream for real-time progress
POST   /api/generation-jobs/:id/enhance # Re-run opencode with new instructions
POST   /api/generation-jobs/:id/preview # Trigger preview build (during generating/validating)
GET    /api/views                       # List all non-deleted views
DELETE /api/views/:id                   # Delete a view (workspace + dist)
GET    /gen/:id                         # Serve generated static page
GET    /gen/:id/assets/:asset           # Serve generated static assets
GET    /gen-preview/:id                 # Serve preview build (during generation)
```

---

## Commands

```bash
npm install
npm run dev              # Frontend dev server (proxies /api and /gen to :8787)
npm run server           # API + generated static file server
npm run build            # Typecheck + build trusted main app
npm run build:generated  # Build one generated workspace (requires GENERATED_VIEW_ID)
npm run lint
```

**Local development** (two terminals):

```bash
# Terminal 1
cd spl-visualizer && npm run server

# Terminal 2
cd spl-visualizer && npm run dev
```

**Production-ish** (single server):

```bash
cd spl-visualizer && npm run build && npm run server
```

---

## Docker

The app can run as a single container: it serves the built trusted frontend, exposes the Node API, and keeps generated views in persistent volumes.

```bash
cd spl-visualizer
cp .env.example .env
# edit .env and set VLLM_BASE_URL, VLLM_MODEL and VLLM_API_KEY
docker compose up --build
```

Open: <http://localhost:8787/docker/>

Useful commands:

```bash
docker compose logs -f
docker compose down
docker compose down -v   # also removes generated views and SQLite metadata
```

Notes:

- `Dockerfile` installs project dev dependencies intentionally, because generated configurators are Vite-built at runtime.
- `opencode-ai` is installed globally in the image. Pin it with `OPENCODE_VERSION=1.17.7 docker compose build` if `latest` gets spicy.
- Runtime state is stored in the named volumes mounted at `/app/data`, `/app/generated-workspaces`, and `/app/generated-dist`.



---

## AI Configuration

The worker runs `opencode run` once per generation job. Model/provider settings are configured via environment variables in `.env`:

```bash
VLLM_BASE_URL=https://vllm-api.scch.at/v1
VLLM_MODEL='Qwen/Qwen3.6-27B-FP8 - Reasoning OFF'
VLLM_API_KEY=your-api-key
PI_MODEL_PROVIDER=llm2go
```

The API key is **never** written into `opencode.json` — it's referenced as `{env:VLLM_API_KEY}` and passed only through the child process environment.

### Useful environment variables

```bash
# Model config
VLLM_BASE_URL=https://vllm-api.scch.at/v1
VLLM_MODEL='Qwen/Qwen3.6-27B-FP8 - Reasoning OFF'
VLLM_API_KEY=...

# opencode
OPENCODE_ENABLED=true            # Force enable (default: auto-detect)
OPENCODE_TIMEOUT_MS=600000       # Max runtime per generation (default: 10 min)
OPENCODE_FALLBACK_TEMPLATE=true  # Use deterministic template instead of opencode
```

Default opencode command:

```bash
npx -y opencode-ai@latest run --model llm2go/<safe-model-alias> --pure <prompt>
```

---

## Generated Workspace Contract

For each job, the system creates:

```
generated-workspaces/:id/
  index.html       # Trusted template
  opencode.json    # Generated provider + permission config
  AGENTS.md        # Agent instructions
  src/
    main.tsx       # Trusted template
    View.tsx       # Only file opencode should edit
```

`src/View.tsx` must:

- Export `meta` (`export const meta = { title: string, description: string }`)
- Export a default React component (`export default function GeneratedView()`)
- Be self-contained — React hooks only, no external dependencies
- Avoid backend/API calls: no `process.env`, `eval`, `fetch`, `WebSocket`, `localStorage`, etc.

---

## Troubleshooting

### `opencode is not available`

```bash
npx -y opencode-ai@latest --version
```

Or set:

```bash
OPENCODE_BIN=opencode
OPENCODE_ARGS=''
```

if it's installed globally.

### Wrong model or endpoint

```bash
node -e "import('./server/config.js').then(c => console.log({ base: c.VLLM_BASE_URL, model: c.VLLM_MODEL, provider: c.PI_MODEL_PROVIDER }))"
```

### Need deterministic fallback for testing

```bash
OPENCODE_ENABLED=0 OPENCODE_FALLBACK_TEMPLATE=true npm run server
```

This bypasses opencode and uses the built-in deterministic template generator.
