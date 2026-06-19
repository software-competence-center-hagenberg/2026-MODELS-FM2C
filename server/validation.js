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

export function validateGeneratedView(workspaceDir) {
  const expected = path.resolve(workspaceDir, 'src', 'View.tsx');
  if (!fs.existsSync(expected)) {
    throw new Error('Generated View.tsx was not created.');
  }

  const stat = fs.statSync(expected);
  if (!stat.isFile()) {
    throw new Error('Generated View.tsx is not a file.');
  }
  if (stat.size > MAX_VIEW_BYTES) {
    throw new Error('Generated View.tsx is too large.');
  }

  const source = fs.readFileSync(expected, 'utf8');
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
    fileName: expected,
  });

  const diagnostic = transpiled.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`Generated View.tsx failed TypeScript parsing: ${message}`);
  }

  return true;
}
