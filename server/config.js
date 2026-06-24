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
export const EXAMPLES_DIR = path.resolve(process.env.GENERATED_EXAMPLES_DIR ?? path.join(APP_ROOT, 'examples'));
export const VIEW_TTL_HOURS = Number.parseInt(process.env.GENERATED_VIEW_TTL_HOURS ?? '168', 10);
export const ID_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
// Per-file budget when interpolating uploaded content into the opencode prompt.
// Conservative: file bodies can contain anything, so cap before the LLM sees them.
export const MAX_FILE_PROMPT_CHARS = Number.parseInt(process.env.MAX_FILE_PROMPT_CHARS ?? '1500', 10);
// Total budget across all files in one prompt. Past this, later files are dropped.
export const MAX_FILE_CONTEXT_CHARS = Number.parseInt(process.env.MAX_FILE_CONTEXT_CHARS ?? '6000', 10);

export function publicUrlFor(id) {
  return `/gen/${id}`;
}


// Enabled by default when an opencode command is available; override with OPENCODE_ENABLED.
export const OPENCODE_ENABLED =
  process.env.OPENCODE_ENABLED === '0' || process.env.OPENCODE_ENABLED === 'false'
    ? false
    : process.env.OPENCODE_ENABLED === '1' || process.env.OPENCODE_ENABLED === 'true'
      ? true
      : undefined; // undefined = auto-detect

const detectedOpencodeBin = commandWorks('opencode', ['--version']) ? 'opencode' : 'npx';
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? detectedOpencodeBin;
export const OPENCODE_ARGS = splitCommandArgs(
  process.env.OPENCODE_ARGS ?? (OPENCODE_BIN === 'npx' ? '-y opencode-ai@latest' : ''),
);

// Legacy env names kept for backward compatibility.
export const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? '';
export const VLLM_API_KEY = process.env.VLLM_API_KEY ?? '';
export const VLLM_MODEL = process.env.VLLM_MODEL ?? '';
export const DEFAULT_VLLM_BASE_URL = 'https://vllm-api.scch.at/';
export const DEFAULT_VLLM_MODEL = 'Qwen3.6-27B-FP8 - Reasoning OFF';

// Friendly aliases for direct single-container deployments against OpenAI-compatible APIs.
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? '';
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? '';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

export function resolveOpencodeProviderSettings() {
  const envVllmBaseURL = normaliseString(VLLM_BASE_URL);
  const envVllmApiKey = normaliseString(VLLM_API_KEY);
  const envVllmModelId = normaliseString(VLLM_MODEL);
  const envOpenaiBaseURL = normaliseString(OPENAI_BASE_URL);
  const envOpenaiApiKey = normaliseString(OPENAI_API_KEY);
  const envOpenaiModelId = normaliseString(OPENAI_MODEL);

  const hasVllmEnv = Boolean(envVllmBaseURL || envVllmApiKey || envVllmModelId);
  const hasOpenAiEnv = Boolean(envOpenaiBaseURL || envOpenaiApiKey || envOpenaiModelId);
  const useOpenAiDefaults = hasOpenAiEnv && !hasVllmEnv;
  const useVllmDefaults = !hasOpenAiEnv || hasVllmEnv;

  const baseURL =
    envVllmBaseURL ||
    envOpenaiBaseURL ||
    (useOpenAiDefaults && envOpenaiApiKey ? DEFAULT_OPENAI_BASE_URL : '') ||
    (useVllmDefaults ? DEFAULT_VLLM_BASE_URL : '');
  const apiKey = envVllmApiKey || envOpenaiApiKey;
  const modelId =
    envVllmModelId ||
    envOpenaiModelId ||
    (useOpenAiDefaults && envOpenaiApiKey ? DEFAULT_OPENAI_MODEL : '') ||
    (useVllmDefaults ? DEFAULT_VLLM_MODEL : '');

  return {
    provider: hasOpenAiEnv && !hasVllmEnv ? 'openai' : 'llm2go',
    baseURL,
    apiKey,
    modelId,
    source: baseURL || apiKey || modelId ? 'env' : 'missing',
  };
}

// --- Valkey (Redis-compatible) queue + pub/sub ---
// Uses ioredis which works cleanly with Valkey 9.
export const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://valkey:6379';

let _valkeyConn = null;
export async function getValkey() {
  if (_valkeyConn) return _valkeyConn;
  const IORedis = (await import('ioredis')).default;
  const url = new URL(VALKEY_URL);
  _valkeyConn = new IORedis({
    host: url.hostname,
    port: url.port || 6379,
    lazyConnect: true,
  });
  _valkeyConn.on('error', (err) => console.error('[valkey] connection error:', err.message));
  await _valkeyConn.connect();
  return _valkeyConn;
}
export const OPENCODE_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_TIMEOUT_MS ?? '1200000', 10); // 20 min default

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

function normaliseString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
