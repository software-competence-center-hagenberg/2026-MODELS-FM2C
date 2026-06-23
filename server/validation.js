import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SUSPICIOUS_PATTERNS = [
  /from\s+['"]node:fs['"]/,
  /from\s+['"]fs['"]/,
  /child_process/,
  /worker_threads/,
  /process\.env/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /document\.cookie/,
  /localStorage/,
  /sessionStorage/,
  /dangerouslySetInnerHTML/,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
];

const MAX_VIEW_BYTES = 200 * 1024;

// Files the agent is allowed to leave in the workspace after generation.
// Anything else (e.g. a malicious vite plugin, package.json override, or
// sneaky script dropped in via a future opencode CLI bug) is rejected.
const ALLOWED_WORKSPACE_PATHS = new Set([
  'src/View.tsx',
  'src/main.tsx',
  'index.html',
  'AGENTS.md',
  'opencode.json',
]);

/**
 * Trusted index.html template. Title is HTML-escaped.
 * Exported so worker.js writes the same string the validator compares against.
 */
export function trustedIndexHtml(title) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

/**
 * Trusted src/main.tsx template. The only purpose of this file is to mount
 * the generated `View` component into the root div — anything else would be
 * an attempt to smuggle extra code past the validator.
 */
export function trustedMainTsx() {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import GeneratedView from './View';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GeneratedView />
  </React.StrictMode>,
);
`;
}


/**
 * Validate the whole workspace tree plus the generated View.tsx.
 * Throws on any deviation. Called by worker.js after opencode runs.
 */
export function validateGeneratedView(workspaceDir, viewTitle) {
  // --- 1. Walk the tree, collect every file (and reject surprises) ---
  const seen = new Set();
  walkWorkspace(workspaceDir, workspaceDir, seen);

  for (const expected of ALLOWED_WORKSPACE_PATHS) {
    if (!seen.has(expected)) {
      throw new Error(`Workspace is missing required file: ${expected}`);
    }
  }
  for (const got of seen) {
    if (!ALLOWED_WORKSPACE_PATHS.has(got)) {
      throw new Error(`Workspace contains unexpected file: ${got}`);
    }
  }

  // --- 2. Trusted files must match the templates byte-for-byte ---
  // If the agent somehow edits these (e.g. via a future opencode CLI bug),
  // we want to know about it even though edit permission says otherwise.
  const expectedMainTsx = trustedMainTsx();
  const actualMainTsx = fs.readFileSync(path.join(workspaceDir, 'src', 'main.tsx'), 'utf8');
  if (actualMainTsx !== expectedMainTsx) {
    throw new Error('src/main.tsx was modified — must match the trusted template.');
  }

  const expectedIndexHtml = trustedIndexHtml(viewTitle);
  const actualIndexHtml = fs.readFileSync(path.join(workspaceDir, 'index.html'), 'utf8');
  if (actualIndexHtml !== expectedIndexHtml) {
    throw new Error('index.html was modified — must match the trusted template.');
  }

  // --- 3. Existing View.tsx checks (size, exports, blocked patterns, TS parse) ---
  const viewPath = path.resolve(workspaceDir, 'src', 'View.tsx');
  const stat = fs.statSync(viewPath);
  if (!stat.isFile()) {
    throw new Error('Generated View.tsx is not a file.');
  }
  if (stat.size > MAX_VIEW_BYTES) {
    throw new Error('Generated View.tsx is too large.');
  }

  const source = fs.readFileSync(viewPath, 'utf8');
  if (!/export\s+default\s+function|export\s+default\s+GeneratedView|export\s+\{\s*GeneratedView\s+as\s+default\s*\}/.test(source)) {
    throw new Error('Generated View.tsx must export a default React component.');
  }
  if (!/export\s+const\s+meta\s*=/.test(source)) {
    throw new Error('Generated View.tsx must export a meta object.');
  }

  const matched = SUSPICIOUS_PATTERNS.find((pattern) => pattern.test(source));
  if (matched) {
    throw new Error(`Generated View.tsx contains a blocked pattern: ${matched}`);
  }

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
    fileName: viewPath,
  });

  const diagnostic = transpiled.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`Generated View.tsx failed TypeScript parsing: ${message}`);
  }

  return true;
}

function walkWorkspace(root, dir, seen) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read workspace directory ${dir}: ${error.message}`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Workspace contains a symlink: ${path.relative(root, full)}`);
    }
    if (entry.isDirectory()) {
      // Only `src/` is a permitted subdirectory.
      if (entry.name !== 'src') {
        throw new Error(`Workspace contains unexpected directory: ${path.relative(root, full)}`);
      }
      walkWorkspace(root, full, seen);
    } else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (seen.has(rel)) {
        throw new Error(`Workspace contains duplicate path: ${rel}`);
      }
      seen.add(rel);
    } else {
      throw new Error(`Workspace contains non-regular entry: ${path.relative(root, full)}`);
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}
