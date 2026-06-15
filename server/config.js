import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..');
export const AGENTS_MD_PATH = path.resolve(APP_ROOT, 'AGENTS.md');

export const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
export const MAIN_DIST_DIR = path.resolve(APP_ROOT, 'dist');
export const DATA_DIR = path.resolve(process.env.GENERATED_DATA_DIR ?? path.join(APP_ROOT, 'data'));
export const WORKSPACES_DIR = path.resolve(process.env.GENERATED_WORKSPACES_DIR ?? path.join(APP_ROOT, 'generated-workspaces'));
export const DIST_DIR = path.resolve(process.env.GENERATED_DIST_DIR ?? path.join(APP_ROOT, 'generated-dist'));
export const VIEW_TTL_HOURS = Number.parseInt(process.env.GENERATED_VIEW_TTL_HOURS ?? '168', 10);
export const ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export function publicUrlFor(id) {
  return `/gen/${id}`;
}
// --- opencode (AI agent) configuration ---
export const PI_MODELS_CONFIG = path.resolve(
  process.env.PI_MODELS_CONFIG ?? path.join(os.homedir(), '.pi', 'agent', 'models.json'),
);
export const PI_MODEL_PROVIDER = process.env.PI_MODEL_PROVIDER ?? 'llm2go';
const piModelConfig = readPiModelConfig(PI_MODELS_CONFIG);
const piProvider = piModelConfig?.providers?.[PI_MODEL_PROVIDER];

// Enabled by default when an opencode command is available; override with OPENCODE_ENABLED.
export const OPENCODE_ENABLED =
  process.env.OPENCODE_ENABLED === '0' || process.env.OPENCODE_ENABLED === 'false'
    ? false
    : process.env.OPENCODE_ENABLED === '1' || process.env.OPENCODE_ENABLED === 'true'
      ? true
      : undefined; // undefined = auto-detect
export const OPENCODE_FALLBACK_TEMPLATE =
  process.env.OPENCODE_FALLBACK_TEMPLATE === '1' || process.env.OPENCODE_FALLBACK_TEMPLATE === 'true';

const detectedOpencodeBin = commandWorks('opencode', ['--version']) ? 'opencode' : 'npx';
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? detectedOpencodeBin;
export const OPENCODE_ARGS = splitCommandArgs(
  process.env.OPENCODE_ARGS ?? (OPENCODE_BIN === 'npx' ? '-y opencode-ai@latest' : ''),
);

// vLLM/OpenAI-compatible provider defaults from ~/.pi/agent/models.json, overridable via env.
export const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? piProvider?.baseUrl ?? '';
export const VLLM_API_KEY = process.env.VLLM_API_KEY ?? piProvider?.apiKey ?? '';
export const VLLM_MODEL =
  process.env.VLLM_MODEL
  ?? piModelConfig?.spawnModels?.complex
  ?? piProvider?.models?.[0]?.id
  ?? '';

export const OPENCODE_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_TIMEOUT_MS ?? '600000', 10); // 10 min default

function readPiModelConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function commandWorks(command, args) {
  try {
    return spawnSync(command, args, { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function splitCommandArgs(value) {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? [];
}
