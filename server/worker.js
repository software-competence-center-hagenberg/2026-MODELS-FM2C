import 'dotenv/config';


import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AGENTS_MD_PATH,
  APP_ROOT,
  DIST_DIR,
  ID_PATTERN,
  OPENCODE_FALLBACK_TEMPLATE,
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

    if (isOpencodeAvailable()) {
      try {
        this.setStatus(view.id, 'generating', 'AI generation in progress — running opencode agent.');
        await runOpencode(workspaceDir, view, files, (line) => {
          this.events.publish(view.id, { status: 'generating', message: `> ${line}` });
        });
        // Check whether opencode actually produced anything beyond the placeholder
        const result = fs.readFileSync(viewPath, 'utf8');
        if (result.includes('// Placeholder — opencode will replace this content.')) {
          console.warn('[spl-visualizer] opencode left stub behind, falling back to template.');
        } else {
          return;
        }
      } catch (opencodeError) {
        const message = opencodeError instanceof Error ? opencodeError.message : String(opencodeError);
        console.warn('[spl-visualizer] opencode run failed, attempting partial recovery:', message);

        // --- Graceful partial recovery ---
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

        if (!OPENCODE_FALLBACK_TEMPLATE) {
          throw new Error(`opencode generation failed: ${message}`);
        }
        console.warn('[spl-visualizer] falling back to template after opencode failure:', message);
      }
    }
    if (!isOpencodeAvailable() && !OPENCODE_FALLBACK_TEMPLATE) {
      throw new Error('opencode is not available. Install it, set OPENCODE_BIN/OPENCODE_ARGS, or set OPENCODE_FALLBACK_TEMPLATE=true for the deterministic template fallback.');
    }

    const source = generateViewSource(view, files);
    fs.writeFileSync(viewPath, source);
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
    if (view.status !== 'ready') throw new Error(`Cannot enhance view with status '${view.status}'. It must be 'ready'.`);
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


function generateViewSource(view, files) {
  const fileSummaries = files.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
    preview: summariseContent(file.content),
  }));
  const options = deriveOptions(view.prompt, files);
  const stages = deriveStages(view.prompt, files);
  const accent = colourFromId(view.id);

  return `import { useMemo, useState } from 'react';\n\nexport const meta = {\n  title: ${JSON.stringify(view.title)},\n  description: ${JSON.stringify(view.description)}\n};\n\ntype Option = { id: string; label: string; description: string; group: string; recommended: boolean };\ntype Stage = { name: string; detail: string };\n\nconst prompt = ${JSON.stringify(view.prompt)};\nconst uploadedFiles = ${JSON.stringify(fileSummaries, null, 2)} satisfies Array<{ name: string; type: string; size: number; preview: string }>;\nconst options = ${JSON.stringify(options, null, 2)} satisfies Option[];\nconst stages = ${JSON.stringify(stages, null, 2)} satisfies Stage[];\nconst accent = ${JSON.stringify(accent)};\n\nexport default function GeneratedView() {\n  const [selected, setSelected] = useState(() => new Set(options.filter((option) => option.recommended).map((option) => option.id)));\n  const [activeGroup, setActiveGroup] = useState('all');\n  const groups = useMemo(() => ['all', ...Array.from(new Set(options.map((option) => option.group)))], []);\n  const visibleOptions = activeGroup === 'all' ? options : options.filter((option) => option.group === activeGroup);\n  const selectedOptions = options.filter((option) => selected.has(option.id));\n\n  function toggle(id: string) {\n    setSelected((current) => {\n      const next = new Set(current);\n      if (next.has(id)) next.delete(id);\n      else next.add(id);\n      return next;\n    });\n  }\n\n  return (\n    <main style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' }}>\n      <section style={{ padding: '42px clamp(18px, 4vw, 64px)', background: \`linear-gradient(135deg, \${accent}, #111827 58%, #020617)\` }}>\n        <div style={{ maxWidth: 1120, margin: '0 auto' }}>\n          <p style={{ margin: '0 0 10px', color: '#bfdbfe', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 12 }}>Generated configurator</p>\n          <h1 style={{ margin: 0, fontSize: 'clamp(34px, 6vw, 72px)', lineHeight: 0.95, letterSpacing: '-0.06em' }}>{meta.title}</h1>\n          <p style={{ maxWidth: 780, margin: '18px 0 0', color: '#cbd5e1', fontSize: 18 }}>{meta.description}</p>\n        </div>\n      </section>\n\n      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '28px clamp(18px, 4vw, 64px) 54px', display: 'grid', gap: 18 }}>\n        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>\n          <Metric label="Selected modules" value={selected.size} />\n          <Metric label="Available options" value={options.length} />\n          <Metric label="Uploaded files" value={uploadedFiles.length} />\n        </div>\n\n        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(280px, 0.65fr)', gap: 18, alignItems: 'start' }}>\n          <section style={panelStyle}>\n            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>\n              <div>\n                <h2 style={headingStyle}>Configurator options</h2>\n                <p style={mutedStyle}>Toggle the generated features below. The default picks are based on the request and uploaded settings.</p>\n              </div>\n              <select value={activeGroup} onChange={(event) => setActiveGroup(event.target.value)} style={selectStyle}>\n                {groups.map((group) => <option key={group} value={group}>{group === 'all' ? 'All groups' : group}</option>)}\n              </select>\n            </div>\n            <div style={{ display: 'grid', gap: 12 }}>\n              {visibleOptions.map((option) => (\n                <button key={option.id} onClick={() => toggle(option.id)} style={{ ...optionStyle, borderColor: selected.has(option.id) ? accent : '#334155', background: selected.has(option.id) ? 'rgba(59, 130, 246, 0.16)' : '#111827' }}>\n                  <span style={{ width: 22, height: 22, borderRadius: 999, border: \`2px solid \${selected.has(option.id) ? accent : '#64748b'}\`, display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>{selected.has(option.id) ? '✓' : ''}</span>\n                  <span style={{ textAlign: 'left' }}>\n                    <strong style={{ display: 'block', color: '#f8fafc' }}>{option.label}</strong>\n                    <small style={{ color: '#94a3b8' }}>{option.description}</small>\n                  </span>\n                </button>\n              ))}\n            </div>\n          </section>\n\n          <aside style={{ display: 'grid', gap: 18 }}>\n            <section style={panelStyle}>\n              <h2 style={headingStyle}>Deployment stages</h2>\n              <div style={{ display: 'grid', gap: 10 }}>\n                {stages.map((stage, index) => (\n                  <div key={stage.name} style={{ display: 'grid', gridTemplateColumns: '34px 1fr', gap: 10 }}>\n                    <div style={{ width: 30, height: 30, borderRadius: 999, background: accent, display: 'grid', placeItems: 'center', fontWeight: 900 }}>{index + 1}</div>\n                    <div>\n                      <strong style={{ color: '#f8fafc' }}>{stage.name}</strong>\n                      <p style={{ ...mutedStyle, margin: '2px 0 0' }}>{stage.detail}</p>\n                    </div>\n                  </div>\n                ))}\n              </div>\n            </section>\n\n            <section style={panelStyle}>\n              <h2 style={headingStyle}>Summary</h2>\n              <pre style={codeStyle}>{JSON.stringify({ selected: selectedOptions.map((option) => option.label), sourceFiles: uploadedFiles.map((file) => file.name) }, null, 2)}</pre>\n            </section>\n          </aside>\n        </div>\n\n        <section style={panelStyle}>\n          <h2 style={headingStyle}>Original request</h2>\n          <p style={{ whiteSpace: 'pre-wrap', color: '#cbd5e1' }}>{prompt}</p>\n          {uploadedFiles.length > 0 && (\n            <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>\n              {uploadedFiles.map((file) => (\n                <details key={file.name} style={{ background: '#020617', border: '1px solid #1e293b', borderRadius: 14, padding: 12 }}>\n                  <summary style={{ cursor: 'pointer', color: '#f8fafc', fontWeight: 800 }}>{file.name} <span style={{ color: '#64748b', fontWeight: 500 }}>({Math.ceil(file.size / 1024)} KB)</span></summary>\n                  <pre style={codeStyle}>{file.preview}</pre>\n                </details>\n              ))}\n            </div>\n          )}\n        </section>\n      </section>\n    </main>\n  );\n}\n\nfunction Metric({ label, value }: { label: string; value: number }) {\n  return (\n    <div style={panelStyle}>\n      <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>{label}</div>\n      <div style={{ color: '#f8fafc', fontSize: 34, fontWeight: 900, letterSpacing: '-0.04em' }}>{value}</div>\n    </div>\n  );\n}\n\nconst panelStyle = { background: 'rgba(15, 23, 42, 0.88)', border: '1px solid #1e293b', borderRadius: 22, padding: 18, boxShadow: '0 18px 50px rgba(2, 6, 23, 0.35)' } as const;\nconst headingStyle = { margin: '0 0 8px', color: '#f8fafc', fontSize: 18 } as const;\nconst mutedStyle = { margin: 0, color: '#94a3b8', fontSize: 13 } as const;\nconst optionStyle = { width: '100%', border: '1px solid #334155', borderRadius: 16, padding: 14, color: '#e2e8f0', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start' } as const;\nconst selectStyle = { background: '#020617', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 12, padding: '10px 12px' } as const;\nconst codeStyle = { margin: '10px 0 0', padding: 12, overflow: 'auto', borderRadius: 14, background: '#020617', border: '1px solid #1e293b', color: '#bfdbfe', fontSize: 12 } as const;\n`;
}

export async function runGeneratedBuild(id) {
  return await runViteBuild(id, false);
}

export async function runPreviewBuild(id) {
  return await runViteBuild(id, true);
}

async function runViteBuild(id, preview) {
  const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build', '--config', path.join(APP_ROOT, 'vite.generated.config.ts')], {
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
function deriveTitle(prompt) {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'Generated Configurator';
  return titleCase(firstLine.replace(/^create\s+(a\s+)?/i, '').slice(0, 58) || 'Generated Configurator');
}

function deriveOptions(prompt, files) {
  const text = `${prompt}\n${files.map((file) => `${file.name}\n${file.content}`).join('\n')}`;
  const candidates = Array.from(new Set((text.match(/[A-Z]?[a-z][a-z0-9-]{2,}(?:\s+[A-Z]?[a-z][a-z0-9-]{2,})?/g) ?? [])
    .map((item) => item.trim())
    .filter((item) => !/^(create|this|that|with|from|file|view|show|selectable|settings|configuration|configurator)$/i.test(item))
    .slice(0, 9)));
  const fallback = ['Authentication', 'Database', 'API Gateway', 'Monitoring', 'Backup', 'Deployment Pipeline'];
  const labels = (candidates.length >= 4 ? candidates : fallback).slice(0, 9);
  return labels.map((label, index) => ({
    id: slugify(label) || `option-${index + 1}`,
    label: titleCase(label),
    description: `Generated option inferred from ${files[index % Math.max(files.length, 1)]?.name ?? 'the prompt'}.`,
    group: ['Core', 'Integration', 'Operations'][index % 3],
    recommended: index < Math.ceil(labels.length / 2),
  }));
}

function deriveStages(prompt, files) {
  const lower = `${prompt} ${files.map((file) => file.content).join(' ')}`.toLowerCase();
  const stages = [
    { name: 'Analyse inputs', detail: files.length ? 'Review uploaded documentation and settings.' : 'Use the chat prompt as the primary source.' },
    { name: 'Choose features', detail: 'Select the modules that should be active in the generated configuration.' },
    { name: lower.includes('deploy') ? 'Deploy' : 'Review', detail: lower.includes('deploy') ? 'Prepare the selected setup for deployment.' : 'Check the generated selection before exporting.' },
  ];
  if (lower.includes('test') || lower.includes('validate')) stages.splice(2, 0, { name: 'Validate', detail: 'Run a validation pass against selected constraints.' });
  return stages;
}

function summariseContent(content) {
  const clean = String(content ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return clean.length > 1600 ? `${clean.slice(0, 1600)}\n…` : clean;
}

function colourFromId(id) {
  const colours = ['#2563eb', '#7c3aed', '#db2777', '#0891b2', '#059669', '#ea580c'];
  return colours[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colours.length];
}

function titleCase(value) {
  return String(value).replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
