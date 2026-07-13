/**
 * Kanban Extension (Refactored)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// ─── Local Imports ──────────────────────────────────────────────────────────
import { Task, KanbanState, STATUS_ORDER, STATUS_ICONS, STATUS_COLORS, ARCHIVE_DIR } from "./lib/types.js";
import { 
    resolveBoardRoot, ensureBoardDirs, writeBoardMeta, loadBoardMeta, 
    loadTasksFromDisk, writeTaskToDisk, archiveTask, isTaskReady, blockerIds 
} from "./lib/store.js";
import { 
    extractTextFromMessage, normalizeTaskTitle, resolveAutoTaskTitles, 
    countWords, extractListItems, BIG_TASK_MIN_WORDS, BIG_TASK_MIN_CHARS 
} from "./lib/auto-task.js";
import { KanbanBoardComponent } from "./lib/ui.js";
import { ensureTaskSummary } from "./lib/summary.js";
import { registerKanbanTools, KanbanDependencies } from "./lib/tools.js";

export default function kanbanExtension(pi: ExtensionAPI) {
	let state: KanbanState = { tasks: [], nextId: 1, activeTaskId: null };
	let boardRoot = "";
	let lastCtx: ExtensionContext | null = null;
	let lastAssistantText = "";
	const lastAssistantByTaskId = new Map<number, string>();

	// ─── State Helpers ──────────────────────────────────────────────────────
	function saveState(): void {
		ensureBoardDirs(boardRoot);
		for (const task of state.tasks) {
			writeTaskToDisk(boardRoot, task);
		}
		writeBoardMeta(boardRoot, { activeTaskId: state.activeTaskId, nextId: state.nextId });
	}

	function reconstructState(ctx: ExtensionContext): void {
		lastCtx = ctx;
		boardRoot = resolveBoardRoot(ctx);
		const tasks = loadTasksFromDisk(boardRoot);
		const meta = loadBoardMeta(boardRoot);
		const maxId = tasks.reduce((acc, t) => Math.max(acc, t.id), 0);
		const nextId = Math.max(meta.nextId ?? 1, maxId + 1);
		const activeTaskId = tasks.find((t) => t.id === meta.activeTaskId) ? meta.activeTaskId ?? null : null;

		state.tasks = tasks;
		state.nextId = nextId;
		state.activeTaskId = activeTaskId;
	}

	function updateWidget(ctx: ExtensionContext): void {
		lastCtx = ctx;
		const active = state.tasks.find((t) => t.id === state.activeTaskId);
		if (!active) {
			ctx.ui.setWidget("kanban", undefined);
			return;
		}
		const th = ctx.ui.theme;
		const icon = STATUS_ICONS[active.status];
		const color = STATUS_COLORS[active.status];
		const fc = active.files.length;
		const filesNote = fc > 0 ? th.fg("dim", `  · ${fc} file${fc !== 1 ? "s" : ""}`) : "";
		const ownerNote = active.owner ? th.fg("accent", `  👤 ${active.owner}`) : "";
		const agentStatus = active.agentRunStatus ? ` [${active.agentRunStatus}]` : "";
		const agentNote = active.spawnedAgentName ? th.fg("accent", `  ⚡ ${active.spawnedAgentName}${agentStatus}`) : "";
		const blockers = blockerIds(active, state.tasks);
		const blockedNote =
			blockers.length > 0 ? th.fg("error", `  ⊘ blocked by ${blockers.map((id) => `#${id}`).join(", ")}`) : "";

		ctx.ui.setWidget("kanban", [
			th.fg(color, ` ${icon} `) +
				th.fg("text", `Task #${active.id}: `) +
				th.fg("muted", active.title) +
				th.fg("dim", `  [${active.status}]`) +
				ownerNote +
				filesNote +
				agentNote +
				blockedNote,
		]);
	}

    // ─── Tools & Dependencies ───────────────────────────────────────────────
    const deps: KanbanDependencies = {
        get state() { return state; },
        get boardRoot() { return boardRoot; },
        saveState,
        updateWidget,
        get lastCtx() { return lastCtx; },
        get lastAssistantText() { return lastAssistantText; },
        get lastAssistantByTaskId() { return lastAssistantByTaskId; }
    };
    registerKanbanTools(pi, deps);

	// ─── Lifecycle Events ───────────────────────────────────────────────────
	pi.on("session_start", async (_ev, ctx) => { reconstructState(ctx); updateWidget(ctx); });
	pi.on("session_switch", async (_ev, ctx) => { reconstructState(ctx); updateWidget(ctx); });
	pi.on("session_fork", async (_ev, ctx) => { reconstructState(ctx); updateWidget(ctx); });
	pi.on("session_tree", async (_ev, ctx) => { reconstructState(ctx); updateWidget(ctx); });

	pi.on("input", async (event, ctx) => {
		const text = event.text?.trim();
		if (!text || event.source === "extension" || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		
        // Auto-create logic
		const resolved = resolveAutoTaskTitles(text);
		if (!resolved) return { action: "continue" };

		const active = state.tasks.find((t) => t.id === state.activeTaskId);
		const activeInProgress = active && active.status !== "done";
		const isLargeRequest = countWords(text) >= BIG_TASK_MIN_WORDS || text.length >= BIG_TASK_MIN_CHARS || extractListItems(text).length >= 2;
		if (activeInProgress && !isLargeRequest) return { action: "continue" };

		const baseContext = resolved.titles.length > 1 ? `Auto-split from request:\n${text}` : text;
		const created: Task[] = [];
		for (const title of resolved.titles) {
			const task: Task = {
				id: state.nextId++,
				title: normalizeTaskTitle(title),
				status: "todo",
				context: normalizeTaskTitle(text) !== normalizeTaskTitle(title) ? baseContext : "",
				files: [],
				requiredTaskIds: [],
				createdAt: Date.now(),
			};
			state.tasks.push(task);
            created.push(task);
		}

		if (resolved.overflow?.length && created.length > 0) {
			const lastTask = created[created.length - 1];
			lastTask.context = `${lastTask.context || baseContext}\n\nAdditional items not auto-created:\n- ${resolved.overflow.join("\n- ")}`.trim();
		}

		if (!activeInProgress || active?.status === "done") {
			state.activeTaskId = created[0]?.id ?? state.activeTaskId;
		}

		saveState();
		updateWidget(ctx);

		if (ctx.hasUI && created.length > 0) {
			const ids = created.map((t) => `#${t.id}`).join(", ");
			ctx.ui.notify(created.length === 1 ? `Auto-created task ${ids}: "${created[0].title}".` : `Auto-created ${created.length} tasks (${ids}) from the latest request.`, "info");
		}
		return { action: "continue" };
	});

	pi.on("message_end", async (event, _ctx) => {
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;
		const text = extractTextFromMessage(msg);
		if (!text) return;
		lastAssistantText = text;
		if (state.activeTaskId !== null) lastAssistantByTaskId.set(state.activeTaskId, text);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (state.activeTaskId === null) return;
		const task = state.tasks.find((t) => t.id === state.activeTaskId);
		if (!task) return;

		let filePath: string | undefined;
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
            filePath = event.input.path;
        }

		if (filePath?.startsWith("@")) filePath = filePath.slice(1);
		if (filePath && !task.files.includes(filePath)) {
			task.files.push(filePath);
			saveState();
			updateWidget(ctx);
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const active = state.tasks.find((t) => t.id === state.activeTaskId);
		if (!active) return;

		const blockers = blockerIds(active, state.tasks);
		const blockerNote = blockers.length > 0 ? `\n⚠ BLOCKED by: ${blockers.map((id) => `#${id}`).join(", ")}` : "";
		const depsSection = active.requiredTaskIds.length > 0 ? `\nDependencies: ${active.requiredTaskIds.map((id) => {
            const dep = state.tasks.find((t) => t.id === id);
            return dep ? `#${id} [${dep.status}] ${dep.title}` : `#${id}`;
        }).join("; ")}` : "";
		const filesSection = active.files.length > 0 ? `\nRelated files:\n${active.files.map((f) => `  - ${f}`).join("\n")}` : "";
		const contextSection = active.context ? `\nContext / Notes: ${active.context}` : "";
		const agentSection = active.spawnedAgentName ? `\nSpawned agent: ${active.spawnedAgentName}` : "";
		const retrySection =
			typeof active.agentRetryCount === "number"
				? `\nSpawn retry budget: ${active.agentRetryCount}/${active.agentRetryBudget ?? 3}`
				: "";

		const injection = `\n\n---\nActive Kanban Task: #${active.id} – ${active.title}\nStatus: ${active.status}${blockerNote}${depsSection}${contextSection}${agentSection}${retrySection}${filesSection}\n---`;
		return { systemPrompt: event.systemPrompt + injection };
	});

	// ─── Commands ───────────────────────────────────────────────────────────
	pi.registerCommand("newtask", {
		description: 'Create a new kanban task: /newtask <title>',
		handler: async (args, ctx) => {
			const title = args?.trim().replace(/^["'`]|["'`]$/g, "").trim();
			if (!title) { ctx.ui.notify('Usage: /newtask <title>', "error"); return; }
			const task: Task = { id: state.nextId++, title, status: "todo", context: "", files: [], requiredTaskIds: [], createdAt: Date.now() };
			state.tasks.push(task);
			state.activeTaskId = task.id;
			saveState();
			updateWidget(ctx);
			ctx.ui.notify(`Created task #${task.id}: "${title}" (now active)`, "success");
		},
	});

	pi.registerCommand("board", {
		description: "Open the interactive kanban board",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("/board requires interactive mode", "error"); return; }
			reconstructState(ctx);
			if (state.tasks.length === 0) { ctx.ui.notify('No tasks yet.', "info"); return; }

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const board = new KanbanBoardComponent(state, theme,
					(taskId) => {
						state.activeTaskId = taskId;
						saveState();
						updateWidget(ctx);
						done();
					},
					(taskId, dir) => {
						const task = state.tasks.find((t) => t.id === taskId);
						if (!task) return;
						const cur = STATUS_ORDER.indexOf(task.status);
						const next = dir === "forward" ? Math.min(cur + 1, STATUS_ORDER.length - 1) : Math.max(cur - 1, 0);
						if (next !== cur) {
							const previousStatus = task.status;
							task.status = STATUS_ORDER[next];
							saveState();
							updateWidget(ctx);
							if (task.status === "done" && previousStatus !== "done") {
								void ensureTaskSummary(pi, task, ctx, boardRoot, { saveState, updateWidget });
							}
						}
					},
					() => done(),
				);
				return { render: (w: number) => board.render(w), invalidate: () => board.invalidate(), handleInput: (data: string) => { board.handleInput(data); tui.requestRender(); } };
			});
		},
	});

	pi.registerCommand("task", {
		description: "Set the active task: /task <id>",
		handler: async (args, ctx) => {
			const id = parseInt(args?.trim() ?? "", 10);
			if (isNaN(id)) {
				reconstructState(ctx);
				const lines = state.tasks.map((t) => `  #${id} [${t.status}] ${t.title}${t.id === state.activeTaskId ? " <-- active" : ""}`);
				ctx.ui.notify("Kanban tasks:\n" + lines.join("\n"), "info");
				return;
			}
			const task = state.tasks.find((t) => t.id === id);
			if (!task) { ctx.ui.notify(`Task #${id} not found.`, "error"); return; }
			state.activeTaskId = id;
			saveState();
			updateWidget(ctx);
			ctx.ui.notify(`Task #${id} active.`, "success");
		},
	});

	pi.registerCommand("clear_board", {
		description: "Archive all tasks",
		handler: async (_args, ctx) => {
			for (const task of state.tasks) archiveTask(boardRoot, { ...task, status: "done", completedAt: task.completedAt ?? Date.now() });
			state.tasks = []; state.nextId = 1; state.activeTaskId = null;
			writeBoardMeta(boardRoot, { activeTaskId: null, nextId: 1 });
			updateWidget(ctx);
			ctx.ui.notify("Board cleared.", "success");
		},
	});
}
