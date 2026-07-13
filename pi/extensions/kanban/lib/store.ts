import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Task, TaskStatus, STATUS_DIRS, ARCHIVE_DIR, STATUS_ORDER } from "./types.js";

/** Pad an ANSI string to exactly `width` visible columns. */
// (Visible width and truncate are usually UI concerns, but used in some logic here. 
//  Keeping them in store.ts if they are needed by non-UI logic, 
//  otherwise move to ui.ts)

/** True when all required tasks are done. */
export function isTaskReady(task: Task, allTasks: Task[]): boolean {
	return task.requiredTaskIds.every((depId) => {
		const dep = allTasks.find((t) => t.id === depId);
		return dep?.status === "done";
	});
}

/** IDs of unmet (not-done) required tasks. */
export function blockerIds(task: Task, allTasks: Task[]): number[] {
	return task.requiredTaskIds.filter((depId) => {
		const dep = allTasks.find((t) => t.id === depId);
		return !dep || dep.status !== "done";
	});
}

export function resolveBoardRoot(ctx: ExtensionContext): string {
	const marker = join(ctx.cwd, ".kanban");
	if (existsSync(marker)) {
		try {
			const stat = statSync(marker);
			if (stat.isDirectory()) return marker;
		} catch {
			// ignore and treat as file marker
		}
		return ctx.cwd;
	}
	return join(homedir(), ".pi", "kanban");
}

export function ensureBoardDirs(boardRoot: string): void {
	mkdirSync(boardRoot, { recursive: true });
	for (const dir of [...Object.values(STATUS_DIRS), ARCHIVE_DIR]) {
		mkdirSync(join(boardRoot, dir), { recursive: true });
	}
}

export function statusDir(status: TaskStatus): string {
	return STATUS_DIRS[status];
}

export function summaryFilePath(boardRoot: string, taskId: number, status: TaskStatus): string {
	return join(boardRoot, statusDir(status), `${taskId}-summary.txt`);
}

export function findTaskFiles(boardRoot: string, taskId: number): { taskFile?: string; summaryFile?: string; dir?: string } {
	for (const dir of [...Object.values(STATUS_DIRS), ARCHIVE_DIR]) {
		const taskFile = join(boardRoot, dir, `${taskId}.json`);
		const summaryFile = join(boardRoot, dir, `${taskId}-summary.txt`);
		if (existsSync(taskFile) || existsSync(summaryFile)) {
			return { taskFile: existsSync(taskFile) ? taskFile : undefined, summaryFile: existsSync(summaryFile) ? summaryFile : undefined, dir };
		}
	}
	return {};
}

export function writeSummaryFile(boardRoot: string, task: Task, summaryText: string): string {
	ensureBoardDirs(boardRoot);
	const summaryFile = summaryFilePath(boardRoot, task.id, task.status);
	writeFileSync(summaryFile, summaryText, { encoding: "utf-8", mode: 0o600 });
	return summaryFile;
}

/**
 * Find the pi-tmux bash script that ships with the pi-tmux package.
 */
export function findPiTmuxScript(): string | null {
	const gitBase = join(homedir(), ".pi", "agent", "git");
	const walk = (dir: string): string | null => {
		try {
			for (const entry of readdirSync(dir)) {
				const candidate = join(dir, entry, "bin", "pi-tmux");
				if (existsSync(candidate)) return resolve(dir, entry, "bin", "pi-tmux");
				const sub = join(dir, entry);
				if (statSync(sub).isDirectory()) {
					const found = walk(sub);
					if (found) return found;
				}
			}
		} catch { /* skip */ }
		return null;
	};
	return walk(gitBase);
}

export function boardMetaPath(boardRoot: string): string {
	return join(boardRoot, "board.json");
}

export function loadBoardMeta(boardRoot: string): { activeTaskId?: number | null; nextId?: number } {
	const metaFile = boardMetaPath(boardRoot);
	if (!existsSync(metaFile)) return {};
	try {
		const raw = readFileSync(metaFile, "utf-8");
		return JSON.parse(raw) as { activeTaskId?: number | null; nextId?: number };
	} catch {
		return {};
	}
}

export function writeBoardMeta(boardRoot: string, data: { activeTaskId: number | null; nextId: number }): void {
	ensureBoardDirs(boardRoot);
	writeFileSync(boardMetaPath(boardRoot), JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function loadTasksFromDisk(boardRoot: string): Task[] {
	ensureBoardDirs(boardRoot);
	const tasks: Task[] = [];
	for (const [status, dirName] of Object.entries(STATUS_DIRS)) {
		const dir = join(boardRoot, dirName);
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const file = join(dir, entry);
			try {
				const raw = readFileSync(file, "utf-8");
				const parsed = JSON.parse(raw) as Task;
				const task: Task = {
					...parsed,
					status: status as TaskStatus,
					files: [...(parsed.files ?? [])],
					pinnedFiles: parsed.pinnedFiles ? [...parsed.pinnedFiles] : undefined,
					requiredTaskIds: [...(parsed.requiredTaskIds ?? [])],
					context: parsed.context ?? "",
					createdAt: parsed.createdAt ?? Date.now(),
				};
				const summaryFile = summaryFilePath(boardRoot, task.id, task.status);
				if (existsSync(summaryFile)) {
					task.summaryFile = summaryFile;
					try {
						task.summaryText = readFileSync(summaryFile, "utf-8").trim();
					} catch { /* ignore */ }
				}
				tasks.push(task);
			} catch { /* skip */ }
		}
	}
	return tasks;
}

function moveFileIfExists(source: string | undefined, target: string): void {
	if (!source || source === target || !existsSync(source)) return;
	try {
		renameSync(source, target);
	} catch {
		try {
			const data = readFileSync(source);
			writeFileSync(target, data, { mode: 0o600 });
			unlinkSync(source);
		} catch { /* ignore */ }
	}
}

export function writeTaskToDisk(boardRoot: string, task: Task, overrideDir?: string): void {
	ensureBoardDirs(boardRoot);
	const dirName = overrideDir ?? statusDir(task.status);
	const dir = join(boardRoot, dirName);
	const targetTaskFile = join(dir, `${task.id}.json`);
	const targetSummaryFile = join(dir, `${task.id}-summary.txt`);

	const existing = findTaskFiles(boardRoot, task.id);
	if (existing.taskFile && existing.taskFile !== targetTaskFile) {
		moveFileIfExists(existing.taskFile, targetTaskFile);
	}
	if (existing.summaryFile && existing.summaryFile !== targetSummaryFile) {
		moveFileIfExists(existing.summaryFile, targetSummaryFile);
	}

	writeFileSync(targetTaskFile, JSON.stringify(task, null, 2), { encoding: "utf-8", mode: 0o600 });
	if (task.summaryText) {
		writeFileSync(targetSummaryFile, task.summaryText, { encoding: "utf-8", mode: 0o600 });
		task.summaryFile = targetSummaryFile;
	} else if (existsSync(targetSummaryFile)) {
		task.summaryFile = targetSummaryFile;
	}
}

/** Move a task to the archive folder so it no longer appears on the active board. */
export function archiveTask(boardRoot: string, task: Task): void {
	const archived: Task = {
		...task,
		status: "done",
		completedAt: task.completedAt ?? Date.now(),
	};
	writeTaskToDisk(boardRoot, archived, ARCHIVE_DIR);
}

/** Build the markdown task brief sent to a spawned agent. */
export function buildTaskBrief(task: Task, allTasks: Task[]): string {
	const lines: string[] = [`# Kanban Task #${task.id}: ${task.title}`, ""];

	if (task.context) {
		lines.push("## Context / Notes", "", task.context, "");
	}

	if (task.requiredTaskIds.length > 0) {
		lines.push("## Dependencies (all completed)", "");
		for (const depId of task.requiredTaskIds) {
			const dep = allTasks.find((t) => t.id === depId);
			if (dep) lines.push(`- #${dep.id} [${dep.status}] ${dep.title}`);
		}
		lines.push("");
	}

	if (task.files.length > 0) {
		lines.push("## Related Files", "");
		for (const f of task.files) lines.push(`- ${f}`);
		lines.push("");
	}

	if (task.pinnedFiles && task.pinnedFiles.length > 0) {
		lines.push("## 📌 Workspace Pinning (RESTRICTED SCOPE)", "");
		lines.push("Your work is restricted to the following files/directories:");
		for (const p of task.pinnedFiles) lines.push(`- ${p}`);
		lines.push("");
		lines.push("You MUST NOT read or edit files outside this scope unless absolutely necessary for dependency analysis.");
		lines.push("");
	}

	lines.push(
		"## Your Instructions",
		"",
		"Work on this task. Use your available tools to investigate, implement, and verify.",
		"When complete, summarise clearly what was done in your final message.",
	);

	return lines.join("\n");
}
