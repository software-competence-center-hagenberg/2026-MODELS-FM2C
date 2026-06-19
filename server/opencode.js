import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  OPENCODE_BIN,
  OPENCODE_ENABLED,
  OPENCODE_ARGS,
  OPENCODE_TIMEOUT_MS,
  VLLM_BASE_URL,
  VLLM_API_KEY,
  VLLM_MODEL,
} from "./config.js";

/**
 * Check whether opencode is available on the system (or at the configured path).
 */
export function isOpencodeAvailable() {
  if (OPENCODE_ENABLED === false) return false;
  if (OPENCODE_ENABLED === true) return true;
  // Auto-detect: try to find the binary
  try {
    const result = spawnSync(OPENCODE_BIN, [...OPENCODE_ARGS, "--version"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Build the `opencode.json` config for a generated-view workspace.
 * Configures a custom OpenAI-compatible provider pointing at vLLM,
 * restrictive permissions (edit src/View.tsx only, deny bash/package changes),
 * and the selected model.
 */
export function buildOpencodeConfig() {
  const modelId = currentModelId();
  const modelKey = slugModelKey(modelId);

  if (!VLLM_BASE_URL) {
    throw new Error('VLLM_BASE_URL is not configured. Set VLLM_BASE_URL, VLLM_API_KEY, and VLLM_MODEL environment variables.');
  }

  return {
    $schema: "https://opencode.ai/config.json",
    model: currentModelSpecifier(),
    provider: {
      llm2go: {
        npm: "@ai-sdk/openai-compatible",
        name: "vLLM (llm2go)",
        options: {
          baseURL: VLLM_BASE_URL,
          apiKey: "{env:VLLM_API_KEY}",
        },
        models: {
          [modelKey]: {
            id: modelId,
            name: modelId,
          },
        },
      },
    },
    permission: {
      read: {
        "*": "allow",
      },
      edit: {
        "src/*": "allow",
      },
      glob: "allow",
      grep: "allow",
      bash: "allow",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      external_directory: "deny",
      question: "deny",
    },
  };
}

/**
 * Write opencode.json to the workspace root so `opencode run --dir <workspace>`
 * picks it up as the project config.
 */
export function writeOpencodeConfig(workspaceDir) {
  const config = buildOpencodeConfig();
  const configPath = path.join(workspaceDir, "opencode.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
}

/**
 * Build the prompt that guides opencode to produce a self-contained View.tsx.
 */
export function buildOpencodePrompt(view, files) {
  const fileContext =
    files.length > 0
      ? `\n\nUploaded files (${files.length}):\n${files.map((f) => `- ${f.name} (${f.type}, ${f.size} bytes): ${f.content.slice(0, 3000)}`).join("\n")}`
      : "";

  return `You are a React TypeScript expert. Generate a complete, self-contained React component file at src/View.tsx.

The user wants: "${view.prompt}"${fileContext}

Requirements:
- The file must export a \`meta\` object: \`export const meta = { title: string, description: string }\`
- The file must have a default export: \`export default function GeneratedView()\` returning JSX
- Use only React hooks (useState, useMemo, etc.) — no external dependencies beyond React
- NO imports of node:fs, child_process, process.env, eval, fetch, WebSocket, or similar
- The component should be a dark-themed configurator dashboard with:
  * A hero section showing title and description
  * Toggle-able feature/options cards
  * A deployment stages or summary sidebar
  * Clean, modern UI with inline styles (no CSS files needed)
- Keep the file under 200 KB
- Use TypeScript types

Generate the complete src/View.tsx file. Do not explain your work — just write the code.`;
}

/**
 * Run `opencode run` in the generated workspace directory.
 * Returns a promise that resolves when opencode exits successfully.
 */
export function runOpencode(workspaceDir, view, files, onEvent) {
  const prompt = buildOpencodePrompt(view, files);
  const configPath = writeOpencodeConfig(workspaceDir);

  // Ensure View.tsx placeholder exists so opencode has something to edit
  const viewPath = path.join(workspaceDir, "src", "View.tsx");
  if (!fs.existsSync(viewPath)) {
    fs.writeFileSync(
      viewPath,
      `// Placeholder — opencode will replace this content.\nexport const meta = { title: 'Loading', description: '...' };\nexport default function GeneratedView() { return <div>Loading...</div>; }\n`,
      "utf8",
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      OPENCODE_BIN,
      [
        ...OPENCODE_ARGS,
        "run",
        "--model",
        currentModelSpecifier(),
        "--pure",
        prompt,
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG: configPath,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_TERMINAL_TITLE: "true",
          VLLM_API_KEY,
          VLLM_BASE_URL,
          VLLM_MODEL,
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENCODE_TIMEOUT_MS,
      },
    );

    let output = "";
    const bufOut = { partial: "" };
    const bufErr = { partial: "" };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`opencode run timed out after ${OPENCODE_TIMEOUT_MS}ms`),
      );
    }, OPENCODE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      streamLines(bufOut, text, onEvent);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      streamLines(bufErr, text, onEvent);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`opencode failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `opencode exited with code ${code}. ${output.slice(-3000)}`,
          ),
        );
      }
    });
  });
}

/**
 * Build the prompt for an enhancement pass — asks opencode to rewrite View.tsx
 * based on user instructions while keeping the same constraints.
 */
export function buildOpencodeEnhancePrompt(view, instructions, currentSource) {
  return `You are a React TypeScript expert. Rewrite the existing src/View.tsx file below based on the user's enhancement instructions.

Current view title: "${view.title}"
Current view description: "${view.description}"

Enhancement instructions from the user: "${instructions}"

Current src/View.tsx source:
=== START VIEW SOURCE ===
${currentSource}
=== END VIEW SOURCE ===

Requirements:
- Keep the file at src/View.tsx
- The file must still export a \`meta\` object: \`export const meta = { title: string, description: string }\`
- The file must still have a default export: \`export default function GeneratedView()\` returning JSX
- Use only React hooks (useState, useMemo, etc.) — no external dependencies beyond React
- NO imports of node:fs, child_process, process.env, eval, fetch, WebSocket, or similar
- Keep the file under 200 KB
- Use TypeScript types
- Apply the enhancement instructions while preserving the overall structure unless the user asks for a major redesign

Generate the complete, updated src/View.tsx file. Do not explain your work — just write the code.`;
}
/**
 * Run `opencode run` for an enhancement pass on an existing workspace.
 * Reads the current View.tsx, builds an enhance prompt, and rewrites the file.
 */
export function runOpencodeEnhance(workspaceDir, view, instructions, onEvent) {
  const viewPath = path.join(workspaceDir, "src", "View.tsx");
  if (!fs.existsSync(viewPath)) {
    throw new Error(
      "Cannot enhance — src/View.tsx does not exist in workspace.",
    );
  }
  const currentSource = fs.readFileSync(viewPath, "utf8");
  const prompt = buildOpencodeEnhancePrompt(view, instructions, currentSource);
  const configPath = writeOpencodeConfig(workspaceDir);

  return new Promise((resolve, reject) => {
    const child = spawn(
      OPENCODE_BIN,
      [
        ...OPENCODE_ARGS,
        "run",
        "--model",
        currentModelSpecifier(),
        "--pure",
        prompt,
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG: configPath,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_TERMINAL_TITLE: "true",
          VLLM_API_KEY,
          VLLM_BASE_URL,
          VLLM_MODEL,
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: OPENCODE_TIMEOUT_MS,
      },
    );

    let output = "";
    const bufOut = { partial: "" };
    const bufErr = { partial: "" };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`opencode enhance timed out after ${OPENCODE_TIMEOUT_MS}ms`),
      );
    }, OPENCODE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      streamLines(bufOut, text, onEvent);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      streamLines(bufErr, text, onEvent);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`opencode enhance failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            `opencode enhance exited with code ${code}. ${output.slice(-3000)}`,
          ),
        );
      }
    });
  });
}

/* Stream completed lines from opencode output to the caller, buffering
 * partial lines across chunks so we don't send half a line. */
function streamLines(buf, text, onEvent) {
  if (!onEvent) return;
  const combined = buf.partial + text;
  const parts = combined.split(/\r?\n/);
  buf.partial = parts.pop(); // keep trailing partial
  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed) onEvent(trimmed);
  }
}

function currentModelId() {
  return VLLM_MODEL || "Qwen/Qwen3.6-27B-FP8 - Reasoning OFF";
}

function currentModelSpecifier() {
  return `llm2go/${slugModelKey(currentModelId())}`;
}

function slugModelKey(modelId) {
  return (
    String(modelId)
      .trim()
      .replace(/\s+-\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/(^-|-$)/g, "") || "generated-model"
  );
}
