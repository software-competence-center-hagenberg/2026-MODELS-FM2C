# fm2c — Software Product Line Configurator with AI-Generated Views

**fm2c** is a React/Vite application that lets users describe a Software Product Line (think SaaS tiers, Docker Compose stacks, car model lineups) and get back a working, interactive configurator dashboard — generated on the fly by an AI coding agent.

It's a **two-process system**: a trusted host app that handles UI and orchestration, and an untrusted generation pipeline that spawns [opencode](https://opencode.ai) in a locked-down workspace to produce self-contained React views. The generation agent is guided by [AGENTS.md](./AGENTS.md) — a specification that defines the SPL visualizer contract, including module selection views, UVL modelling, strategic conflict detection, and MCP server integration.

---

## Architecture

```
┌─────────────────┐     Valkey Queue      ┌──────────────────┐
│   API Server    │◄──────────────────────►│     Worker       │
│  (server/api.js)│     (pub/sub +        │ (worker-standalone│
│                 │      BLPOP/RPUSH)      │    .js)          │
│  - HTTP router  │                       │                  │
│  - SSE streams  │                       │  - dequeues jobs  │
│  - static files  │                       │  - runs pipeline  │
│  - SQLite store  │                       │  - spawns opencode│
└────────┬────────┘                       └────────┬─────────┘
         │                                          │
         ▼                                          ▼
┌─────────────────┐                       ┌──────────────────┐
│  Trusted dist/   │                       │  Generated views │
│  (built once)    │                       │  /gen/:id        │
│  src/App.tsx     │                       │  (Vite-built,     │
│  → frontend UI   │                       │   static pages)   │
└─────────────────┘                       └──────────────────┘
```

| Process | Role | Container |
|---------|------|-----------|
| **API Server** (`server/api.js`) | Serves the trusted frontend (built once from `src/`), handles REST API, streams SSE events, reads/writes job metadata in SQLite | `Dockerfile.api` |
| **Worker** (`server/worker-standalone.js`) | Polls Valkey for jobs, runs the 6-stage pipeline (preparing→generating→validating→building→publishing→ready), spawns `opencode` in isolated workspaces, runs Vite builds | `Dockerfile.worker` |

Two processes because the generation pipeline is CPU/IO-heavy (LLM calls, Vite builds) and runs untrusted AI-generated code. Keeping it separate means the API stays responsive, the worker can be locked down independently (iptables egress, restricted filesystem), and they scale independently via the shared Valkey queue.

---

## The Trusted / Generated Split

**Trusted side** (`src/`): built once by `npm run build`, served from `dist/`. Contains the UI for submitting prompts, watching job progress, and browsing generated views. Never dynamically imports or evaluates generated code. Written by developers, committed to git.

**Generated side** (`generated-workspaces/:id/`): created at runtime per generation job. Contains `src/View.tsx` — a self-contained React component produced by an AI agent. Validated, built into static HTML/JS, served at `/gen/:id/` with a restrictive CSP. Never executed on the server — no SSR, no dynamic evaluation. Treated as untrusted input at every stage.

---

## Generation Pipeline

Each job progresses through a deterministic state machine:

```
queued → preparing → generating → validating → building → publishing → ready
                                                                   ↘ error
                                (any stage)                        → deleted
```

### 1. Queued
Pushed onto a Valkey list (`RPUSH spl_jobs_queue`). The worker picks it up via `BLPOP` (blocking pop, 5-second timeout). The standalone worker loop distinguishes regular jobs from enhancements and previews by prefix (`enhance:` and `preview:`).

### 2. Preparing
Creates an isolated workspace at `generated-workspaces/:id/`:
- Writes a trusted `index.html` template
- Writes a trusted `src/main.tsx` (imports and mounts the generated View)
- **Copies `AGENTS.md`** from the project root into the workspace — this is the instruction set the spawned agent uses
- Generates an `opencode.json` with the AI provider config and **restrictive permissions**

### 3. Generating

**Default path — opencode** (`server/opencode.js`):
Spawns `opencode run --pure <prompt>` as a child process with a 20-minute timeout. The prompt includes:
- The user's request (sanitised, wrapped in opaque nonced tags to prevent prompt injection)
- Uploaded file contents (capped at per-file and total char budgets)
- Requirements: export `meta`, export default component, self-contained React, no blocked APIs
- Explicit tool instructions: use `edit` on the existing `src/View.tsx`; inspect with `read`/`grep`/`glob`/`list`; do not try `bash`/`task`/`question`/`skill`/`todowrite`

Output from opencode is streamed to the browser via SSE line by line. Default plugins stay enabled so the normal file-editing tools exist; `opencode.json` permissions then narrow that down to the generated workspace. If opencode fails or leaves the placeholder behind, the job now **fails loudly** instead of emitting a deterministic fake configurator.
### 4. Validating (`server/validation.js`)
A multi-layer gate:

1. **Workspace walk** — rejects symlinks, unexpected files, extra directories
2. **Trusted file integrity** — `index.html` and `src/main.tsx` compared **byte-for-byte** against known-good templates
3. **View.tsx checks** — size ≤ 200 KB, must export `meta` + default component, **blocked API scan** (regex for `node:fs`, `child_process`, `process.env`, `eval`, `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `dangerouslySetInnerHTML`, etc.)
4. **TypeScript strict parse** — transpiles with `strict: true`, rejects any diagnostic error

### 5. Building
Runs `vite build` via `vite.generated.config.ts` rooted at the workspace. Outputs to `generated-dist/.tmp/:id/`. 60-second timeout.

### 6. Publishing
Atomic rename from `.tmp/:id/` → `:id/`. Path escape assertions prevent directory traversal.

### 7. Ready
SQLite status updated, SSE event published, view live at `/gen/:id/`.

### Enhancement Flow
Existing ready views can be enhanced via `POST /api/generation-jobs/:id/enhance`. The worker reads the current `View.tsx`, wraps it in a new prompt with the enhancement instructions, re-runs opencode, then re-validates, re-builds, and re-publishes.

---

## How Opencode Integrates AGENTS.md and MCP

When a generation job runs:

1. **`AGENTS.md` is copied** into the workspace by the `preparing` stage (line 145 of `server/worker.js`: `fs.copyFileSync(AGENTS_MD_PATH, ...)`)
2. **`opencode.json`** is written alongside it by `writeOpencodeConfig()` in `server/opencode.js` — this configures the AI provider and a strict permission sandbox:

```json
{
  "model": "llm2go/Qwen3.6-27B-FP8-Reasoning-OFF",
  "provider": {
    "llm2go": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://vllm-api.scch.at/",
        "apiKey": "{env:VLLM_API_KEY}"
      },
      "models": { "Qwen3.6-27B-FP8-Reasoning-OFF": { "id": "Qwen3.6-27B-FP8 - Reasoning OFF" } }
    }
  },
  "permission": {
    "read":     { "*": "allow" },
    "edit":     { "src/View.tsx": "allow", "*": "deny" },
    "bash":     { "*": "deny" },
    "webfetch": "deny",
    "websearch": "deny",
    "task":     "deny",
    "external_directory": "deny",
    "question": "deny"
  }
}
```

3. The agent reads `AGENTS.md` as its primary instruction set

**What AGENTS.md tells the spawned agent:**

- **The SPL visualizer contract**: every generated view must let users select/deselect modules, maintain shared configuration state, and produce a downloadable config file (Helm chart, docker-compose, IaC, etc.)
- **Three distinct views**: the agent must produce 3 structurally different configurator screens using different UI libraries and CSS approaches — not the same layout recoloured
- **Design rules**: use strategic labels ("Mid-size sedan for urban professionals") over technical keys, never expose raw product codes, always flag strategic conflicts with inline warnings
- **UVL modelling**: start with a UVL diagram to model modules (required, optional, alternative) before generating views
- **MCP server access**: the agent has access to an MCP server for generating the React/Vite output application
- **Tech stack**: React 19+, TypeScript, Vite, validation with zod, varied charting libraries (Recharts, D3, custom SVG)

**What the permission sandbox prevents:**
The agent can **read** any file in the workspace, **edit** only `src/View.tsx`. Cannot run bash, fetch URLs, access directories outside the workspace. At the container level, `server/worker-entrypoint.sh` installs **iptables egress rules** — only loopback, DNS, Valkey, and the LLM provider are reachable. Everything else is REJECT'd. This is defence-in-depth: even if prompt injection bypasses the sanitisation fence, the agent can't exfiltrate data.

---

## Security Model (Layered Defence)

| Layer | Mechanism | Enforced by |
|-------|-----------|-------------|
| **Filesystem isolation** | Generated views live outside `src/`, never imported by the main app | Project structure |
| **Workspace integrity** | Rejects unexpected files, symlinks, extra directories | `validation.js` |
| **Trusted template integrity** | Byte-for-byte comparison of `index.html` / `main.tsx` against known-good | `validation.js` |
| **Code validation** | Blocked API regex scan, strict TS parse, size limit | `validation.js` |
| **Permission sandbox** | Opencode can only edit `src/View.tsx`, no bash/network | `opencode.json` |
| **Prompt injection defence** | User input wrapped in opaque nonced tags, backticks defanged | `sanitise.js` |
| **Network egress lockdown** | iptables: only Valkey + LLM provider reachable; all else REJECT'd | `worker-entrypoint.sh` |
| **Static serving** | Restrictive CSP (`default-src 'none'`), `isInside()` path traversal check, no SSR | `server/index.js` / `api.js` |
| **Secrets handling** | API keys passed via env, never written to disk, redacted from error responses | `opencode.js` / `api.js` |
| **File upload limits** | 8 file limit, 512 KB per file, 2 MB total, char-budgeted in prompts | `worker.js` |

---

## API Routes

```
POST   /api/generation-jobs                # Create job (body: { prompt, files? })
GET    /api/generation-jobs/:id             # Get job status
GET    /api/generation-jobs/:id/events      # SSE stream for real-time progress
POST   /api/generation-jobs/:id/enhance     # Re-run opencode with new instructions
POST   /api/generation-jobs/:id/preview     # Trigger preview build during generation
GET    /api/views                           # List all non-deleted views
DELETE /api/views/:id                       # Delete a view (workspace + dist)
GET    /gen/:id                             # Serve generated static page
GET    /gen/:id/assets/*                    # Serve generated assets
GET    /gen-preview/:id                     # Serve live-transpiled preview during generation
GET    /docker                              # Static example app (Docker Compose)
GET    /firefox                             # Static example app (Firefox config)
```

---

## Docker Deployment

### Production: Two Containers + Valkey

```
┌─────────────────┐     Valkey 6379     ┌──────────────────────┐
│  API Server     │◄───────────────────►│  Worker              │
│  port 8787      │   pub/sub + queue   │  CAP_NET_ADMIN       │
│  stateless      │                     │  iptables egress     │
│  no opencode    │                     │  lock + opencode     │
└────────┬────────┘                     └─────────┬────────────┘
         │                                         │
         ▼                                         ▼
┌─────────────────┐                     ┌──────────────────────┐
│  SQLite          │                     │  generated-          │
│  (data volume)   │                     │  workspaces/         │
│                  │                     │  generated-dist/     │
└─────────────────┘                     └──────────────────────┘
```

#### API Container (`Dockerfile.api`)
- Lightweight: serves built frontend + API routes
- No opencode installed
- Removes `npm`/`npx` from final image to reduce CVE surface
- Debian trixie base, `node` user, read-only `/app` except data volumes
- Healthcheck: hits `/api/health`

#### Worker Container (`Dockerfile.worker`)
- Heavier: `opencode-ai` installed globally (pin version with build arg)
- `CAP_NET_ADMIN` for iptables, `no-new-privileges:true`
- Removes `npm`/`npx` from final image
- Entrypoint script (`worker-entrypoint.sh`) sets up iptables, then `exec node server/worker-standalone.js`
- App source root-owned read-only; only data dirs writable by `node` user

### Local Development

```bash
# Two terminals:
npm run server            # Terminal 1 — API server at :8787
npm run dev               # Terminal 2 — Vite dev server with proxy

# Or with Docker:
cp .env.example .env
docker compose up --build

docker compose logs -f
docker compose down
docker compose down -v   # also removes generated views, SQLite, and Valkey data
```

---

## AI Provider Resolution

Priority in `server/config.js` via `resolveOpencodeProviderSettings()`:

1. `VLLM_BASE_URL` / `VLLM_API_KEY` / `VLLM_MODEL` set → use VLLM config (default: `https://vllm-api.scch.at/`, `Qwen3.6-27B-FP8 - Reasoning OFF`)
2. Only `OPENAI_*` vars set → use OpenAI-compatible config (default: `https://api.openai.com/v1`, `gpt-4.1-mini`)
3. Neither → auto-detect based on presence of any API key

The API key flows through `OPENAI_API_KEY` and `VLLM_API_KEY` env vars (both supported for backward compatibility), normalised to `VLLM_API_KEY` in the child process env. **Never written to disk** — referenced as `{env:VLLM_API_KEY}` in `opencode.json` and injected at spawn time. Error messages are scanned and redacted before reaching the browser.

---

## Env Vars

| Variable | Default | Description |
|----------|---------|-------------|
| `VLLM_API_KEY` | — | LLM provider API key |
| `VLLM_BASE_URL` | `https://vllm-api.scch.at/` | LLM provider endpoint |
| `VLLM_MODEL` | `Qwen3.6-27B-FP8 - Reasoning OFF` | Model ID |
| `OPENAI_API_KEY` | — | OpenAI-compatible API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI model ID |
| `VALKEY_URL` | `redis://valkey:6379` | Valkey connection string |
| `OPENCODE_ENABLED` | auto-detect | Force enable/disable opencode |
| `OPENCODE_TIMEOUT_MS` | 1200000 (20 min) | Max runtime per generation |
| `OPENCODE_VERSION` | latest | opencode-ai npm version for Docker build |
| `GENERATED_VIEW_TTL_HOURS` | 168 (7 days) | View retention |
| `MAX_FILE_PROMPT_CHARS` | 1500 | Per-file char budget in LLM prompt |
| `MAX_FILE_CONTEXT_CHARS` | 6000 | Total file context budget |
| `PI_MODEL_PROVIDER` | llm2go | Fallback model provider name |
