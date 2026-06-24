import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { KanbanState, Task } from "./types.js";
import { blockerIds, buildTaskBrief, findPiTmuxScript, isTaskReady } from "./store.js";
import { ensureTaskSummary } from "./summary.js";

// ─── Spawn Model Configuration ──────────────────────────────────────────────

interface SpawnModelsConfig {
	provider?: string;
	overlord?: string;  // orchestrator/main agent model
	simple?: string;    // simple tasks (docs, small fixes)
	complex?: string;   // complex tasks (architecture, large refactors)
}

const spawnModelsCache: { config?: SpawnModelsConfig; error?: string } = {};

function loadSpawnModelsConfig(): SpawnModelsConfig | undefined {
	// Return cached result (config doesn't change mid-session)
	if (spawnModelsCache.config) return spawnModelsCache.config;
	if (spawnModelsCache.error) return undefined;

	try {
		const modelsFile = join(homedir(), ".pi", "agent", "models.json");
		if (!existsSync(modelsFile)) {
			spawnModelsCache.error = "models.json not found";
			return undefined;
		}
		const raw = JSON.parse(readFileSync(modelsFile, "utf-8"));
		const spawnModels = raw.spawnModels;
		if (spawnModels) {
			spawnModelsCache.config = spawnModels;
			return spawnModels;
		}
		spawnModelsCache.error = "no spawnModels section in models.json";
		return undefined;
	} catch {
		spawnModelsCache.error = "failed to parse models.json";
		return undefined;
	}
}

/**
 * Shell-quote a value so it survives the pi-tmux script's arg-joining
 * (which concatenates with spaces and executes via bash -lc).
 */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Return the model/provider args to use for spawning a worker.
 * Uses models.json spawnModels config if available, otherwise falls back to
 * hardcoded defaults (gpt-5.4-codex / gpt-5-mini via github-copilot).
 */
function getSpawnArgs(complexity: "simple" | "complex"): { provider: string; model: string } {
	const config = loadSpawnModelsConfig();
	if (config?.provider && config[complexity === "simple" ? "simple" : "complex"]) {
		const modelKey = complexity === "simple" ? "simple" : "complex";
		return { provider: config.provider, model: config[modelKey] };
	}
	// Hardcoded fallback — these will be ignored if user has configured spawnModels
	return {
		provider: "github-copilot",
		model: complexity === "complex" ? "gpt-5.4-codex" : "gpt-5-mini",
	};
}

export interface KanbanDependencies {
	state: KanbanState;
	boardRoot: string;
	saveState: () => void;
	updateWidget: (ctx: ExtensionContext) => void;
	lastCtx: ExtensionContext | null;
	lastAssistantText: string;
	lastAssistantByTaskId: Map<number, string>;
}

function parseSpawnedLockName(output: string, fallback: string): string {
	const started = output.match(/Pi agent '([^']+)' started/);
	if (started?.[1]) return started[1];
	const created = output.match(/Created '([^']+)'/);
	if (created?.[1]) return created[1];
	return fallback;
}

function shortPreview(text: string, max = 400): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

function getReadyUnownedTasks(state: KanbanState): Task[] {
	return state.tasks
		.filter((t) => t.status !== "done")
		.filter((t) => isTaskReady(t, state.tasks))
		.filter((t) => !t.owner)
		.sort((a, b) => a.id - b.id);
}

function lockSafeToken(value: string, max = 40): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const trimmed = cleaned.slice(0, max).replace(/-+$/g, "");
	return trimmed || "worker";
}

function deriveTaskAgentIdentity(task: Task): string {
	const titlePart = lockSafeToken(task.title, 24);
	return `t${task.id}-${titlePart}`;
}

function derivePreferredLockName(task: Task): string {
	const identity = task.agentIdentity ?? deriveTaskAgentIdentity(task);
	return `kanban-${lockSafeToken(identity, 48)}`;
}

const AGENT_RETRY_BUDGET = 3;

type SnapshotItem = { text: string; tags: string[]; score: number; source: "project" | "team" };

type PreflightCheck = {
	name: string;
	ok: boolean;
	detail: string;
};

function formatPreflightMessage(prefix: string, checks: PreflightCheck[], fallback: string[]): string {
	const checkLines = checks.map((check) => `- ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
	const fallbackLines = fallback.length > 0 ? fallback.map((line, idx) => `${idx + 1}. ${line}`) : ["1. Inspect task + board state before retrying."];
	return `${prefix}\n\nPreflight checks:\n${checkLines.join("\n")}\n\nSuggested fallback:\n${fallbackLines.join("\n")}`;
}

function getMemoryRoot(): string {
	const dir = join(homedir(), ".pi", "memory-v2");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function sanitizeMemoryToken(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getProjectKey(cwd: string): string {
	return sanitizeMemoryToken(cwd).slice(-120) || "default";
}

function getProjectMemoryStore(cwd: string): string {
	return join(getMemoryRoot(), "projects", `${getProjectKey(cwd)}.jsonl`);
}

function getTeamMemoryStore(cwd: string): string {
	const team = sanitizeMemoryToken(process.env.PI_MEMORY_TEAM || process.env.PI_TEAM || "default-team");
	return join(getMemoryRoot(), "teams", `${team}.jsonl`);
}

function getSnapshotFile(cwd: string, agentIdentity: string): string {
	return join(getMemoryRoot(), "agent-snapshots", "project", getProjectKey(cwd), `${sanitizeMemoryToken(agentIdentity)}.json`);
}

function parseMemoryStore(file: string): Array<{ text: string; tags: string[]; source: "project" | "team" }> {
	if (!existsSync(file)) return [];
	try {
		const raw = readFileSync(file, "utf-8");
		const rows = raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { text?: unknown; tags?: unknown });
		return rows
			.filter((r): r is { text: string; tags?: unknown } => typeof r.text === "string")
			.map((r) => ({
				text: r.text.trim(),
				tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
				source: file.includes("/teams/") ? "team" : "project",
			}))
			.filter((r) => r.text.length > 0);
	} catch {
		return [];
	}
}

function snapshotTokens(query: string): string[] {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9_\-\s]/g, " ")
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3)
		.slice(0, 24);
}

function scoreSnapshotItem(text: string, tags: string[], tokens: string[]): number {
	const hay = `${text} ${tags.join(" ")}`.toLowerCase();
	let overlap = 0;
	for (const t of tokens) if (hay.includes(t)) overlap += 1;
	let score = tokens.length > 0 ? overlap / tokens.length : 0;
	if (tags.some((t) => ["auto-dream", "objective", "completion", "code-change", "preference"].includes(t))) score += 0.2;
	if (tags.some((t) => ["dream", "memory"].includes(t))) score += 0.05;
	return score;
}

function syncWorkerSnapshot(cwd: string, agentIdentity: string, query: string): SnapshotItem[] {
	const projectRows = parseMemoryStore(getProjectMemoryStore(cwd));
	const teamRows = parseMemoryStore(getTeamMemoryStore(cwd));
	const all = [...projectRows, ...teamRows];
	const tokens = snapshotTokens(query);
	const picked = all
		.map((row) => ({ ...row, score: scoreSnapshotItem(row.text, row.tags, tokens) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, 12)
		.map((x) => ({ text: x.text, tags: x.tags.slice(0, 6), score: Number(x.score.toFixed(3)), source: x.source }));

	const file = getSnapshotFile(cwd, agentIdentity);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			{
				agentIdentity,
				projectKey: getProjectKey(cwd),
				updatedAt: Date.now(),
				query,
				items: picked,
			},
			null,
			2,
		) + "\n",
		"utf-8",
	);

	return picked;
}

export function registerKanbanTools(pi: ExtensionAPI, deps: KanbanDependencies) {
	const spawnRetryCountByTask = new Map<number, number>();

	pi.registerTool({
		name: "kanban_task",
		label: "Kanban Task",
		description:
			"Manage kanban tasks. Actions: " +
			"list (show all tasks with status/context/files/deps/owner). " +
			"get (task details; task_id required). " +
			"set_context (update notes; task_id + context required). " +
			"add_file (associate a file; task_id + file required). " +
			"move_status (change column; task_id + status required). " +
			"set_owner (assign owner; task_id + owner required). " +
			"claim_next (claim first ready unowned task; owner optional). " +
			"set_required_tasks (set dependency IDs; task_id + required_ids required). " +
			"set_agent_name (record spawned agent lock name; task_id + agent_name required). " +
			"agent_route (show the exact lock + send/capture/wait commands for this task's agent). " +
			"send_control (send structured control messages like shutdown/plan approvals between task agents). " +
			"recover_agent (resume/recover an interrupted task agent with reconstructed pending state). " +
			"sync_agent_status (capture latest output and refresh running/completed state). " +
			"stop_agent (kill spawned agent pane and mark task agent as stopped).",

		parameters: Type.Object({
			action: StringEnum([
				"list",
				"get",
				"set_context",
				"add_file",
				"move_status",
				"set_owner",
				"claim_next",
				"set_required_tasks",
				"set_agent_name",
				"agent_route",
				"send_control",
				"recover_agent",
				"sync_agent_status",
				"stop_agent",
			] as const),
			task_id: Type.Optional(Type.Number({ description: "ID of the task to operate on" })),
			to_task_id: Type.Optional(Type.Number({ description: "Destination task ID for control messages" })),
			context: Type.Optional(Type.String({ description: "Context / notes text" })),
			file: Type.Optional(Type.String({ description: "File path to associate" })),
			status: Type.Optional(StringEnum(["todo", "in-progress", "done"] as const)),
			required_ids: Type.Optional(
				Type.Array(Type.Number(), { description: "Task IDs that must be done before this task can start" }),
			),
			agent_name: Type.Optional(Type.String({ description: "tmux lock name of the spawned pi agent" })),
			owner: Type.Optional(Type.String({ description: "Task owner (agent/person label)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory override for recover_agent" })),
			complexity: Type.Optional(StringEnum(["simple", "complex"] as const)),
			control_type: Type.Optional(
				StringEnum([
					"shutdown_request",
					"shutdown_response",
					"plan_approval_request",
					"plan_approval_response",
				] as const),
			),
			request_id: Type.Optional(Type.String({ description: "Control message request ID" })),
			approve: Type.Optional(Type.Boolean({ description: "Approval flag for *_response control types" })),
			reason: Type.Optional(Type.String({ description: "Optional reason for shutdown control messages" })),
			feedback: Type.Optional(Type.String({ description: "Optional feedback for plan approval control responses" })),
		}),

		async execute(_callId, params, signal, _onUpdate, ctx) {
			const state = deps.state;
			const boardChecks: PreflightCheck[] = [
				{
					name: "board_root",
					ok: Boolean(deps.boardRoot),
					detail: deps.boardRoot ? deps.boardRoot : "board root not initialised",
				},
				{
					name: "board_exists",
					ok: Boolean(deps.boardRoot) && existsSync(deps.boardRoot),
					detail: deps.boardRoot && existsSync(deps.boardRoot) ? "board directory is available" : "board directory is missing",
				},
				{
					name: "task_cache",
					ok: Array.isArray(state.tasks),
					detail: Array.isArray(state.tasks) ? `${state.tasks.length} task(s) cached` : "task cache unavailable",
				},
			];
			if (params.action !== "list" && boardChecks.some((check) => !check.ok)) {
				return {
					content: [{
						type: "text",
						text: formatPreflightMessage(
							`Cannot run kanban_task(${params.action}) because board preflight failed.`,
							boardChecks,
							[
								"Run kanban_task(action: 'list') to force a light board read.",
								"If this is a fresh workspace, create / initialise .kanban first.",
								"Retry once board path is valid.",
							],
						),
					}],
					details: { preflight: boardChecks, action: params.action },
				};
			}
			try {
			switch (params.action) {
				case "list": {
					if (state.tasks.length === 0) {
						return { content: [{ type: "text", text: "No tasks." }], details: {} };
					}
					const lines = state.tasks.map((t) => {
						const activeMarker = t.id === state.activeTaskId ? " [ACTIVE]" : "";
						const blockers = blockerIds(t, state.tasks);
						const blocked = blockers.length > 0 ? " [BLOCKED]" : "";
						const ownerLine = t.owner ? `\n  Owner: ${t.owner}` : "";
						const agentLine = t.spawnedAgentName
							? `\n  Agent: ${t.spawnedAgentName}${t.agentRunStatus ? ` [${t.agentRunStatus}]` : ""}`
							: "";
						const identityLine = t.agentIdentity ? `\n  Agent identity: ${t.agentIdentity}` : "";
						const preferredLockLine = t.preferredAgentLockName ? `\n  Preferred lock: ${t.preferredAgentLockName}` : "";
						const retryLine = typeof t.agentRetryCount === "number"
							? `\n  Spawn retries: ${t.agentRetryCount}/${t.agentRetryBudget ?? AGENT_RETRY_BUDGET}`
							: "";
						const contextLine = t.context ? `\n  Context: ${t.context}` : "";
						const filesLine = t.files.length > 0 ? `\n  Files: ${t.files.join(", ")}` : "";
						const depsLine =
							t.requiredTaskIds.length > 0
								? `\n  Requires: ${t.requiredTaskIds.map((id) => `#${id}`).join(", ")}`
								: "";
						const blockedByLine = blockers.length > 0 ? `\n  Blocked by: ${blockers.map((id) => `#${id}`).join(", ")}` : "";
						const summaryLine = t.summaryFile ? `\n  Summary: ${t.summaryFile}` : "";
						return `#${t.id} [${t.status}]${blocked}${activeMarker} ${t.title}${ownerLine}${depsLine}${blockedByLine}${contextLine}${agentLine}${identityLine}${preferredLockLine}${retryLine}${filesLine}${summaryLine}`;
					});
					return {
						content: [{ type: "text", text: lines.join("\n\n") }],
						details: { tasks: state.tasks },
					};
				}

				case "get": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) {
						return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					}
					const blockers = blockerIds(task, state.tasks);
					return {
						content: [
							{
								type: "text",
								text:
									`#${task.id} [${task.status}] ${task.title}` +
									(task.owner ? `\nOwner: ${task.owner}` : "") +
									(task.requiredTaskIds.length ? `\nRequires: ${task.requiredTaskIds.map((id) => `#${id}`).join(", ")}` : "") +
									(blockers.length ? `\nBlocked by: ${blockers.map((id) => `#${id}`).join(", ")}` : "") +
									(task.spawnedAgentName
										? `\nAgent: ${task.spawnedAgentName}${task.agentRunStatus ? ` [${task.agentRunStatus}]` : ""}`
										: "") +
									(task.agentIdentity ? `\nAgent identity: ${task.agentIdentity}` : "") +
									(task.preferredAgentLockName ? `\nPreferred lock: ${task.preferredAgentLockName}` : "") +
									(typeof task.agentRetryCount === "number"
										? `\nSpawn retries: ${task.agentRetryCount}/${task.agentRetryBudget ?? AGENT_RETRY_BUDGET}`
										: "") +
									(task.context ? `\nContext: ${task.context}` : "") +
									(task.files.length ? `\nFiles: ${task.files.join(", ")}` : ""),
							},
						],
						details: { task },
					};
				}

				case "set_context": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					task.context = params.context ?? "";
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Updated context for task #${task.id}.` }],
						details: { taskId: task.id, context: task.context },
					};
				}

				case "add_file": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					const file = (params.file ?? "").replace(/^@/, "");
					if (file && !task.files.includes(file)) task.files.push(file);
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Added file "${file}" to task #${task.id}.` }],
						details: { taskId: task.id, files: task.files },
					};
				}

				case "set_owner": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					if (!params.owner) return { content: [{ type: "text", text: "owner is required for set_owner." }], details: {} };
					task.owner = params.owner;
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Task #${task.id} owner set to "${task.owner}".` }],
						details: { taskId: task.id, owner: task.owner },
					};
				}

				case "claim_next": {
					const owner = params.owner?.trim() || "orchestrator";
					const next = getReadyUnownedTasks(state)[0];
					if (!next) {
						return {
							content: [{ type: "text", text: "No ready, unowned tasks to claim right now." }],
							details: {},
						};
					}
					next.owner = owner;
					if (next.status === "todo") next.status = "in-progress";
					state.activeTaskId = next.id;
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Claimed task #${next.id} for "${owner}" and set it active.` }],
						details: { taskId: next.id, owner },
					};
				}

				case "move_status": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					if (!params.status) return { content: [{ type: "text", text: "status is required for move_status." }], details: {} };

					const statusChecks: PreflightCheck[] = [
						{ name: "task_exists", ok: true, detail: `task #${task.id} located` },
						{ name: "target_status", ok: true, detail: `request ${task.status} -> ${params.status}` },
					];
					if (params.status === "in-progress") {
						const blockers = blockerIds(task, state.tasks);
						if (blockers.length > 0) {
							statusChecks.push({
								name: "dependencies",
								ok: false,
								detail: `blocked by ${blockers.map((id) => `#${id}`).join(", ")}`,
							});
							return {
								content: [{
									type: "text",
									text: formatPreflightMessage(
										`Cannot move task #${task.id} to in-progress yet.`,
										statusChecks,
										[
											`Finish dependency tasks first: ${blockers.map((id) => `#${id}`).join(", ")}.`,
											"Use kanban_task(action: 'get', task_id: <depId>) to inspect blocker context.",
										],
									),
								}],
								details: { taskId: task.id, blockers, preflight: statusChecks },
							};
						}
					}

					const previousStatus = task.status;
					task.status = params.status;

					if (params.status === "in-progress") {
						task.owner = task.owner ?? params.owner ?? task.spawnedAgentName ?? "orchestrator";
					}
					if (params.status === "done") {
						task.completedAt = Date.now();
						if (task.agentRunStatus === "running") {
							task.agentRunStatus = "completed";
						}
					}
					if (params.status === "todo") {
						task.spawnedAgentName = undefined;
						task.agentRunStatus = undefined;
						task.agentSpawnStrategy = undefined;
						task.agentLastError = undefined;
						task.agentLastOutput = undefined;
					}

					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);

					if (task.status === "done" && previousStatus !== "done" && deps.lastCtx) {
						await ensureTaskSummary(pi, task, deps.lastCtx, deps.boardRoot, {
							promptToListen: false,
							saveState: deps.saveState,
							updateWidget: deps.updateWidget,
							source: deps.lastAssistantByTaskId.get(task.id) ?? deps.lastAssistantText,
						});
					}

					const completionNudge =
						task.status === "done"
							? (() => {
									const ready = getReadyUnownedTasks(state).slice(0, 3);
									if (ready.length === 0) return "\nNo immediately ready unowned tasks.";
									return `\nNext ready tasks: ${ready.map((t) => `#${t.id}`).join(", ")}.`;
							  })()
							: "";

					return {
						content: [{ type: "text", text: `Task #${task.id} moved to "${task.status}".${completionNudge}` }],
						details: { taskId: task.id, status: task.status, owner: task.owner },
					};
				}

				case "set_required_tasks": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					const ids = params.required_ids ?? [];
					const missing = ids.filter((id) => !state.tasks.find((t) => t.id === id));
					if (missing.length > 0) {
						return {
							content: [{ type: "text", text: `Unknown task IDs: ${missing.join(", ")}` }],
							details: {},
						};
					}
					task.requiredTaskIds = ids;
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					const ready = isTaskReady(task, state.tasks);
					return {
						content: [
							{
								type: "text",
								text:
									`Updated dependencies for task #${task.id}. ` +
									(ids.length === 0
										? "No dependencies."
										: `Requires: ${ids.map((id) => `#${id}`).join(", ")}. ` +
											(ready ? "All dependencies are done – task is READY." : "Task is BLOCKED.")),
							},
						],
						details: { taskId: task.id, requiredTaskIds: task.requiredTaskIds, ready },
					};
				}

				case "set_agent_name": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					task.agentIdentity = task.agentIdentity ?? deriveTaskAgentIdentity(task);
					task.spawnedAgentName = params.agent_name ?? undefined;
					if (task.spawnedAgentName) {
						task.preferredAgentLockName = task.preferredAgentLockName ?? task.spawnedAgentName;
					}
					task.agentRunStatus = task.spawnedAgentName ? "running" : task.agentRunStatus;
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Agent name set to "${task.spawnedAgentName}" for task #${task.id}.` }],
						details: { taskId: task.id, spawnedAgentName: task.spawnedAgentName },
					};
				}

				case "agent_route": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					const resolvedLock = task.spawnedAgentName;
					const preferredLock = task.preferredAgentLockName ?? derivePreferredLockName(task);
					if (!resolvedLock) {
						return {
							content: [{ type: "text", text: `Task #${task.id} has no active agent lock. Preferred lock would be '${preferredLock}'.` }],
							details: { taskId: task.id, preferredLockName: preferredLock },
						};
					}
					const remapLine = preferredLock !== resolvedLock ? `\nNOTE: preferred lock '${preferredLock}' was remapped to '${resolvedLock}'.` : "";
					return {
						content: [{
							type: "text",
							text:
								`Use this lock for task #${task.id}: '${resolvedLock}'.` +
								`${remapLine}\n` +
								`tmux-capture('${resolvedLock}')\n` +
								`tmux-send('${resolvedLock}', '<message>')\n` +
								`semaphore_wait('${resolvedLock}')`,
						}],
						details: { taskId: task.id, lockName: resolvedLock, preferredLockName: preferredLock },
					};
				}

				case "send_control": {
					const fromTask = state.tasks.find((t) => t.id === (params.task_id ?? state.activeTaskId ?? -1));
					if (!fromTask) {
						return { content: [{ type: "text", text: "send_control needs a source task_id (or an active task)." }], details: {} };
					}
					if (!params.to_task_id) {
						return { content: [{ type: "text", text: "send_control requires to_task_id." }], details: {} };
					}
					const toTask = state.tasks.find((t) => t.id === params.to_task_id);
					if (!toTask) {
						return { content: [{ type: "text", text: `Destination task #${params.to_task_id} not found.` }], details: {} };
					}
					if (!params.control_type) {
						return { content: [{ type: "text", text: "send_control requires control_type." }], details: {} };
					}
					if (!toTask.spawnedAgentName) {
						return {
							content: [{ type: "text", text: `Task #${toTask.id} has no spawned agent lock to receive control messages.` }],
							details: {},
						};
					}

					const isResponse = params.control_type.endsWith("_response");
					if (isResponse && typeof params.approve !== "boolean") {
						return { content: [{ type: "text", text: "*_response control messages require approve=true/false." }], details: {} };
					}

					const requestId =
						params.request_id ??
						`${params.control_type}-${Date.now()}-${fromTask.id}-to-${toTask.id}`;

					const payload: Record<string, unknown> = {
						type: params.control_type,
						request_id: requestId,
						from_task_id: fromTask.id,
						to_task_id: toTask.id,
						timestamp: new Date().toISOString(),
					};
					if (typeof params.approve === "boolean") payload.approve = params.approve;
					if (params.reason) payload.reason = params.reason;
					if (params.feedback) payload.feedback = params.feedback;
					if (params.context) payload.context = params.context;

					const piTmuxScript = findPiTmuxScript();
					if (!piTmuxScript) throw new Error("pi-tmux script not found.");

					const text = JSON.stringify(payload);
					const sent = await pi.exec("bash", [piTmuxScript, "send", toTask.spawnedAgentName, text], { signal });
					if (sent.code !== 0) {
						const err = shortPreview(sent.stderr || sent.stdout || "failed to send control message");
						fromTask.agentLastError = err;
						deps.saveState();
						if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
						return {
							content: [{ type: "text", text: `Failed to send ${params.control_type} to task #${toTask.id}: ${err}` }],
							details: { taskId: fromTask.id, toTaskId: toTask.id, error: err },
						};
					}

					const logLine = `[control:${params.control_type}] #${fromTask.id} -> #${toTask.id} req=${requestId}`;
					fromTask.context = `${fromTask.context}\n${logLine}`.trim();
					toTask.context = `${toTask.context}\n[control-received] ${logLine}`.trim();
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);

					return {
						content: [
							{
								type: "text",
								text:
									`Sent ${params.control_type} from task #${fromTask.id} to task #${toTask.id} via '${toTask.spawnedAgentName}'.\n` +
									`request_id: ${requestId}\n` +
									`payload: ${text}`,
							},
						],
						details: {
							fromTaskId: fromTask.id,
							toTaskId: toTask.id,
							lockName: toTask.spawnedAgentName,
							requestId,
							payload,
						},
					};
				}

				case "recover_agent": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };

					task.agentIdentity = task.agentIdentity ?? deriveTaskAgentIdentity(task);
					task.preferredAgentLockName = task.preferredAgentLockName ?? derivePreferredLockName(task);

					const piTmuxScript = findPiTmuxScript();
					if (!piTmuxScript) throw new Error("pi-tmux script not found.");

					if (task.spawnedAgentName) {
						const existingCapture = await pi.exec("bash", [piTmuxScript, "capture", task.spawnedAgentName, "30"], { signal });
						if (existingCapture.code === 0) {
							task.agentRunStatus = "running";
							task.agentLastOutput = shortPreview(existingCapture.stdout || "");
							task.agentLastError = undefined;
							deps.saveState();
							if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
							return {
								content: [{ type: "text", text: `Agent already running on '${task.spawnedAgentName}'. No recovery needed.` }],
								details: { taskId: task.id, lockName: task.spawnedAgentName, alreadyRunning: true },
							};
						}
					}

					const agentCwd = params.cwd ?? ctx.cwd;
					const requestedLockName = task.preferredAgentLockName;
					const baseArgs = ["coding-agent", requestedLockName, agentCwd];
					const { provider, model } = getSpawnArgs(params.complexity === "complex" ? "complex" : "simple");
					const preferredArgs = [...baseArgs, "--provider", shellQuote(provider), "--model", shellQuote(model)];

					const preferredSpawn = await pi.exec("bash", [piTmuxScript, ...preferredArgs], { signal });
					let spawnResult = preferredSpawn;
					let spawnStrategy: Task["agentSpawnStrategy"] = "preferred";
					if (preferredSpawn.code !== 0) {
						const fallbackSpawn = await pi.exec("bash", [piTmuxScript, ...baseArgs], { signal });
						if (fallbackSpawn.code !== 0) {
							task.agentRunStatus = "failed";
							task.agentLastError = shortPreview(
								`recover preferred: ${preferredSpawn.stderr || preferredSpawn.stdout || "unknown"} | fallback: ${fallbackSpawn.stderr || fallbackSpawn.stdout || "unknown"}`,
							);
							deps.saveState();
							if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
							return {
								content: [{ type: "text", text: `Recovery spawn failed: ${task.agentLastError}` }],
								details: { taskId: task.id, error: task.agentLastError },
							};
						}
						spawnResult = fallbackSpawn;
						spawnStrategy = "fallback-default";
					}

					const activeLockName = parseSpawnedLockName(spawnResult.stdout || "", requestedLockName);

					const blockers = blockerIds(task, state.tasks);
					const snapshotItems = syncWorkerSnapshot(
						ctx.cwd,
						task.agentIdentity,
						`${task.title} ${task.context} ${task.files.join(" ")}`,
					);
					const reconstruction = {
						type: "recover_resume",
						task_id: task.id,
						title: task.title,
						owner: task.owner,
						required_ids: task.requiredTaskIds,
						blocked_by: blockers,
						files: task.files,
						context: task.context,
						last_output: task.agentLastOutput,
						last_error: task.agentLastError,
						memory_snapshot: snapshotItems.slice(0, 8),
						notes:
							"You are resuming interrupted background work. Reconstruct pending state from this payload, continue from the next unfinished step, then report completion clearly.",
					};

					const resumeMessage =
						`RECOVERY RESUME for task #${task.id} '${task.title}'.\n` +
						`Follow this state snapshot to continue unfinished work:\n` +
						`${JSON.stringify(reconstruction)}`;

					const sent = await pi.exec("bash", [piTmuxScript, "send", activeLockName, resumeMessage], { signal });
					if (sent.code !== 0) {
						task.agentLastError = shortPreview(sent.stderr || sent.stdout || "failed to send recovery resume message");
					}

					task.spawnedAgentName = activeLockName;
					task.agentRunStatus = "running";
					task.agentSpawnStrategy = spawnStrategy;
					task.status = "in-progress";
					task.owner = task.owner ?? activeLockName;
					task.agentLastOutput = shortPreview(spawnResult.stdout || "");
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);

					return {
						content: [{
							type: "text",
							text:
								`Recovered task #${task.id} on lock '${activeLockName}'.\n` +
								`request lock: '${requestedLockName}', strategy: ${spawnStrategy}.\n` +
								`State reconstruction payload delivered to worker.\n` +
								`Use: tmux-capture('${activeLockName}') / tmux-send('${activeLockName}', '<message>') / semaphore_wait('${activeLockName}')`,
						}],
						details: {
							taskId: task.id,
							lockName: activeLockName,
							requestedLockName,
							spawnStrategy,
							reconstruction,
						},
					};
				}

				case "sync_agent_status": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					if (!task.spawnedAgentName) {
						return { content: [{ type: "text", text: `Task #${task.id} has no spawned agent.` }], details: {} };
					}
					const piTmuxScript = findPiTmuxScript();
					if (!piTmuxScript) throw new Error("pi-tmux script not found.");

					const capture = await pi.exec("bash", [piTmuxScript, "capture", task.spawnedAgentName, "80"], { signal });
					if (capture.code === 0) {
						task.agentRunStatus = "running";
						task.agentLastOutput = shortPreview(capture.stdout || "");
						task.agentLastError = undefined;
						deps.saveState();
						if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
						return {
							content: [{ type: "text", text: `Agent '${task.spawnedAgentName}' is running. Output snapshot updated.` }],
							details: { taskId: task.id, agentRunStatus: task.agentRunStatus, preview: task.agentLastOutput },
						};
					}

					const err = capture.stderr || capture.stdout || "unknown capture error";
					task.agentLastError = shortPreview(err);
					if (/lock .* not found/i.test(err)) {
						task.agentRunStatus = task.agentRunStatus === "failed" ? "failed" : "completed";
					}
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Could not capture '${task.spawnedAgentName}'. ${task.agentLastError}` }],
						details: { taskId: task.id, agentRunStatus: task.agentRunStatus, error: task.agentLastError },
					};
				}

				case "stop_agent": {
					const task = state.tasks.find((t) => t.id === params.task_id);
					if (!task) return { content: [{ type: "text", text: `Task #${params.task_id} not found.` }], details: {} };
					if (!task.spawnedAgentName) {
						return { content: [{ type: "text", text: `Task #${task.id} has no spawned agent.` }], details: {} };
					}
					const piTmuxScript = findPiTmuxScript();
					if (!piTmuxScript) throw new Error("pi-tmux script not found.");

					const killed = await pi.exec("bash", [piTmuxScript, "kill", task.spawnedAgentName], { signal });
					if (killed.code !== 0) {
						task.agentLastError = shortPreview(killed.stderr || killed.stdout || "unknown kill error");
						task.agentRunStatus = "failed";
						deps.saveState();
						if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
						return {
							content: [{ type: "text", text: `Failed to stop '${task.spawnedAgentName}': ${task.agentLastError}` }],
							details: { taskId: task.id, error: task.agentLastError },
						};
					}

					task.agentRunStatus = "stopped";
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{ type: "text", text: `Stopped agent '${task.spawnedAgentName}' for task #${task.id}.` }],
						details: { taskId: task.id, agentRunStatus: task.agentRunStatus },
					};
				}
			}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{
						type: "text",
						text: formatPreflightMessage(
							`kanban_task(${params.action}) failed gracefully.`,
							boardChecks,
							[
								`Error: ${shortPreview(message, 220)}`,
								"Run kanban_task(action: 'get', task_id: <id>) to verify task state.",
								"If this action targets an agent, check lock health with kanban_task(action: 'agent_route') then tmux-capture.",
							],
						),
					}],
					details: { action: params.action, error: message, preflight: boardChecks },
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("kanban_task ")) + theme.fg("muted", args.action);
			if (args.task_id !== undefined) text += theme.fg("accent", ` #${args.task_id}`);
			if (args.to_task_id !== undefined) text += theme.fg("accent", ` -> #${args.to_task_id}`);
			if (args.control_type) text += theme.fg("warning", `  ${args.control_type}`);
			if (args.context) text += theme.fg("dim", `  "${args.context.slice(0, 40)}${args.context.length > 40 ? "…" : ""}"`);
			if (args.file) text += theme.fg("dim", `  ${args.file}`);
			if (args.status) text += theme.fg("muted", `  → ${args.status}`);
			if (args.owner) text += theme.fg("accent", `  owner:${args.owner}`);
			if (args.required_ids?.length) text += theme.fg("dim", `  requires:[${args.required_ids.map((id: number) => `#${id}`).join(",")}]`);
			if (args.agent_name) text += theme.fg("accent", `  ⚡ ${args.agent_name}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const firstContent = result.content[0];
			const text = firstContent?.type === "text" ? firstContent.text : "";
			if (result.isError) return new Text(theme.fg("error", text), 0, 0);
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "kanban_spawn",
		label: "Kanban Spawn",
		description:
			"Spawn a pi-tmux coding agent to work on a kanban task. " +
			"Validates dependencies, writes a task brief, tries preferred model first and falls back to default spawn mode if needed. " +
			"Tracks spawned-agent lifecycle on the task (running/completed/failed/stopped).",

		parameters: Type.Object({
			task_id: Type.Number({ description: "ID of the kanban task to spawn an agent for" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent. Defaults to the current session cwd." })),
			complexity: Type.Union(
				[
					Type.Literal("simple", { description: "Use for documentation, simple fixes, or small tasks" }),
					Type.Literal("complex", { description: "Use for architectural changes, large refactors, or new features" }),
				],
				{ description: "The complexity of the task, determining which model to use." },
			),
			context_alert_percent: Type.Optional(
				Type.Number({
					description: "Context usage % at which to release a <lockName>:context semaphore so you can hand off or compact.",
				}),
			),
		}),

		async execute(_callId, params, signal, _onUpdate, ctx) {
			const state = deps.state;
			const task = state.tasks.find((t) => t.id === params.task_id);
			if (!task) {
				const checks: PreflightCheck[] = [
					{ name: "task_exists", ok: false, detail: `task #${params.task_id} not found` },
					{ name: "board_tasks", ok: true, detail: `${state.tasks.length} task(s) currently loaded` },
				];
				return {
					content: [{
						type: "text",
						text: formatPreflightMessage(
							"Cannot run kanban_spawn because task preflight failed.",
							checks,
							[
								"Run kanban_task(action: 'list') to identify a valid task_id.",
								"If a task was archived/moved recently, refresh and retry with the new ID.",
							],
						),
					}],
					details: { taskId: params.task_id, preflight: checks },
				};
			}

			const blockers = blockerIds(task, state.tasks);
			const retryCount = spawnRetryCountByTask.get(task.id) ?? task.agentRetryCount ?? 0;
			const preflightChecks: PreflightCheck[] = [
				{ name: "board_exists", ok: Boolean(deps.boardRoot) && existsSync(deps.boardRoot), detail: deps.boardRoot || "(missing board root)" },
				{ name: "task_status", ok: task.status !== "done", detail: `task is currently ${task.status}` },
				{ name: "dependencies", ok: blockers.length === 0, detail: blockers.length === 0 ? "all dependencies complete" : `blocked by ${blockers.map((id) => `#${id}`).join(", ")}` },
				{ name: "retry_budget", ok: retryCount < AGENT_RETRY_BUDGET, detail: `${retryCount}/${AGENT_RETRY_BUDGET} failed spawn attempts used` },
				{ name: "existing_agent", ok: !(task.spawnedAgentName && task.agentRunStatus === "running"), detail: task.spawnedAgentName ? `${task.spawnedAgentName} [${task.agentRunStatus ?? "unknown"}]` : "no active lock" },
			];
			if (preflightChecks.some((check) => !check.ok)) {
				const fallback: string[] = [];
				if (task.status === "done") fallback.push("Reopen the task first: kanban_task(action: 'move_status', task_id: <id>, status: 'in-progress').");
				if (blockers.length > 0) fallback.push(`Complete dependency tasks first: ${blockers.map((id) => `#${id}`).join(", ")}.`);
				if (retryCount >= AGENT_RETRY_BUDGET) fallback.push("Retry budget exhausted. Use kanban_task(action: 'recover_agent', task_id: <id>) or inspect tmux health before retrying spawn.");
				if (task.spawnedAgentName && task.agentRunStatus === "running") fallback.push(`Agent already running on '${task.spawnedAgentName}'. Use kanban_task(action: 'agent_route', task_id: <id>) and resume supervision.`);
				return {
					content: [{
						type: "text",
						text: formatPreflightMessage(`Cannot spawn worker for task #${task.id}.`, preflightChecks, fallback),
					}],
					details: { taskId: task.id, preflight: preflightChecks, retryCount, retryBudget: AGENT_RETRY_BUDGET },
				};
			}

			const piTmuxScript = findPiTmuxScript();
			if (!piTmuxScript) {
				return {
					content: [{
						type: "text",
						text: formatPreflightMessage(
							`Cannot spawn task #${task.id}: pi-tmux script is unavailable.`,
							preflightChecks,
							[
								"Verify pi-tmux installation under ~/.pi/agent/git/*/*/bin/pi-tmux.",
								"As a fallback, start a manual tmux-coding-agent and bind it with kanban_task(action: 'set_agent_name').",
							],
						),
					}],
					details: { taskId: task.id, preflight: preflightChecks, error: "pi-tmux script not found" },
				};
			}

			const scratchDir = join(ctx.cwd, "dev", "scratch");
			mkdirSync(scratchDir, { recursive: true });
			const briefFile = join(scratchDir, `kanban-task-${task.id}.md`);
			const brief = buildTaskBrief(task, state.tasks);
			writeFileSync(briefFile, brief, { encoding: "utf-8", mode: 0o600 });

			task.agentIdentity = task.agentIdentity ?? deriveTaskAgentIdentity(task);
			task.preferredAgentLockName = task.preferredAgentLockName ?? derivePreferredLockName(task);
			const requestedLockName = task.preferredAgentLockName;
			const agentCwd = params.cwd ?? ctx.cwd;

			const baseArgs = ["coding-agent", requestedLockName, agentCwd];
			if (params.context_alert_percent !== undefined) {
				baseArgs.push("--context-alert", String(params.context_alert_percent));
			}

			const { provider, model } = getSpawnArgs(params.complexity);
			const preferredArgs = [...baseArgs, "--provider", shellQuote(provider), "--model", shellQuote(model)];
			const preferredSpawn = await pi.exec("bash", [piTmuxScript, ...preferredArgs], { signal });

			let spawnResult = preferredSpawn;
			let spawnStrategy: Task["agentSpawnStrategy"] = "preferred";

			if (preferredSpawn.code !== 0) {
				const fallbackSpawn = await pi.exec("bash", [piTmuxScript, ...baseArgs], { signal });
				if (fallbackSpawn.code !== 0) {
					task.agentRunStatus = "failed";
					task.agentLastError = shortPreview(
						`preferred: ${preferredSpawn.stderr || preferredSpawn.stdout || "unknown"} | fallback: ${fallbackSpawn.stderr || fallbackSpawn.stdout || "unknown"}`,
					);
					const nextRetryCount = retryCount + 1;
					spawnRetryCountByTask.set(task.id, nextRetryCount);
					task.agentRetryCount = nextRetryCount;
					deps.saveState();
					if (deps.lastCtx) deps.updateWidget(deps.lastCtx);
					return {
						content: [{
							type: "text",
							text: formatPreflightMessage(
								`Failed to spawn task #${task.id} (attempt ${nextRetryCount}/${AGENT_RETRY_BUDGET}).`,
								preflightChecks,
								[
									`Error: ${task.agentLastError}`,
									nextRetryCount >= AGENT_RETRY_BUDGET
										? "Retry budget exhausted. Use recover_agent or manual tmux fallback before attempting spawn again."
										: "Retry once after checking tmux health. If repeated, switch to recover_agent.",
								],
							),
						}],
						details: { taskId: task.id, retryCount: nextRetryCount, retryBudget: AGENT_RETRY_BUDGET, error: task.agentLastError },
					};
				}
				spawnResult = fallbackSpawn;
				spawnStrategy = "fallback-default";
			}

			const activeLockName = parseSpawnedLockName(spawnResult.stdout || "", requestedLockName);

			const depsStr = task.requiredTaskIds.length > 0
				? `Completed dependencies: ${task.requiredTaskIds
						.map((id) => {
							const dep = state.tasks.find((t) => t.id === id);
							return dep ? `#${id} ${dep.title}` : `#${id}`;
						})
						.join("; ")}. `
				: "";
			const filesHint = task.files.length > 0 ? ` Key files: ${task.files.slice(0, 5).join(", ")}.` : "";
			const contextHint = task.context ? ` Context: ${task.context}` : "";
			const snapshotItems = syncWorkerSnapshot(
				ctx.cwd,
				task.agentIdentity,
				`${task.title} ${task.context} ${task.files.join(" ")}`,
			);
			const snapshotHint = snapshotItems.length > 0
				? `\nMemory snapshot (project+dream-aware):\n${snapshotItems
						.slice(0, 6)
						.map((s) => `- ${s.text}${s.tags.length ? ` [${s.tags.slice(0, 3).join(",")}]` : ""}`)
						.join("\n")}`
				: "";

			const initialMessage =
				`You are a kanban agent spawned to work on task #${task.id}: \"${task.title}\".` +
				`${contextHint}${filesHint} ${depsStr}` +
				`A full task brief is at: ${briefFile}` +
				`${snapshotHint}` +
				` Work on the task and report clearly when done.`;

			const sendResult = await pi.exec("bash", [piTmuxScript, "send", activeLockName, initialMessage], { signal });
			if (sendResult.code !== 0) {
				task.agentLastError = shortPreview(sendResult.stderr || sendResult.stdout || "failed to send initial message");
			}

			task.spawnedAgentName = activeLockName;
			task.preferredAgentLockName = requestedLockName;
			task.agentRunStatus = "running";
			task.agentSpawnStrategy = spawnStrategy;
			task.status = "in-progress";
			task.owner = task.owner ?? activeLockName;
			task.agentLastOutput = shortPreview(spawnResult.stdout || "");
			task.agentRetryCount = 0;
			task.agentRetryBudget = AGENT_RETRY_BUDGET;
			spawnRetryCountByTask.delete(task.id);
			deps.saveState();
			if (deps.lastCtx) deps.updateWidget(deps.lastCtx);

			const contextAlertNote =
				params.context_alert_percent !== undefined
					? `\nContext alert lock: '${activeLockName}:context' (releases at ${params.context_alert_percent}% context usage)`
					: "";

			return {
				content: [
					{
						type: "text",
						text:
							`Spawned agent '${activeLockName}' for task #${task.id} \"${task.title}\" in ${agentCwd}.\n` +
							`Agent identity: ${task.agentIdentity}.\n` +
							(requestedLockName !== activeLockName
								? `Requested lock '${requestedLockName}' was remapped to '${activeLockName}' to avoid collision.\n`
								: "") +
							`Spawn strategy: ${spawnStrategy}.\n` +
							`Task brief: ${briefFile}\n\n` +
							`Agent startup output:\n${(spawnResult.stdout || "").trim()}\n\n` +
							`Next steps:\n` +
							`  tmux-capture('${activeLockName}')            – check current output\n` +
							`  tmux-send('${activeLockName}', '<message>')  – send a message\n` +
							`  semaphore_wait('${activeLockName}')           – wait until agent finishes` +
							contextAlertNote,
					},
				],
				details: {
					taskId: task.id,
					lockName: activeLockName,
					requestedLockName,
					agentIdentity: task.agentIdentity,
					spawnStrategy,
					briefFile,
					agentCwd,
					spawnOutput: spawnResult.stdout,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("kanban_spawn ")) + theme.fg("accent", `#${args.task_id}`);
			if (args.cwd) text += theme.fg("dim", `  in ${args.cwd}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const firstContent = result.content[0];
			const text = firstContent?.type === "text" ? firstContent.text : "";
			if (result.isError) return new Text(theme.fg("error", text), 0, 0);
			const details = result.details as any;
			if (details?.lockName) {
				const strategy = details.spawnStrategy ? ` ${details.spawnStrategy}` : "";
				return new Text(
					theme.fg("success", "⚡ ") + theme.fg("accent", details.lockName) + theme.fg("dim", `  task #${details.taskId}${strategy}`),
					0,
					0,
				);
			}
			return new Text(theme.fg("muted", text.slice(0, 120)), 0, 0);
		},
	});

	const registerKanbanAddTool = (toolName: "kanban_add") => {
		pi.registerTool({
			name: toolName,
			label: "Kanban Add",
			description:
				"Create a new kanban task. " +
				"Useful for autonomous planning when the agent needs to break work into follow-up tasks.",

			parameters: Type.Object({
				title: Type.String({ description: "Short task title" }),
				context: Type.Optional(Type.String({ description: "Optional context / notes" })),
				status: Type.Optional(StringEnum(["todo", "in-progress", "done"] as const)),
				owner: Type.Optional(Type.String({ description: "Optional owner" })),
				required_ids: Type.Optional(
					Type.Array(Type.Number(), { description: "Task IDs that must be done before this one starts" }),
				),
				files: Type.Optional(Type.Array(Type.String(), { description: "Optional associated files" })),
				set_active: Type.Optional(Type.Boolean({ description: "Whether to set the new task as active (default true)" })),
			}),

			async execute(_callId, params, _signal, _onUpdate, ctx) {
				const state = deps.state;
				const title = (params.title ?? "").trim();
				if (!title) {
					return { content: [{ type: "text", text: "title is required." }], details: {} };
				}

				const requiredIds = params.required_ids ?? [];
				const missing = requiredIds.filter((id) => !state.tasks.find((t) => t.id === id));
				if (missing.length > 0) {
					return {
						content: [{ type: "text", text: `Unknown required task IDs: ${missing.join(", ")}` }],
						details: { missing },
					};
				}

				const files = (params.files ?? []).map((f) => f.replace(/^@/, "").trim()).filter(Boolean);
				const task: Task = {
					id: state.nextId++,
					title,
					status: params.status ?? "todo",
					context: params.context ?? "",
					files,
					requiredTaskIds: requiredIds,
					owner: params.owner,
					createdAt: Date.now(),
				};

				if (task.status === "done") task.completedAt = Date.now();
				state.tasks.push(task);
				if (params.set_active !== false) state.activeTaskId = task.id;

				deps.saveState();
				deps.updateWidget(ctx);

				return {
					content: [{ type: "text", text: `Created task #${task.id}: \"${task.title}\" [${task.status}]` }],
					details: { task },
				};
			},

			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("muted", args.title);
				if (args.status) text += theme.fg("dim", `  [${args.status}]`);
				if (args.owner) text += theme.fg("accent", `  owner:${args.owner}`);
				return new Text(text, 0, 0);
			},

			renderResult(result, _options, theme) {
				const firstContent = result.content[0];
				const text = firstContent?.type === "text" ? firstContent.text : "";
				if (result.isError) return new Text(theme.fg("error", text), 0, 0);
				return new Text(theme.fg("success", text), 0, 0);
			},
		});
	};

	registerKanbanAddTool("kanban_add");

	pi.registerTool({
		name: "task_complete",
		label: "Task Complete",
		description:
			"Signal that your assigned task is complete. " +
			"This moves the active task to 'done' and provides a structured handover report for the orchestrator.",

		parameters: Type.Object({
			summary: Type.String({ description: "A concise summary of what was implemented or fixed" }),
			changed_files: Type.Array(Type.String(), { description: "List of files that were modified" }),
			test_result: Type.String({ description: "Output or status of the validation/test command run" }),
			confidence: Type.Number({ description: "Your confidence score (1-10) in the solution" }),
		}),

		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const state = deps.state;
			const task = state.tasks.find((t) => t.id === state.activeTaskId);
			if (!task) {
				return {
					content: [{ type: "text", text: "Error: No active task found to mark as complete." }],
					details: {},
				};
			}

			task.status = "done";
			task.completedAt = Date.now();
			task.agentRunStatus = task.agentRunStatus === "running" ? "completed" : task.agentRunStatus;

			const report =
				`\n\n### 🏁 Handover Report\n` +
				`- **Summary:** ${params.summary}\n` +
				`- **Confidence:** ${params.confidence}/10\n` +
				`- **Files:** ${params.changed_files.join(", ")}\n` +
				`- **Tests:** ${params.test_result}\n`;

			task.context = (task.context + report).trim();

			deps.saveState();
			deps.updateWidget(ctx);

			await ensureTaskSummary(pi, task, ctx, deps.boardRoot, {
				promptToListen: false,
				notify: true,
				saveState: deps.saveState,
				updateWidget: deps.updateWidget,
				source: report,
			});

			return {
				content: [{ type: "text", text: `Task #${task.id} marked as DONE. Handover report archived in task context.` }],
				details: { taskId: task.id, report },
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("success", theme.bold("task_complete ")) + theme.fg("muted", `confidence: ${args.confidence}/10`), 0, 0);
		},

		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "✓ Task Finished & Reported"), 0, 0);
		},
	});

	pi.registerTool({
		name: "prepare_worker_context",
		label: "Prepare Worker Context",
		description:
			"Define a restricted workspace scope for a sub-agent. " +
			"This 'pins' the task to specific files or directories to save context tokens and improve accuracy.",

		parameters: Type.Object({
			task_id: Type.Number({ description: "ID of the task to pin context for" }),
			pinned_files: Type.Array(Type.String(), { description: "List of file paths or globs (e.g. ['src/auth/*', 'tests/auth.test.ts'])" }),
		}),

		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const state = deps.state;
			const task = state.tasks.find((t) => t.id === params.task_id);
			if (!task) {
				return {
					content: [{ type: "text", text: `Task #${params.task_id} not found.` }],
					details: {},
				};
			}

			task.pinnedFiles = params.pinned_files;
			deps.saveState();
			deps.updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Workspace pinned for task #${task.id}: ${params.pinned_files.join(", ")}` }],
				details: { taskId: task.id, pinnedFiles: task.pinnedFiles },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("prepare_worker_context ")) +
					theme.fg("accent", `#${args.task_id} `) +
					theme.fg("dim", `[${args.pinned_files.length} items]`),
				0,
				0,
			);
		},

		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "✓ Workspace Pinned"), 0, 0);
		},
	});
}
