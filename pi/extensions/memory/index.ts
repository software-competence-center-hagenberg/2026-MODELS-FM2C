/**
 * Advanced Memory Management (RAG-lite)
 *
 * - Stores structured memories as JSONL records (project + optional team scope)
 * - Retrieves relevant memories per turn from latest user input
 * - Ages memories (recency + access frequency scoring)
 * - Keeps memory scalable via pruning + bounded prompt injection
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, copyFileSync, realpathSync } from "node:fs";
import { join, dirname, basename, normalize } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type MemoryScope = "project" | "team";

type MemoryRecord = {
  id: string;
  text: string;
  scope: MemoryScope;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Storage paths
// ─────────────────────────────────────────────────────────────────────────────

function getMemoryRoot(): string {
  const dir = join(homedir(), ".pi", "memory-v2");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getLegacyMemoryDir(): string {
  return join(homedir(), ".pi", "memory");
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function canonicalProjectPath(cwd: string): string {
  const raw = (cwd || "").trim() || "default";
  let resolved = raw;
  try {
    resolved = realpathSync(raw);
  } catch {
    // best effort only
  }
  const normalised = normalize(resolved).replace(/\\/g, "/").replace(/\/+$|^\s+/g, "");
  return normalised.toLowerCase();
}

function legacyProjectKey(cwd: string): string {
  return sanitize((cwd || "").trim()).slice(-120) || "default";
}

function getProjectKey(cwd: string): string {
  return sanitize(canonicalProjectPath(cwd)).slice(-120) || "default";
}

function mergeProjectKeyStores(cwd: string): { merged: boolean; canonicalFile: string; backups: string[]; mergedFrom: string[]; recordCount: number } {
  const projectsDir = join(getMemoryRoot(), "projects");
  mkdirSync(projectsDir, { recursive: true });

  const canonicalKey = getProjectKey(cwd);
  const legacyKey = legacyProjectKey(cwd);
  const canonicalFile = join(projectsDir, `${canonicalKey}.jsonl`);
  const keyAliases = new Set([canonicalKey.toLowerCase(), legacyKey.toLowerCase()]);

  const candidates = readdirSync(projectsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => keyAliases.has(name.slice(0, -6).toLowerCase()))
    .map((name) => join(projectsDir, name));

  if (candidates.length <= 1 && (candidates.length === 0 || candidates[0] === canonicalFile)) {
    return { merged: false, canonicalFile, backups: [], mergedFrom: [], recordCount: loadStore(canonicalFile).length };
  }

  const mergedRecords = dedupeExact(pruneRecords(candidates.flatMap((file) => loadStore(file))));
  writeStore(canonicalFile, mergedRecords);

  const backupDir = join(getMemoryRoot(), "migrations", "project-key", `${Date.now()}`);
  mkdirSync(backupDir, { recursive: true });
  const backups: string[] = [];
  const mergedFrom: string[] = [];

  for (const file of candidates) {
    if (file === canonicalFile) continue;
    const backupFile = join(backupDir, basename(file));
    try {
      copyFileSync(file, backupFile);
      renameSync(file, `${file}.migrated`);
      backups.push(backupFile);
      mergedFrom.push(file);
    } catch {
      // If migration backup fails, keep source file intact and continue.
    }
  }

  return { merged: mergedFrom.length > 0, canonicalFile, backups, mergedFrom, recordCount: mergedRecords.length };
}

function findGitRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 15; i++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

function getTeamKey(cwd: string): string {
  const fromEnv = process.env.PI_MEMORY_TEAM || process.env.PI_TEAM || "";
  if (fromEnv.trim()) return sanitize(fromEnv.trim());
  const gitRoot = findGitRoot(cwd);
  return sanitize(basename(gitRoot) || "default-team");
}

function getProjectStoreFile(cwd: string): string {
  return join(getMemoryRoot(), "projects", `${getProjectKey(cwd)}.jsonl`);
}

function getTeamStoreFile(cwd: string): string {
  return join(getMemoryRoot(), "teams", `${getTeamKey(cwd)}.jsonl`);
}

function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL I/O
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonLine(line: string): MemoryRecord | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line) as Partial<MemoryRecord>;
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.id !== "string" || typeof obj.text !== "string") return null;
    const scope: MemoryScope = obj.scope === "team" ? "team" : "project";
    return {
      id: obj.id,
      text: obj.text,
      scope,
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : [],
      createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now(),
      updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now(),
      lastAccessedAt: typeof obj.lastAccessedAt === "number" ? obj.lastAccessedAt : Date.now(),
      accessCount: typeof obj.accessCount === "number" ? obj.accessCount : 0,
    };
  } catch {
    return null;
  }
}

function loadStore(file: string): MemoryRecord[] {
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const rows = raw.split("\n").map(parseJsonLine).filter((x): x is MemoryRecord => x !== null);
    return rows;
  } catch {
    return [];
  }
}

function writeStore(file: string, records: MemoryRecord[]): void {
  ensureParent(file);
  const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(file, content, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration from old markdown format
// ─────────────────────────────────────────────────────────────────────────────

function getLegacyMemoryFile(cwd: string): string {
  return join(getLegacyMemoryDir(), `${legacyProjectKey(cwd)}.md`);
}

function maybeMigrateLegacyMemory(cwd: string): void {
  const legacy = getLegacyMemoryFile(cwd);
  const projectStore = getProjectStoreFile(cwd);
  if (!existsSync(legacy) || existsSync(projectStore)) return;

  try {
    const raw = readFileSync(legacy, "utf-8");
    const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    const now = Date.now();
    const migrated: MemoryRecord[] = lines.map((line, i) => {
      const text = line.replace(/^-\s*(\[[^\]]+\]\s*)?/, "").trim();
      return {
        id: `migrated-${now}-${i}`,
        text,
        scope: "project",
        tags: [],
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };
    }).filter((m) => m.text.length > 0);

    if (migrated.length > 0) writeStore(projectStore, migrated);
  } catch {
    // ignore migration errors
  }
}

function maybeMigrateProjectKeyMemory(cwd: string): { migrated: boolean; report: string } {
  try {
    const result = mergeProjectKeyStores(cwd);
    if (!result.merged) {
      return { migrated: false, report: `Project memory key: ${basename(result.canonicalFile)}` };
    }
    return {
      migrated: true,
      report:
        `Merged ${result.mergedFrom.length} duplicate project memory store(s) into ${result.canonicalFile} ` +
        `(${result.recordCount} records). Backups: ${result.backups.join(", ") || "none"}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { migrated: false, report: `Project memory key migration skipped: ${message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking / retrieval
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function ageDays(ts: number): number {
  return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
}

function scoreMemory(record: MemoryRecord, queryTokens: string[]): number {
  const text = `${record.text} ${record.tags.join(" ")}`.toLowerCase();

  let overlap = 0;
  for (const t of queryTokens) {
    if (text.includes(t)) overlap += 1;
  }
  const relevance = queryTokens.length > 0 ? overlap / queryTokens.length : 0;

  const d = ageDays(record.updatedAt);
  const recency = 1 / (1 + d / 7); // 1.0 today, 0.5 around one week, decays smoothly

  const usage = Math.log1p(Math.max(0, record.accessCount)) / Math.log(10); // 0..~1+

  // If query has no useful tokens, fall back to age+usage ordering.
  if (queryTokens.length === 0) return recency * 0.7 + usage * 0.3;

  return relevance * 0.65 + recency * 0.2 + usage * 0.15;
}

function selectRelevant(records: MemoryRecord[], query: string, limit: number): MemoryRecord[] {
  const tokens = uniq(tokenize(query));
  return [...records]
    .sort((a, b) => scoreMemory(b, tokens) - scoreMemory(a, tokens))
    .slice(0, limit);
}

function formatAge(ts: number): string {
  const d = ageDays(ts);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

function trimForPrompt(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance / pruning
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MEMORIES_PER_STORE = 800;
const KEEP_RECENT_MIN = 220;

function pruneRecords(records: MemoryRecord[]): MemoryRecord[] {
  if (records.length <= MAX_MEMORIES_PER_STORE) return records;

  const sortedByRecency = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  const keepRecent = sortedByRecency.slice(0, KEEP_RECENT_MIN);
  const keepIds = new Set(keepRecent.map((r) => r.id));

  const remaining = sortedByRecency.slice(KEEP_RECENT_MIN);
  remaining.sort((a, b) => {
    const aScore = (Math.log1p(a.accessCount) + 1) / (1 + ageDays(a.updatedAt));
    const bScore = (Math.log1p(b.accessCount) + 1) / (1 + ageDays(b.updatedAt));
    return bScore - aScore;
  });

  for (const r of remaining) {
    if (keepIds.size >= MAX_MEMORIES_PER_STORE) break;
    keepIds.add(r.id);
  }

  return records.filter((r) => keepIds.has(r.id)).sort((a, b) => a.createdAt - b.createdAt);
}

function dedupeExact(records: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const out: MemoryRecord[] = [];
  for (const r of records) {
    const key = r.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function appendMemoryRecord(file: string, record: MemoryRecord): void {
  const records = loadStore(file);
  records.push(record);
  const compacted = pruneRecords(dedupeExact(records));
  writeStore(file, compacted);
}

function updateAccessStats(file: string, selectedIds: string[]): void {
  if (selectedIds.length === 0) return;
  const records = loadStore(file);
  if (records.length === 0) return;

  const idSet = new Set(selectedIds);
  const now = Date.now();
  let changed = false;
  for (const r of records) {
    if (!idSet.has(r.id)) continue;
    r.accessCount = Math.max(0, r.accessCount) + 1;
    r.lastAccessedAt = now;
    changed = true;
  }
  if (changed) writeStore(file, records);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-dream (session-end memory consolidation)
// ─────────────────────────────────────────────────────────────────────────────

type AutoDreamConfig = {
  enabled: boolean;
};

type DreamCandidate = {
  text: string;
  tags: string[];
};

type ProblemCandidate = {
  text: string;
  tags: string[];
  severity: "low" | "medium" | "high";
};

type ErrorFingerprint = {
  tool: string;
  signature: string;
  count: number;
  sample: string;
  context: string;
};

function getAutoDreamConfigFile(): string {
  return join(getMemoryRoot(), "auto-dream.json");
}

function parseBoolLike(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(v)) return false;
  return undefined;
}

function loadAutoDreamConfig(): AutoDreamConfig {
  const env = parseBoolLike(process.env.PI_AUTO_DREAM);
  if (env !== undefined) return { enabled: env };

  const file = getAutoDreamConfigFile();
  if (!existsSync(file)) return { enabled: true };

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { enabled?: unknown };
    return { enabled: parsed.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

function saveAutoDreamConfig(config: AutoDreamConfig): void {
  const file = getAutoDreamConfigFile();
  ensureParent(file);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getTextBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

function compactLine(text: string, max = 180): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function sanitizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
}

function fingerprintSignature(raw: string): string {
  const simplified = raw
    .toLowerCase()
    .replace(/\b\d+\b/g, "#")
    .replace(/\/(?:[^\s]+\/)+[^\s]*/g, "<path>")
    .replace(/'[^']*'|"[^"]*"/g, "<str>")
    .replace(/[^a-z0-9\s:_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return simplified.split(" ").slice(0, 10).join(" ") || "unknown-error";
}

function deriveErrorContext(args?: Record<string, unknown>): string {
  if (!args) return "(no-args)";
  if (typeof args.path === "string") return `path:${compactLine(args.path, 60)}`;
  if (typeof args.command === "string") return `command:${compactLine(args.command, 60)}`;
  if (typeof args.action === "string") return `action:${args.action}`;
  if (typeof args.task_id === "number") return `task:${args.task_id}`;
  return Object.keys(args).slice(0, 2).join(",") || "(no-context)";
}

function mitigationHintFromTags(tags: string[]): string {
  if (tags.includes("tool-failure") || tags.includes("tool-retry")) return "Validate arguments first, then switch to fallback flow if the same signature repeats.";
  if (tags.includes("hang-fix")) return "Run the command in tmux and monitor via capture/kill controls.";
  if (tags.includes("loop-detector")) return "Escalate to a dedicated bug-hunt worker instead of retrying ad infinitum.";
  if (tags.includes("high-error-rate")) return "Pause and audit the plan before issuing more tool calls.";
  return "Review the failure context and apply the documented fallback path.";
}

function pushDreamCandidate(out: DreamCandidate[], text: string, tags: string[]): void {
  const cleaned = compactLine(text, 220);
  if (cleaned.length < 14) return;
  out.push({ text: cleaned, tags: uniq(tags.map(sanitizeTag).filter(Boolean)).slice(0, 8) });
}

function extractDreamCandidates(branch: unknown[]): { candidates: DreamCandidate[]; problems: ProblemCandidate[] } {
  const out: DreamCandidate[] = [];
  const toolCalls = new Map<string, { name?: string; arguments?: Record<string, unknown> }>();
  const changedPaths = new Set<string>();
  const problems: ProblemCandidate[] = [];
  const toolFailureCount = new Map<string, number>();
  const toolRetryCount = new Map<string, number>();
  const fingerprintBuckets = new Map<string, ErrorFingerprint>();
  let toolResultCount = 0;
  let toolErrorCount = 0;

  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; message?: any };
    if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;

    const role = typeof e.message.role === "string" ? e.message.role : "";

    if (role === "assistant") {
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (b.type !== "toolCall" || typeof b.id !== "string") continue;
        toolCalls.set(b.id, {
          name: typeof b.name === "string" ? b.name : undefined,
          arguments: b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : undefined,
        });
      }
      continue;
    }

    if (role === "user") {
      const text = compactLine(getTextBlocks(e.message.content).join(" "), 200);
      if (!text) continue;

      if (/\b(i want|i need|i prefer|please|dont |don't |do not |always |never )\b/i.test(` ${text.toLowerCase()} `)) {
        pushDreamCandidate(out, `User preference/request: ${text}`, ["auto-dream", "preference"]);
      }

      if (/\b(implement|build|add|fix|refactor|integrate|support|improve|create)\b/i.test(text)) {
        pushDreamCandidate(out, `Session objective: ${text}`, ["auto-dream", "objective"]);
      }

      // Extract user-voiced problems / pain points
      const painPatterns = [
        { pattern: /\b(that's\s+(a\s+)?bit\s+dodgy|that\s+doesn't\s+work|this\s+is\s+broken|this\s+isn't\s+working|this\s+is\s+stupidly\s+difficult|this\s+is\s+frustrating|this\s+is\s+painful|this\s+is\s+annoying|this\s+is\s+silly)\b/i, tag: "harness-bug" },
        { pattern: /\b(i\s+tried\s+.*?\s+but\s+(it\s+failed|it\s+didn't\s+work|it\s+crashed|it\s+hung|it\s+errored|it\s+threw)\s+(and\s+then|so\s+then))\b/im, tag: "workaround" },
        { pattern: /\b(i\s+tried\s+.*?\s+but\s+(it\s+failed|it\s+didn't\s+work|it\s+crashed|it\s+hung|it\s+errored|it\s+threw))\b/im, tag: "harness-bug" },
        { pattern: /\b(i\s+have\s+(to|got)\s+to\s+.*?\s+(kill|stop|interrupt|restart|reopen)\s+(the\s+)?(agent|pane|server|process|connection))\b/im, tag: "hang-fix" },
        { pattern: /\b(keep\s+going\s+back\s+and\s+forth|looping|going\s+in\s+circles|stuck\s+on|unable\s+to\s+make\s+progress\s+on)\b/i, tag: "loop-detector" },
      ];
      for (const { pattern, tag } of painPatterns) {
        const match = text.match(pattern);
        if (match) {
          const context = text.slice(Math.max(0, match.index! - 40), match.index! + 200);
          const severity: "low" | "medium" | "high" = text.match(/\b(critical|blocking|can't\s+proceed|completely\s+broken|total\s+fail)\b/i) ? "high" : text.match(/\b(bad|poor|unreliable|frequent)\b/i) ? "medium" : "low";
          problems.push({ text: `Lesson: ${context}`, tags: ["auto-dream", "lesson", tag], severity });
        }
      }
      continue;
    }

    if (role !== "toolResult") continue;
    toolResultCount++;

    const toolName = typeof e.message.toolName === "string" ? e.message.toolName : "";
    const toolCallId = typeof e.message.toolCallId === "string" ? e.message.toolCallId : "";
    const linked = toolCallId ? toolCalls.get(toolCallId) : undefined;
    const effectiveTool = toolName || linked?.name || "";
    const isError = e.message.isError === true;

    if (isError) {
      toolErrorCount++;
      // Track repeated failures on the same tool
      toolFailureCount.set(effectiveTool, (toolFailureCount.get(effectiveTool) || 0) + 1);
      const errorText = compactLine(getTextBlocks(e.message.content).join(" ") || "tool error", 220);
      const sig = fingerprintSignature(errorText);
      const ctxHint = deriveErrorContext(linked?.arguments);
      const key = `${effectiveTool}|${sig}`;
      const prev = fingerprintBuckets.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        fingerprintBuckets.set(key, {
          tool: effectiveTool || "unknown-tool",
          signature: sig,
          count: 1,
          sample: errorText,
          context: ctxHint,
        });
      }
      continue;
    }

    // Detect retries: same tool called repeatedly
    if (linked?.name) {
      const prevCount = toolRetryCount.get(linked.name);
      toolRetryCount.set(linked.name, (prevCount || 0) + 1);
    }

    if (["write", "edit", "vim_edit"].includes(effectiveTool)) {
      const pathArg = linked?.arguments?.path;
      if (typeof pathArg === "string" && pathArg.trim()) {
        changedPaths.add(pathArg.trim());
      }
    }

    if (effectiveTool === "task_complete") {
      const summary = linked?.arguments?.summary;
      if (typeof summary === "string" && summary.trim()) {
        pushDreamCandidate(out, `Completed task summary: ${summary.trim()}`, ["auto-dream", "completion"]);
      }
      const files = linked?.arguments?.changed_files;
      if (Array.isArray(files) && files.length > 0) {
        const picked = files.filter((f): f is string => typeof f === "string").slice(0, 5);
        if (picked.length > 0) {
          pushDreamCandidate(out, `Files changed: ${picked.join(", ")}`, ["auto-dream", "code-change"]);
        }
      }
    }
  }

  // Only log code-change memories for a few key files (not every file touch)
  // Use git log for full change history instead of memory entries
  const significantPaths = [...changedPaths].filter((p) =>
    !p.includes("/node_modules/") &&
    !p.includes("/.kanban/") &&
    !p.includes(".json").slice(0, 6),
  ).slice(0, 3);
  for (const p of significantPaths) {
    pushDreamCandidate(out, `Code was updated in ${p}`, ["auto-dream", "code-change"]);
  }

  // Add tool failure/issue summaries
  for (const [tool, count] of toolFailureCount) {
    if (count >= 2) {
      problems.push({
        text: `Tool "${tool}" failed ${count} time(s) this session — investigate or provide fallback`,
        tags: ["auto-dream", "lesson", "tool-failure"],
        severity: count >= 4 ? "high" : count >= 2 ? "medium" : "low",
      });
    }
  }

  for (const [tool, count] of toolRetryCount) {
    if (count >= 3) {
      problems.push({
        text: `Tool "${tool}" was retried ${count} time(s) — check if arguments were wrong or tool was flaky`,
        tags: ["auto-dream", "lesson", "tool-retry"],
        severity: count >= 5 ? "high" : count >= 3 ? "medium" : "low",
      });
    }
  }

  for (const fp of fingerprintBuckets.values()) {
    if (fp.count < 2) continue;
    problems.push({
      text: `[fingerprint tool=${fp.tool} sig=${fp.signature} count=${fp.count} ctx=${fp.context}] ${fp.sample}`,
      tags: ["auto-dream", "lesson", "tool-fingerprint", "tool-failure"],
      severity: fp.count >= 4 ? "high" : "medium",
    });
  }

  // If high error rate (>30% of tool results were errors), flag systemic issues
  if (toolResultCount > 3 && toolErrorCount / toolResultCount > 0.3) {
    problems.push({
      text: `Session had ${toolErrorCount} tool errors out of ${toolResultCount} tool results (${Math.round(100 * toolErrorCount / toolResultCount)}% error rate) — check tool stability or argument correctness`,
      tags: ["auto-dream", "lesson", "high-error-rate"],
      severity: "high",
    });
  }

  const deduped = dedupeExact(out.map((c, i) => ({
    id: `d-${i}`,
    text: c.text,
    scope: "project" as const,
    tags: c.tags,
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
  }))).map((r) => ({ text: r.text, tags: r.tags }));

  // Deduplicate problems
  const problemKeys = new Set<string>();
  const dedupedProblems: ProblemCandidate[] = [];
  for (const p of problems) {
    const key = p.text.toLowerCase();
    if (!problemKeys.has(key)) {
      problemKeys.add(key);
      dedupedProblems.push(p);
    }
  }

  return { candidates: deduped.slice(0, 10), problems: dedupedProblems.slice(0, 8) };
}

// Legacy wrapper for backwards compatibility
function extractDreamCandidatesLegacy(branch: unknown[]): DreamCandidate[] {
  const result = extractDreamCandidates(branch);
  return result.candidates;
}

function persistDreamCandidates(cwd: string, candidates: DreamCandidate[]): number {
  if (candidates.length === 0) return 0;

  const file = getProjectStoreFile(cwd);
  const now = Date.now();
  let saved = 0;

  for (const c of candidates) {
    const record: MemoryRecord = {
      id: `ad-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: c.text,
      scope: "project",
      tags: uniq(["auto-dream", ...c.tags]).slice(0, 8),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
    appendMemoryRecord(file, record);
    saved += 1;
  }

  return saved;
}

function persistDreamProblems(cwd: string, problems: ProblemCandidate[]): number {
  if (problems.length === 0) return 0;

  const file = getProjectStoreFile(cwd);
  const now = Date.now();
  let saved = 0;

  for (const p of problems) {
    const record: MemoryRecord = {
      id: `dp-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text: p.text,
      scope: "project",
      tags: uniq(["auto-dream", "lesson", p.severity]).slice(0, 8),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
    appendMemoryRecord(file, record);
    saved += 1;
  }

  return saved;
}

function runAutoDreamForCurrentSession(ctx: { cwd: string; sessionManager: { getBranch(): unknown[] } }): { found: number; saved: number; problems: number; savedProblems: number } {
  maybeMigrateLegacyMemory(ctx.cwd);
  maybeMigrateProjectKeyMemory(ctx.cwd);
  const branch = ctx.sessionManager.getBranch();
  const result = extractDreamCandidates(branch);
  const candidates = result.candidates;
  const problems = result.problems;
  const saved = persistDreamCandidates(ctx.cwd, candidates);
  const savedProblems = persistDreamProblems(ctx.cwd, problems);
  return { found: candidates.length, saved, problems: problems.length, savedProblems };
}

type SnapshotScope = "project" | "local" | "user";
type SnapshotItem = { text: string; tags: string[]; score: number; source: MemoryScope };
type AgentSnapshot = {
  agentIdentity: string;
  scope: SnapshotScope;
  projectKey: string;
  updatedAt: number;
  query: string;
  items: SnapshotItem[];
};

function getAgentSnapshotFile(cwd: string, agentIdentity: string, scope: SnapshotScope): string {
  const safeAgent = sanitize(agentIdentity || "worker");
  const root = join(getMemoryRoot(), "agent-snapshots", scope);
  if (scope === "user") return join(root, `${safeAgent}.json`);
  return join(root, getProjectKey(cwd), `${safeAgent}.json`);
}

function scoreSnapshot(record: MemoryRecord, tokens: string[]): number {
  let score = scoreMemory(record, tokens);
  if (record.tags.includes("auto-dream")) score += 0.12;
  if (record.tags.some((t) => ["objective", "completion", "code-change", "preference"].includes(t))) score += 0.08;
  // Boost problem/lesson memories — they're actionable and worth surfacing
  if (record.tags.some((t) => ["lesson", "harness-bug", "workaround", "tool-failure", "tool-retry", "tool-fingerprint", "hang-fix", "loop-detector", "high-error-rate"].includes(t))) {
    score += 0.2;
  }
  // Higher severity = more important to surface
  if (record.tags.includes("high")) score += 0.15;
  else if (record.tags.includes("medium")) score += 0.08;
  return score;
}

function buildAgentSnapshot(cwd: string, agentIdentity: string, query: string, scope: SnapshotScope): AgentSnapshot {
  maybeMigrateLegacyMemory(cwd);
  maybeMigrateProjectKeyMemory(cwd);
  const tokens = uniq(tokenize(query));
  const project = loadStore(getProjectStoreFile(cwd));
  const team = loadStore(getTeamStoreFile(cwd));
  const ranked: Array<{ rec: MemoryRecord; score: number; source: MemoryScope }> = [
    ...project.map((rec) => ({ rec, score: scoreSnapshot(rec, tokens), source: "project" as const })),
    ...team.map((rec) => ({ rec, score: scoreSnapshot(rec, tokens), source: "team" as const })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);

  return {
    agentIdentity,
    scope,
    projectKey: getProjectKey(cwd),
    updatedAt: Date.now(),
    query,
    items: ranked.map((x) => ({
      text: x.rec.text,
      tags: x.rec.tags.slice(0, 6),
      score: Number(x.score.toFixed(3)),
      source: x.source,
    })),
  };
}

function saveAgentSnapshot(cwd: string, snapshot: AgentSnapshot): string {
  const file = getAgentSnapshotFile(cwd, snapshot.agentIdentity, snapshot.scope);
  ensureParent(file);
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  return file;
}

function loadAgentSnapshot(cwd: string, agentIdentity: string, scope: SnapshotScope): AgentSnapshot | null {
  const file = getAgentSnapshotFile(cwd, agentIdentity, scope);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<AgentSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.agentIdentity !== "string" || !Array.isArray(parsed.items)) return null;
    return {
      agentIdentity: parsed.agentIdentity,
      scope,
      projectKey: typeof parsed.projectKey === "string" ? parsed.projectKey : getProjectKey(cwd),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      query: typeof parsed.query === "string" ? parsed.query : "",
      items: parsed.items
        .filter((i): i is SnapshotItem => !!i && typeof i === "object" && typeof (i as SnapshotItem).text === "string")
        .map((i) => ({
          text: i.text,
          tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === "string") : [],
          score: typeof i.score === "number" ? i.score : 0,
          source: i.source === "team" ? "team" : "project",
        })),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default function memoryExtension(pi: ExtensionAPI) {
  let lastUserInput = "";
  let autoDream = loadAutoDreamConfig();

  pi.on("session_start", async (_event, ctx) => {
    autoDream = loadAutoDreamConfig();
    const keyMigration = maybeMigrateProjectKeyMemory(ctx.cwd);
    ctx.ui.setStatus("auto-dream", autoDream.enabled ? "💤 dream:on" : "💤 dream:off");
    if (keyMigration.migrated) {
      ctx.ui.notify(`🧠 Memory key migration complete. ${keyMigration.report}`, "info");
    }
  });

  pi.on("input", async (event) => {
    const text = event.text?.trim();
    if (!text || event.source === "extension" || text.startsWith("/") || text.startsWith("!")) {
      return { action: "continue" };
    }
    lastUserInput = text;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    maybeMigrateLegacyMemory(ctx.cwd);
    maybeMigrateProjectKeyMemory(ctx.cwd);

    const projectFile = getProjectStoreFile(ctx.cwd);
    const teamFile = getTeamStoreFile(ctx.cwd);

    const projectMemories = loadStore(projectFile);
    const teamMemories = loadStore(teamFile);

    if (projectMemories.length === 0 && teamMemories.length === 0) return {};

    const query = lastUserInput || "current user request";
    const pickedProject = selectRelevant(projectMemories, query, 8);
    const pickedTeam = selectRelevant(teamMemories, query, 4);

    updateAccessStats(projectFile, pickedProject.map((m) => m.id));
    updateAccessStats(teamFile, pickedTeam.map((m) => m.id));

    const lines: string[] = [
      "",
      "## Project Memory (RAG-lite)",
      "Use these as hints, not immutable facts. Verify against current code/state when needed.",
    ];

    if (pickedProject.length > 0) {
      lines.push("", "### Relevant private/project memories");
      for (const m of pickedProject) {
        const tag = m.tags.length > 0 ? ` tags: ${m.tags.slice(0, 3).join(",")}` : "";
        lines.push(`- [${formatAge(m.updatedAt)} | used ${m.accessCount}x] ${trimForPrompt(m.text, 220)}${tag}`);
      }
    }

    if (pickedTeam.length > 0) {
      lines.push("", "### Relevant team memories");
      for (const m of pickedTeam) {
        const tag = m.tags.length > 0 ? ` tags: ${m.tags.slice(0, 3).join(",")}` : "";
        lines.push(`- [${formatAge(m.updatedAt)} | used ${m.accessCount}x] ${trimForPrompt(m.text, 220)}${tag}`);
      }
    }

    const memoryPrompt = lines.join("\n") + "\n";

    // Inject lessons learned from auto-dream (problem/lesson memories)
    const lessonRecords = projectMemories.filter((m) =>
      m.tags.some((t) => ["lesson", "harness-bug", "workaround", "tool-failure", "tool-retry", "tool-fingerprint", "hang-fix", "loop-detector", "high-error-rate"].includes(t)),
    );
    const lessons = lessonRecords
      .sort((a, b) => {
        const sevOrder = { high: 0, medium: 1, low: 2 };
        const aSev = a.tags.includes("high") ? 0 : a.tags.includes("medium") ? 1 : 2;
        const bSev = b.tags.includes("high") ? 0 : b.tags.includes("medium") ? 1 : 2;
        const cmp = aSev - bSev;
        if (cmp !== 0) return cmp;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, 6)
      .map((m) => m.text);

    let systemPrompt = event.systemPrompt + memoryPrompt;
    if (lessons.length > 0) {
      systemPrompt += "\n## Lessons Learned (from past sessions)\n";
      for (const l of lessons) {
        systemPrompt += `- ${l}\n`;
      }
    }

    return { systemPrompt };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    autoDream = loadAutoDreamConfig();
    if (!autoDream.enabled) return;
    try {
      runAutoDreamForCurrentSession(ctx);
    } catch {
      // best-effort only; never block shutdown
    }
  });

  // /dream [run]
  pi.registerCommand("dream", {
    description: "Run auto-dream memory consolidation for the current session now",
    handler: async (_args, ctx) => {
      const result = runAutoDreamForCurrentSession(ctx);
      if (result.saved === 0) {
        ctx.ui.notify("💤 Dream complete — nothing noteworthy to persist.", "info");
        return;
      }
      ctx.ui.notify(`💤 Dream complete — saved ${result.saved}/${result.found} memory items.`, "success");
    },
  });

  // /auto-dream [on|off|status|run]
  pi.registerCommand("auto-dream", {
    description: "Configure session-end auto-dream: /auto-dream [on|off|status|run]",
    handler: async (args, ctx) => {
      const cmd = (args || "status").trim().toLowerCase();

      if (cmd === "on" || cmd === "enable" || cmd === "enabled") {
        autoDream = { enabled: true };
        saveAutoDreamConfig(autoDream);
        ctx.ui.setStatus("auto-dream", "💤 dream:on");
        ctx.ui.notify("Auto-dream enabled. Session-end consolidation is now on.", "success");
        return;
      }

      if (cmd === "off" || cmd === "disable" || cmd === "disabled") {
        autoDream = { enabled: false };
        saveAutoDreamConfig(autoDream);
        ctx.ui.setStatus("auto-dream", "💤 dream:off");
        ctx.ui.notify("Auto-dream disabled.", "info");
        return;
      }

      if (cmd === "run") {
        const result = runAutoDreamForCurrentSession(ctx);
        ctx.ui.notify(
          result.saved > 0
            ? `💤 Dream complete — saved ${result.saved}/${result.found} memory items.`
            : "💤 Dream complete — nothing noteworthy to persist.",
          result.saved > 0 ? "success" : "info",
        );
        return;
      }

      ctx.ui.notify(`Auto-dream is ${autoDream.enabled ? "ON" : "OFF"}.`, "info");
    },
  });

  // /remember [--team] [--tags a,b,c] <note>
  pi.registerCommand("remember", {
    description: "Save a memory: /remember [--team] [--tags tag1,tag2] <note>",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /remember [--team] [--tags tag1,tag2] <note>", "error");
        return;
      }

      const isTeam = /(^|\s)--team(\s|$)/.test(raw);
      const tagsMatch = raw.match(/--tags\s+([^\s].*?)(?=\s--|$)/);
      const tags = tagsMatch
        ? tagsMatch[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8)
        : [];

      const note = raw
        .replace(/(^|\s)--team(\s|$)/g, " ")
        .replace(/--tags\s+([^\s].*?)(?=\s--|$)/g, " ")
        .trim();

      if (!note) {
        ctx.ui.notify("Memory note is empty after flags. Please provide text to remember.", "error");
        return;
      }

      const now = Date.now();
      const scope: MemoryScope = isTeam ? "team" : "project";
      const record: MemoryRecord = {
        id: `m-${now}-${Math.random().toString(36).slice(2, 8)}`,
        text: note,
        scope,
        tags,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };

      const file = scope === "team" ? getTeamStoreFile(ctx.cwd) : getProjectStoreFile(ctx.cwd);
      appendMemoryRecord(file, record);

      ctx.ui.notify(
        scope === "team"
          ? `💾 Remembered (team): "${note}"`
          : `💾 Remembered (project): "${note}"`,
        "success",
      );
    },
  });

  // /memories [query]
  pi.registerCommand("memories", {
    description: "Show relevant memories. Optional query: /memories <query>",
    handler: async (args, ctx) => {
      maybeMigrateLegacyMemory(ctx.cwd);
      const project = loadStore(getProjectStoreFile(ctx.cwd));
      const team = loadStore(getTeamStoreFile(ctx.cwd));

      if (project.length === 0 && team.length === 0) {
        ctx.ui.notify("No memories saved yet. Use /remember <note>.", "info");
        return;
      }

      const query = (args || "").trim();
      const showProject = query ? selectRelevant(project, query, 12) : [...project].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
      const showTeam = query ? selectRelevant(team, query, 8) : [...team].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);

      const lines: string[] = [
        "📖 Memories",
        `Project store: ${project.length} total`,
        `Team store: ${team.length} total`,
      ];

      if (showProject.length > 0) {
        lines.push("", "Private/Project:");
        for (const m of showProject) {
          lines.push(`- [${formatAge(m.updatedAt)} | used ${m.accessCount}x] ${m.text}`);
        }
      }

      if (showTeam.length > 0) {
        lines.push("", "Team:");
        for (const m of showTeam) {
          lines.push(`- [${formatAge(m.updatedAt)} | used ${m.accessCount}x] ${m.text}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /memory-snapshot [build|show] <agent-identity> [scope] [query...]
  pi.registerCommand("memory-snapshot", {
    description: "Build/show agent memory snapshots: /memory-snapshot build <agent> [project|local|user] [query]",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /memory-snapshot build <agent> [project|local|user] [query] OR /memory-snapshot show <agent> [scope]", "info");
        return;
      }

      const parts = raw.split(/\s+/);
      const mode = (parts.shift() || "show").toLowerCase();
      const agentIdentity = (parts.shift() || "").trim();
      if (!agentIdentity) {
        ctx.ui.notify("Please provide an agent identity.", "error");
        return;
      }

      let scope: SnapshotScope = "project";
      if (parts[0] && ["project", "local", "user"].includes(parts[0].toLowerCase())) {
        scope = parts.shift()!.toLowerCase() as SnapshotScope;
      }

      if (mode === "build" || mode === "sync") {
        const query = parts.join(" ").trim() || `worker ${agentIdentity}`;
        const snapshot = buildAgentSnapshot(ctx.cwd, agentIdentity, query, scope);
        const file = saveAgentSnapshot(ctx.cwd, snapshot);
        ctx.ui.notify(
          `🧠 Snapshot synced for '${agentIdentity}' (${scope}) with ${snapshot.items.length} items.\n${file}`,
          "success",
        );
        return;
      }

      const snapshot = loadAgentSnapshot(ctx.cwd, agentIdentity, scope);
      if (!snapshot) {
        ctx.ui.notify(`No snapshot found for '${agentIdentity}' in ${scope} scope.`, "info");
        return;
      }

      const lines = [
        `Snapshot: ${snapshot.agentIdentity} (${snapshot.scope})`,
        `Updated: ${formatAge(snapshot.updatedAt)}`,
        `Query: ${snapshot.query || "(none)"}`,
      ];
      for (const item of snapshot.items.slice(0, 12)) {
        lines.push(`- [${item.source} | ${item.score.toFixed(3)}] ${item.text}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /forget [all|team|project|<query>]
  pi.registerCommand("forget", {
    description: "Forget memories: /forget all | project | team | <search text>",
    handler: async (args, ctx) => {
      maybeMigrateLegacyMemory(ctx.cwd);
      const mode = (args || "").trim().toLowerCase();
      const projectFile = getProjectStoreFile(ctx.cwd);
      const teamFile = getTeamStoreFile(ctx.cwd);

      if (!mode || mode === "project") {
        if (!existsSync(projectFile)) {
          ctx.ui.notify("No project memories to forget.", "info");
          return;
        }
        const ok = await ctx.ui.confirm("Forget project memories?", "This will delete all private/project memories for this project.");
        if (!ok) return;
        unlinkSync(projectFile);
        ctx.ui.notify("🗑️ Deleted all project memories.", "success");
        return;
      }

      if (mode === "team") {
        if (!existsSync(teamFile)) {
          ctx.ui.notify("No team memories to forget.", "info");
          return;
        }
        const ok = await ctx.ui.confirm("Forget team memories?", "This will delete all team memories for this repo/team key.");
        if (!ok) return;
        unlinkSync(teamFile);
        ctx.ui.notify("🗑️ Deleted all team memories.", "success");
        return;
      }

      if (mode === "all") {
        const ok = await ctx.ui.confirm("Forget ALL memories?", "This will delete both project and team memories for this workspace.");
        if (!ok) return;
        if (existsSync(projectFile)) unlinkSync(projectFile);
        if (existsSync(teamFile)) unlinkSync(teamFile);
        ctx.ui.notify("🗑️ Deleted all memories (project + team).", "success");
        return;
      }

      const q = mode;
      const filterOut = (records: MemoryRecord[]) => records.filter((r) => !r.text.toLowerCase().includes(q));

      const p = loadStore(projectFile);
      const t = loadStore(teamFile);
      const p2 = filterOut(p);
      const t2 = filterOut(t);
      const removed = (p.length - p2.length) + (t.length - t2.length);

      if (removed === 0) {
        ctx.ui.notify(`No memories matched "${q}".`, "info");
        return;
      }

      writeStore(projectFile, p2);
      writeStore(teamFile, t2);
      ctx.ui.notify(`🧹 Removed ${removed} memories matching "${q}".`, "success");
    },
  });

  // /memory-prune
  pi.registerCommand("memory-prune", {
    description: "Prune and compact memory stores now",
    handler: async (_args, ctx) => {
      const projectFile = getProjectStoreFile(ctx.cwd);
      const teamFile = getTeamStoreFile(ctx.cwd);

      const p = pruneRecords(dedupeExact(loadStore(projectFile)));
      const t = pruneRecords(dedupeExact(loadStore(teamFile)));
      writeStore(projectFile, p);
      writeStore(teamFile, t);

      ctx.ui.notify(`🧠 Memory compacted. Project: ${p.length}, Team: ${t.length}.`, "success");
    },
  });

  // /dream-review
  pi.registerCommand("dream-review", {
    description: "Review lessons and problem memories captured by auto-dream",
    handler: async (_args, ctx) => {
      maybeMigrateLegacyMemory(ctx.cwd);
      const projectFile = getProjectStoreFile(ctx.cwd);
      const projectMemories = loadStore(projectFile);

      const lessonRecords = projectMemories.filter((m) =>
        m.tags.some((t) => ["lesson", "harness-bug", "workaround", "tool-failure", "tool-retry", "tool-fingerprint", "hang-fix", "loop-detector", "high-error-rate", "auto-dream"].includes(t)),
      );

      if (lessonRecords.length === 0) {
        ctx.ui.notify("No lessons or problem memories found yet. They'll be captured at session end.", "info");
        return;
      }

      const lines = [
        "💤 Dream Review — Lessons & Problems",
        `Total captured: ${lessonRecords.length}`,
        "",
      ];

      // Group by severity
      const severityGroups = { high: [] as typeof lessonRecords, medium: [] as typeof lessonRecords, low: [] as typeof lessonRecords };
      for (const m of lessonRecords) {
        if (m.tags.includes("high")) severityGroups.high.push(m);
        else if (m.tags.includes("medium")) severityGroups.medium.push(m);
        else severityGroups.low.push(m);
      }

      for (const [sev, records] of [["🔴 HIGH", severityGroups.high], ["🟡 MEDIUM", severityGroups.medium], ["🟢 LOW", severityGroups.low]] as const) {
        if (records.length === 0) continue;
        lines.push(`${sev} (${records.length}):`);
        for (const m of records.sort((a, b) => b.updatedAt - a.updatedAt)) {
          const tag = m.tags.length > 0 ? ` [${m.tags.join(",")}]` : "";
          const hint = mitigationHintFromTags(m.tags);
          lines.push(`  - [${formatAge(m.updatedAt)} | used ${m.accessCount}x] ${m.text}${tag}`);
          lines.push(`    ↳ mitigation: ${hint}`);
        }
      }

      const fingerprintGroups = new Map<string, { tool: string; sig: string; count: number }>();
      for (const m of lessonRecords) {
        const match = m.text.match(/\[fingerprint tool=([^\s]+) sig=(.*?) count=(\d+)/i);
        if (!match) continue;
        const key = `${match[1]}|${match[2]}`;
        const prev = fingerprintGroups.get(key);
        if (prev) prev.count += Number(match[3] || 1);
        else fingerprintGroups.set(key, { tool: match[1], sig: match[2], count: Number(match[3] || 1) });
      }

      if (fingerprintGroups.size > 0) {
        lines.push("", "Recurring root causes (fingerprints):");
        for (const entry of [...fingerprintGroups.values()].sort((a, b) => b.count - a.count).slice(0, 8)) {
          lines.push(`  - ${entry.tool} :: ${entry.sig}  (seen ${entry.count}x)`);
        }
      }

      lines.push("\nTo remove unwanted lessons: /forget <text>");
      lines.push("To compact: /memory-prune");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
