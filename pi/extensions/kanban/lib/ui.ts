import { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Task, KanbanState, STATUS_ORDER, STATUS_LABELS } from "./types.js";
import { blockerIds } from "./store.js";

/** Pad an ANSI string to exactly `width` visible columns. */
export function padRight(s: string, width: number): string {
	const vw = visibleWidth(s);
	if (vw >= width) return truncateToWidth(s, width);
	return s + " ".repeat(width - vw);
}

export class KanbanBoardComponent {
	/** Shared mutable state – always reflects current data on render(). */
	private state: KanbanState;
	private theme: Theme;

	private selectedCol = 0;
	private selectedRow = 0;

	public onSetActive: (taskId: number) => void;
	public onMove: (taskId: number, dir: "forward" | "backward") => void;
	public onClose: () => void;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		state: KanbanState,
		theme: Theme,
		onSetActive: (taskId: number) => void,
		onMove: (taskId: number, dir: "forward" | "backward") => void,
		onClose: () => void,
	) {
		this.state = state;
		this.theme = theme;
		this.onSetActive = onSetActive;
		this.onMove = onMove;
		this.onClose = onClose;

		// Pre-select active task
		if (state.activeTaskId !== null) {
			for (let col = 0; col < STATUS_ORDER.length; col++) {
				const tasks = this.colTasks(col);
				const row = tasks.findIndex((t) => t.id === state.activeTaskId);
				if (row >= 0) {
					this.selectedCol = col;
					this.selectedRow = row;
					break;
				}
			}
		}
	}

	private colTasks(col: number): Task[] {
		return this.state.tasks.filter((t) => t.status === STATUS_ORDER[col]);
	}

	handleInput(data: string): void {
		const tasks = this.colTasks(this.selectedCol);

		if (matchesKey(data, Key.up)) {
			if (this.selectedRow > 0) {
				this.selectedRow--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down)) {
			if (this.selectedRow < tasks.length - 1) {
				this.selectedRow++;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.left)) {
			if (this.selectedCol > 0) {
				this.selectedCol--;
				const newTasks = this.colTasks(this.selectedCol);
				this.selectedRow = Math.min(this.selectedRow, Math.max(0, newTasks.length - 1));
				this.invalidate();
			}
		} else if (matchesKey(data, Key.right)) {
			if (this.selectedCol < STATUS_ORDER.length - 1) {
				this.selectedCol++;
				const newTasks = this.colTasks(this.selectedCol);
				this.selectedRow = Math.min(this.selectedRow, Math.max(0, newTasks.length - 1));
				this.invalidate();
			}
		} else if (matchesKey(data, Key.enter)) {
			const task = tasks[this.selectedRow];
			if (task) this.onSetActive(task.id);
		} else if (data === "m" || data === "M") {
			const task = tasks[this.selectedRow];
			if (task) {
				this.onMove(task.id, "forward");
				const remaining = this.colTasks(this.selectedCol);
				if (this.selectedRow >= remaining.length) this.selectedRow = Math.max(0, remaining.length - 1);
				this.invalidate();
			}
		} else if (data === "b" || data === "B") {
			const task = tasks[this.selectedRow];
			if (task) {
				this.onMove(task.id, "backward");
				const remaining = this.colTasks(this.selectedCol);
				if (this.selectedRow >= remaining.length) this.selectedRow = Math.max(0, remaining.length - 1);
				this.invalidate();
			}
		} else if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	private renderColumn(col: number, colWidth: number): string[] {
		const th = this.theme;
		const status = STATUS_ORDER[col];
		const tasks = this.colTasks(col);
		const isActiveCol = col === this.selectedCol;
		const lines: string[] = [];

		const label = ` ${STATUS_LABELS[status]} (${tasks.length}) `;
		const hColor = isActiveCol ? "accent" : "muted";
		lines.push(padRight(th.fg(hColor, th.bold(label)), colWidth));
		lines.push(padRight(th.fg(isActiveCol ? "borderAccent" : "border", "─".repeat(colWidth)), colWidth));

		if (tasks.length === 0) {
			lines.push(padRight(th.fg("dim", "  (empty)"), colWidth));
			return lines;
		}

		for (let row = 0; row < tasks.length; row++) {
			const task = tasks[row];
			const isSelected = isActiveCol && row === this.selectedRow;
			const isActive = task.id === this.state.activeTaskId;
			const blockers = blockerIds(task, this.state.tasks);
			const isBlocked = blockers.length > 0;

			const selPrefix = isSelected ? "> " : "  ";
			const activeMarker = isActive ? " *" : "";
			let titleLine: string;

			if (isSelected) {
				titleLine = th.fg("accent", th.bold(selPrefix + `#${task.id} `)) + th.fg("accent", task.title + activeMarker);
			} else if (isActive) {
				titleLine = th.fg("dim", selPrefix) + th.fg("text", `#${task.id} `) + th.fg("muted", task.title) + th.fg("warning", activeMarker);
			} else if (isBlocked) {
				titleLine = th.fg("dim", selPrefix + `#${task.id} `) + th.fg("dim", task.title);
			} else {
				titleLine = th.fg("dim", selPrefix + `#${task.id} `) + th.fg("muted", task.title);
			}
			lines.push(truncateToWidth(titleLine, colWidth));

			let secondaryLine: string;
			if (isBlocked) {
				const ids = blockers.map((id) => `#${id}`).join(", ");
				secondaryLine = th.fg("error", `    ⊘ blocked by ${ids}`);
			} else if (task.spawnedAgentName) {
				const status = task.agentRunStatus ? ` [${task.agentRunStatus}]` : "";
				secondaryLine = th.fg("accent", `    ⚡ ${task.spawnedAgentName}${status}`);
			} else if (task.owner) {
				secondaryLine = th.fg("accent", `    👤 ${task.owner}`);
			} else if (task.context) {
				const maxLen = colWidth - 4;
				const preview = task.context.length > maxLen ? task.context.slice(0, maxLen - 3) + "..." : task.context;
				secondaryLine = th.fg("dim", `    ${preview}`);
			} else {
				const fc = task.files.length;
				secondaryLine = th.fg("dim", `    ${fc} file${fc !== 1 ? "s" : ""}`);
			}
			lines.push(truncateToWidth(secondaryLine, colWidth));
			lines.push("");
		}

		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const lines: string[] = [];

		lines.push(padRight(th.fg("accent", th.bold("  Kanban Board  ")), width));
		lines.push(padRight(th.fg("borderAccent", "─".repeat(width)), width));

		const divCount = STATUS_ORDER.length - 1;
		const available = width - divCount;
		const colBase = Math.floor(available / STATUS_ORDER.length);
		const lastColW = available - colBase * (STATUS_ORDER.length - 1);
		const colWidths = STATUS_ORDER.map((_, i) => (i === STATUS_ORDER.length - 1 ? lastColW : colBase));

		const columns = STATUS_ORDER.map((_, col) => this.renderColumn(col, colWidths[col]));
		const maxRows = Math.max(...columns.map((c) => c.length));
		const divider = th.fg("border", "|");

		for (let i = 0; i < maxRows; i++) {
			const parts = columns.map((col, ci) => padRight(col[i] ?? "", colWidths[ci]));
			lines.push(parts.join(divider));
		}

		lines.push(padRight(th.fg("borderAccent", "─".repeat(width)), width));
		lines.push(truncateToWidth(th.fg("dim", " ↑↓ rows  ←→ columns  enter set-active  m forward  b backward  esc close"), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
