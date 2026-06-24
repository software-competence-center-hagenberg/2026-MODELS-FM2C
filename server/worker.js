import 'dotenv/config';


import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AGENTS_MD_PATH,
  APP_ROOT,
  DIST_DIR,
  ID_PATTERN,
  MAX_FILE_BYTES,
  MAX_PROMPT_CHARS,
  VIEW_TTL_HOURS,
  WORKSPACES_DIR,
  publicUrlFor,
} from './config.js';
import { trustedIndexHtml, trustedMainTsx, validateGeneratedView } from './validation.js';
import { isOpencodeAvailable, runOpencode, runOpencodeEnhance } from './opencode.js';

const STATUSES = ['preparing', 'generating', 'validating', 'building', 'publishing', 'ready'];
const ENHANCE_STATUSES = ['validating', 'building', 'publishing'];

export function createJobId(prompt, existingIds = []) {
	const slug = deriveSlug(prompt);
	if (!existingIds.includes(slug)) return slug;
	let i = 2;
	while (existingIds.includes(`${slug}-${i}`)) i++;
	return `${slug}-${i}`;
}

function deriveSlug(prompt) {
	const line = prompt.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
	const cleaned = line
		.replace(/^create\s+(a\s+)?/i, '')
		.replace(/[^a-z0-9\s-]/gi, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
	const result = cleaned.slice(0, 48) || 'configurator';
	return result.length < 3 ? 'configurator' : result;
}

export function normalisePrompt(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('Prompt is required.');
  return text.slice(0, MAX_PROMPT_CHARS);
}

export function normaliseFiles(files) {
  if (!Array.isArray(files)) return [];
  let total = 0;
  return files.slice(0, 8).map((file, index) => {
    const name = path.basename(String(file.name || `upload-${index + 1}.txt`)).slice(0, 140);
    const type = String(file.type || 'text/plain').slice(0, 100);
    const content = String(file.content ?? '').slice(0, MAX_FILE_BYTES);
    const size = Buffer.byteLength(content, 'utf8');
    total += size;
    if (total > 2 * 1024 * 1024) throw new Error('Uploaded files are too large.');
    return { name, type, size, content };
  });
}

export function createInitialView({ id, prompt, files }) {
  const now = new Date();
  const title = deriveTitle(prompt);
  const expiresAt = new Date(now.getTime() + VIEW_TTL_HOURS * 60 * 60 * 1000).toISOString();
  return {
    id,
    user_id: 'public-demo',
    title,
    description: `${files.length ? `${files.length} uploaded file${files.length === 1 ? '' : 's'} · ` : ''}React configurator generated from a chat request`,
    prompt,
    status: 'queued',
    source_path: path.join(WORKSPACES_DIR, id),
    dist_path: path.join(DIST_DIR, id),
    public_url: publicUrlFor(id),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: expiresAt,
    error_message: null,
  };
}

export class GenerationWorker {
  constructor(store, events) {
    this.store = store;
    this.events = events;
    this.queue = [];
    this.running = false;
  }

  enqueue(id) {
    if (!ID_PATTERN.test(id)) throw new Error('Invalid generated view ID.');
    this.queue.push(id);
    this.events.publish(id, { status: 'queued', message: 'Generation job queued.' });
    setImmediate(() => this.runNext());
  }

  async runNext() {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    this.running = true;
    try {
      await this.process(id);
    } finally {
      this.running = false;
      if (this.queue.length) setImmediate(() => this.runNext());
    }
  }

  async process(id) {
    const view = this.store.getView(id);
    if (!view || view.status === 'deleted') return;
    const files = this.store.getFiles(id);

    try {
      for (const status of STATUSES) {
        if (status === 'ready') break;
        await this[status](view, files);
      }
      const ready = this.store.updateStatus(id, 'ready');
      this.events.publish(id, { status: 'ready', message: 'Generated view is ready.', view: publicView(ready) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateStatus(id, 'error', message);
      this.events.publish(id, { status: 'error', message });
    }
  }

  async preparing(view) {
    this.setStatus(view.id, 'preparing', 'Creating isolated generated-view workspace.');
    const workspaceDir = path.resolve(WORKSPACES_DIR, view.id);
    assertInside(WORKSPACES_DIR, workspaceDir);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), trustedIndexHtml(view.title));
    fs.writeFileSync(path.join(workspaceDir, 'src', 'main.tsx'), trustedMainTsx());

    // Copy AGENTS.md into workspace so opencode agent can read it
    if (fs.existsSync(AGENTS_MD_PATH)) {
      fs.copyFileSync(AGENTS_MD_PATH, path.join(workspaceDir, 'AGENTS.md'));
    }
  }

  async generating(view, files) {
    this.setStatus(view.id, 'generating', 'Generating a self-contained React TypeScript configurator view.');
    const workspaceDir = path.resolve(WORKSPACES_DIR, view.id);
    const viewPath = path.join(workspaceDir, 'src', 'View.tsx');

    if (!isOpencodeAvailable()) {
      throw new Error('opencode is not available. Install it or set OPENCODE_BIN/OPENCODE_ARGS so generation can run.');
    }

    try {
      this.setStatus(view.id, 'generating', 'AI generation in progress — running opencode agent.');
      await runOpencode(workspaceDir, view, files, (line) => {
        this.events.publish(view.id, { status: 'generating', message: `> ${line}` });
      });

      const result = fs.readFileSync(viewPath, 'utf8');
      if (result.includes('// Placeholder — opencode will replace this content.')) {
        throw new Error('opencode finished without replacing src/View.tsx. Failing loudly instead of emitting a fake fallback configurator.');
      }
    } catch (opencodeError) {
      const message = opencodeError instanceof Error ? opencodeError.message : String(opencodeError);
      console.warn('[spl-visualizer] opencode run failed, attempting partial recovery:', message);

      if (fs.existsSync(viewPath)) {
        const partialSource = fs.readFileSync(viewPath, 'utf8');
        if (!partialSource.includes('// Placeholder — opencode will replace this content.')) {
          try {
            validateGeneratedView(workspaceDir, view.title);
            console.log('[spl-visualizer] partial recovery succeeded — recovered valid View.tsx after opencode failure.');
            return;
          } catch (validationError) {
            console.warn('[spl-visualizer] partial recovery failed validation:', validationError.message);
          }
        }
      }

      throw new Error(`opencode generation failed: ${message}`);
    }
  }

  async validating(view) {
    this.setStatus(view.id, 'validating', 'Validating generated source before build.');
    const workspaceDir = path.resolve(WORKSPACES_DIR, view.id);
    validateGeneratedView(workspaceDir, view.title);

    // Extract meta description from the generated View.tsx and update the stored view
    const viewSource = fs.readFileSync(path.join(workspaceDir, 'src', 'View.tsx'), 'utf8');
    const descMatch = viewSource.match(/export\s+const\s+meta\s*=\s*\{[^}]*description\s*:\s*['"]([^'"]+)['"]/);
    if (descMatch) {
      this.store.updateStatus(view.id, 'validating', null, { description: descMatch[1] });
    }
  }

  async building(view) {
    this.setStatus(view.id, 'building', 'Running generated-view Vite build.');
    fs.rmSync(path.join(DIST_DIR, '.tmp', view.id), { recursive: true, force: true });
    await runGeneratedBuild(view.id);
  }

  async publishing(view) {
    this.setStatus(view.id, 'publishing', 'Publishing generated static artifact.');
    const tmpDir = path.resolve(DIST_DIR, '.tmp', view.id);
    const finalDir = path.resolve(DIST_DIR, view.id);
    assertInside(path.join(DIST_DIR, '.tmp'), tmpDir);
    assertInside(DIST_DIR, finalDir);
    if (!fs.existsSync(path.join(tmpDir, 'index.html'))) {
      throw new Error('Generated build did not produce an index.html file.');
    }
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.renameSync(tmpDir, finalDir);
  }

  setStatus(id, status, message) {
    const updated = this.store.updateStatus(id, status);
    this.events.publish(id, { status, message, view: publicView(updated) });
  }

  async enhanceJob(id, instructions) {
    const view = this.store.getView(id);
    if (!view) throw new Error('Generated view not found.');
    // ponytail: accept 'enhancing' too — the queue-based API (server/api.js) flips
    // the status to 'enhancing' before enqueuing the job, so by the time the worker
    // picks it up the status is no longer 'ready'. The in-process flow (index.js)
    // still passes 'ready'. Both are valid pre-enhancement states.
    if (view.status !== 'ready' && view.status !== 'enhancing') throw new Error(`Cannot enhance view with status '${view.status}'. It must be 'ready' or 'enhancing'.`);
    if (!instructions || !String(instructions).trim()) throw new Error('Enhancement instructions are required.');

    this.setStatus(id, 'enhancing', `Enhancing view: ${String(instructions).slice(0, 100)}`);

    const workspaceDir = path.resolve(WORKSPACES_DIR, view.id);
    await runOpencodeEnhance(workspaceDir, view, String(instructions).trim(), (line) => {
      this.events.publish(id, { status: 'enhancing', message: `> ${line}` });
    });

    for (const status of ENHANCE_STATUSES) {
      await this[status](view);
    }

    const ready = this.store.updateStatus(id, 'ready');
    this.events.publish(id, { status: 'ready', message: 'View enhancement complete.', view: publicView(ready) });
  }
}


export async function runGeneratedBuild(id) {
  return await runViteBuild(id, false);
}

export async function runPreviewBuild(id) {
  return await runViteBuild(id, true);
}

async function runViteBuild(id, preview) {
  const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const configPath = prepareWritableViteConfig(id, preview);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build', '--config', configPath], {
      cwd: APP_ROOT,
      env: {
        NODE_ENV: 'production',
        GENERATED_VIEW_ID: id,
        GENERATED_APP_ROOT: APP_ROOT,
        GENERATED_WORKSPACES_DIR: WORKSPACES_DIR,
        GENERATED_DIST_DIR: DIST_DIR,
        GENERATED_PREVIEW: preview ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Generated view build timed out.'));
    }, 60_000);

    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Generated view build failed. ${output.slice(-2000)}`));
    });
  });
}

function prepareWritableViteConfig(id, preview) {
  const configRoot = path.join(DIST_DIR, '.tmp', 'configs');
  const configPath = path.resolve(configRoot, `${id}${preview ? '.preview' : ''}.vite.generated.config.ts`);
  assertInside(configRoot, configPath);
  fs.mkdirSync(configRoot, { recursive: true });
  fs.copyFileSync(path.join(APP_ROOT, 'vite.generated.config.ts'), configPath);
  return configPath;
}

function deriveTitle(prompt) {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'Generated Configurator';
  return titleCase(firstLine.replace(/^create\s+(a\s+)?/i, '').slice(0, 58) || 'Generated Configurator');
}

function titleCase(value) {
  return String(value).replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}


function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path tried to escape the generated workspace.');
  }
}

function publicView(view) {
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
    error_message: view.error_message,
  };
}
