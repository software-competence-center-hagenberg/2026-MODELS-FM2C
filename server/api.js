// API server — serves static content, API routes, and SSE via Valkey pub/sub
// Run with: node server/api.js
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIST_DIR,
  EXAMPLES_DIR,
  ID_PATTERN,
  MAIN_DIST_DIR,
  MAX_UPLOAD_BYTES,
  OPENAI_API_KEY,
  PORT,
  VLLM_API_KEY,
  WORKSPACES_DIR,
  publicUrlFor,
} from './config.js';
import { writeSseEvent } from './events.js';
import { GenerationStore } from './store.js';
import { publishEvent, subscribeEvents, enqueueJob } from './queue.js';
import {
  createInitialView,
  createJobId,
  normaliseFiles,
  normalisePrompt,
} from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new GenerationStore();

// Track active SSE connections per job ID
const sseClients = new Map(); // id -> Set<response>

// Subscribe to Valkey events channel and forward to SSE clients
(async () => {
  try {
    await subscribeEvents(({ id, status, message, view }) => {
      const clients = sseClients.get(id);
      if (clients) {
        const event = status ?? 'message';
        const data = JSON.stringify({
          status,
          message: message ? stripKeyMessage(message) : undefined,
          view: view ? toPublicView(view) : undefined
        }).replace(/^\s+/, '');
        for (const res of clients) {
          if (!res.destroyed) {
            res.write(`event: ${event}\n`);
            res.write(`data: ${data}\n\n`);
          }
        }
        // Clean up if job is terminal
        if (status === 'ready' || status === 'error' || status === 'deleted') {
          // Keep connection open for a bit (client will close)
        }
      }
    });
    console.log('[api] subscribed to Valkey events channel');
  } catch (err) {
    console.error('[api] failed to subscribe to Valkey events:', err.message);
  }
})();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // Health check
    if (url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true });
    }

    // Create generation job
    if (url.pathname === '/api/generation-jobs' && request.method === 'POST') {
      return createGenerationJob(request, response);
    }

    // Get job status
    const jobStatusMatch = url.pathname.match(/^\/api\/generation-jobs\/([a-zA-Z0-9_-]{3,64})$/);
    if (jobStatusMatch && request.method === 'GET') {
      const view = store.getView(jobStatusMatch[1]);
      if (!view || view.status === 'deleted') return sendJson(response, 404, { error: 'Generated view not found.' });
      return sendJson(response, 200, toPublicView(view));
    }

    // SSE events
    const eventsMatch = url.pathname.match(/^\/api\/generation-jobs\/([a-zA-Z0-9_-]{3,64})\/events$/);
    if (eventsMatch && request.method === 'GET') {
      return streamJobEvents(eventsMatch[1], request, response);
    }

    // Enhance job
    const enhanceMatch = url.pathname.match(/^\/api\/generation-jobs\/([a-zA-Z0-9_-]{3,64})\/enhance$/);
    if (enhanceMatch && request.method === 'POST') {
      return handleEnhance(enhanceMatch[1], request, response);
    }

    // Preview trigger
    const previewMatch = url.pathname.match(/^\/api\/generation-jobs\/([a-zA-Z0-9_-]{3,64})\/preview$/);
    if (previewMatch && request.method === 'POST') {
      return triggerPreview(previewMatch[1], response);
    }

    // List views
    if (url.pathname === '/api/views' && request.method === 'GET') {
      return sendJson(response, 200, { views: store.listViews().map(toPublicView) });
    }

    // Delete view
    const deleteMatch = url.pathname.match(/^\/api\/views\/([a-zA-Z0-9_-]{3,64})$/);
    if (deleteMatch && request.method === 'DELETE') {
      return deleteView(deleteMatch[1], response);
    }

    // Serve generated view
    const generated = url.pathname.match(/^\/gen\/([a-zA-Z0-9_-]{3,64})(?:\/(.*))?$/);
    if (generated && request.method === 'GET') {
      return serveGeneratedView(generated[1], generated[2] ?? '', response);

    }
    // Serve static example apps (/firefox/* and /docker/*)
    const exampleMatch = url.pathname.match(/^(\/(firefox|docker))(?:\/(.*))?$/);
    if (exampleMatch && request.method === 'GET') {
      return serveExample(exampleMatch[2], exampleMatch[3] ?? '', response);
    }


    // Serve main app
    if (request.method === 'GET') {
      return serveMainApp(url.pathname, response);
    }

    return sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendJson(response, 500, { error: stripKeyMessage(message) });
  }
});

server.listen(PORT, () => {
  console.log(`FM2C API server listening on http://localhost:${PORT}`);
});

// --- Handlers ---

async function createGenerationJob(request, response) {
  const body = await readJsonBody(request);
  const prompt = normalisePrompt(body.prompt);
  const files = normaliseFiles(body.files);
  const existingIds = store.listViews().map((v) => v.id);
  const id = createJobId(prompt, existingIds);
  const view = createInitialView({ id, prompt, files });
  store.createView(view, files);
  
  // Enqueue in Valkey for the worker to pick up
  await enqueueJob(id);
  
  // Publish initial queued event
  await publishEvent(id, { status: 'queued', message: 'Generation job queued.' });
  
  return sendJson(response, 202, toPublicView(view));
}

function streamJobEvents(id, request, response) {
  if (!ID_PATTERN.test(id)) return sendJson(response, 404, { error: 'Generated view not found.' });
  const view = store.getView(id);
  if (!view || view.status === 'deleted') return sendJson(response, 404, { error: 'Generated view not found.' });

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  
  // Send current status immediately
  writeSseEvent(response, view.status, { status: view.status, view: toPublicView(view) });

  // Register this connection
  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(response);

  request.on('close', () => {
    sseClients.get(id)?.delete(response);
  });
}

async function handleEnhance(id, request, response) {
  const view = store.getView(id);
  if (!view || view.status === 'deleted') return sendJson(response, 404, { error: 'Generated view not found.' });
  if (view.status !== 'ready') {
    return sendJson(response, 409, { error: `Cannot enhance view with status '${view.status}'. It must be 'ready'.` });
  }

  const body = await readJsonBody(request);
  const instructions = body.instructions;
  if (!instructions || !String(instructions).trim()) {
    return sendJson(response, 400, { error: 'Enhancement instructions are required.' });
  }

  // For enhance, we need the worker to handle it. 
  // Store enhancement request in DB and enqueue special job.
  // For now, publish event and let worker handle via a special queue key.
  await publishEvent(id, { 
    status: 'enhancing', 
    message: `Enhancing view: ${String(instructions).slice(0, 100)}`,
    instructions: String(instructions).trim(),
  });
  
  // Re-enqueue for worker to process as enhance
  await enqueueJob(`enhance:${id}:${Buffer.from(String(instructions).trim()).toString('base64url')}`);
  
  const updated = store.updateStatus(id, 'enhancing');
  return sendJson(response, 202, toPublicView(updated));
}

async function triggerPreview(id, response) {
  const view = store.getView(id);
  if (!view || view.status === 'deleted') return sendJson(response, 404, { error: 'Generated view not found.' });
  if (view.status !== 'generating' && view.status !== 'validating') {
    return sendJson(response, 409, { error: 'Preview is only available while the job is generating or validating.' });
  }
  
  // For preview, the worker needs to build it. Enqueue preview job.
  await enqueueJob(`preview:${id}`);
  return sendJson(response, 200, { preview_url: `/gen-preview/${id}` });
}

function deleteView(id, response) {
  const view = store.getView(id);
  if (!view || view.status === 'deleted') return sendJson(response, 404, { error: 'Generated view not found.' });
  fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
  fs.rmSync(path.join(DIST_DIR, id), { recursive: true, force: true });
  const deleted = store.updateStatus(id, 'deleted');
  void publishEvent(id, { status: 'deleted', message: 'Generated view deleted.' });
  return sendJson(response, 200, toPublicView(deleted));
}

function serveGeneratedView(id, assetPath, response) {
  const view = store.getView(id);
  if (!view || view.status !== 'ready') {
    return sendNotFound(response);
  }

  const root = path.resolve(DIST_DIR, id);
  const requested = assetPath ? path.resolve(root, assetPath) : path.join(root, 'index.html');
  if (!isInside(root, requested)) return sendNotFound(response);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return sendNotFound(response);

  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  serveFile(requested, response);
}

function servePreview(id, assetPath, response) {
  const previewDir = path.resolve(DIST_DIR, '.tmp', id, 'preview');
  if (!fs.existsSync(previewDir) || !fs.statSync(previewDir).isDirectory()) return sendNotFound(response);

  const requested = assetPath
    ? path.resolve(previewDir, assetPath)
    : path.join(previewDir, 'index.html');
  if (!isInside(previewDir, requested)) return sendNotFound(response);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return sendNotFound(response);

  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  serveFile(requested, response);
}

// Serve static example apps
function serveExample(exampleName, assetPath, response) {
  const candidates = [
    path.resolve(MAIN_DIST_DIR, 'examples', exampleName),
    path.resolve(EXAMPLES_DIR, exampleName),
  ];
  let exampleDir = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      exampleDir = candidate;
      break;
    }
  }
  if (!exampleDir) return sendNotFound(response);

  const requested = assetPath
    ? path.resolve(exampleDir, assetPath)
    : path.join(exampleDir, 'index.html');
  if (!isInside(exampleDir, requested)) return sendNotFound(response);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return sendNotFound(response);

  response.setHeader('X-Content-Type-Options', 'nosniff');
  serveFile(requested, response);
}



function serveMainApp(urlPath, response) {
  const cleanPath = normaliseMainAppPath(urlPath);
  const requested = path.resolve(MAIN_DIST_DIR, `.${cleanPath}`);
  const fallback = path.join(MAIN_DIST_DIR, 'index.html');
  if (isInside(MAIN_DIST_DIR, requested) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
    return serveFile(requested, response);
  }
  if (fs.existsSync(fallback)) return serveFile(fallback, response);
  return sendJson(response, 404, { error: 'Main app has not been built yet. Run npm run build first.' });
}

function normaliseMainAppPath(urlPath) {
  if (urlPath === '/' || urlPath === '') return '/index.html';
  // Support assets/ for the built app
  if (urlPath.startsWith('/assets/')) return urlPath;
  // Fallback to SPA
  return '/index.html';
}

// --- Helpers ---

function serveFile(filePath, response) {
  response.writeHead(200, { 
    'Content-Type': mimeType(filePath), 
    'Cache-Control': filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' 
  });
  fs.createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload, null, 2));
}

function sendNotFound(response) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end('Not found');
}

function toPublicView(view) {
  if (!view) return null;
  return {
    id: view.id,
    title: view.title,
    description: view.description,
    status: view.status,
    public_url: view.public_url,
    created_at: view.created_at,
    updated_at: view.updated_at,
    expires_at: view.expires_at,
    error_message: stripKeyMessage(view.error_message),
  };
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
  }[ext] ?? 'application/octet-stream';
}

/**
 * Strip known API key values from any string that reaches the client.
 * Belt-and-suspenders: even if a dev later adds the key to an error path
 * by mistake, it won't end up in the browser.
 */
function stripKeyMessage(value) {
  if (typeof value !== 'string' || !value) return value;
  let s = value;
  if (VLLM_API_KEY) s = s.replaceAll(VLLM_API_KEY, '[KEY REDACTED]');
  if (OPENAI_API_KEY) s = s.replaceAll(OPENAI_API_KEY, '[KEY REDACTED]');
  return s;
}
