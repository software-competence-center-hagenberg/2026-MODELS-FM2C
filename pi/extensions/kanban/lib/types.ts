import type { Theme } from "@mariozechner/pi-coding-agent";

export type TaskStatus = "todo" | "in-progress" | "done";

export type AgentRunStatus = "running" | "completed" | "failed" | "stopped";

export interface Task {
	id: number;
	title: string;
	status: TaskStatus;
	/** Free-form context / notes */
	context: string;
	/** File paths associated with this task */
	files: string[];
	/** Specific files or directories this task is restricted to */
	pinnedFiles?: string[];
	/** IDs of tasks that must be "done" before this one can start */
	requiredTaskIds: number[];
	/** Human-readable owner for assignment/claiming workflows */
	owner?: string;
	/** Stable deterministic identity for this task's worker */
	agentIdentity?: string;
	/** Preferred deterministic lock name for this task's worker */
	preferredAgentLockName?: string;
	/** tmux lock name of the spawned pi agent, if any */
	spawnedAgentName?: string;
	/** Runtime status for the spawned agent lifecycle */
	agentRunStatus?: AgentRunStatus;
	/** How the agent was started (preferred model vs fallback/default mode) */
	agentSpawnStrategy?: "preferred" | "fallback-default";
	/** Last spawn/capture/kill error text (if any) */
	agentLastError?: string;
	/** Last captured output preview from the agent pane */
	agentLastOutput?: string;
	/** Number of consecutive spawn failures for this task */
	agentRetryCount?: number;
	/** Maximum spawn retries before preflight blocks further automatic attempts */
	agentRetryBudget?: number;
	/** Summary text file path for read-aloud reports */
	summaryFile?: string;
	/** Last generated summary text */
	summaryText?: string;
	/** Timestamp when marked done */
	completedAt?: number;
	createdAt: number;
}

export interface KanbanState {
	tasks: Task[];
	nextId: number;
	activeTaskId: number | null;
}

export const STATUS_ORDER: TaskStatus[] = ["todo", "in-progress", "done"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
	todo: "TODO",
	"in-progress": "IN PROGRESS",
	done: "DONE",
};

export const STATUS_ICONS: Record<TaskStatus, string> = {
	todo: "○",
	"in-progress": "●",
	done: "✓",
};

export const STATUS_COLORS: Record<TaskStatus, Parameters<Theme["fg"]>[0]> = {
	todo: "muted",
	"in-progress": "accent",
	done: "success",
};

export const STATUS_DIRS: Record<TaskStatus, string> = {
	todo: "todo",
	"in-progress": "inprogress",
	done: "done",
};

export const ARCHIVE_DIR = "old_done";
