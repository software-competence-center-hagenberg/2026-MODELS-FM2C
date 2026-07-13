import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Task } from "./types.js";
import { buildSpeakableSummary } from "./auto-task.js";
import { writeSummaryFile } from "./store.js";

export async function ensureTaskSummary(
    pi: ExtensionAPI,
	task: Task,
	ctx: ExtensionContext,
    boardRoot: string,
	options: { 
        promptToListen?: boolean; 
        notify?: boolean;
        saveState: () => void;
        updateWidget: (ctx: ExtensionContext) => void;
        source?: string;
    } = { saveState: () => {}, updateWidget: () => {} },
): Promise<void> {
	const summaryText = buildSpeakableSummary(task, options.source ?? "");
	const summaryFile = writeSummaryFile(boardRoot, task, summaryText);
	task.summaryFile = summaryFile;
	task.summaryText = summaryText;
	task.completedAt = task.completedAt ?? Date.now();
	
    options.saveState();
	options.updateWidget(ctx);

	if (options.notify !== false) {
		ctx.ui.notify(`Saved task summary to ${summaryFile}`, "success");
	}

	const promptToListen = options.promptToListen ?? ctx.hasUI;
	if (promptToListen && ctx.hasUI) {
		const listen = await ctx.ui.confirm("Task summary", "Listen to a spoken summary now?");
		if (listen) {
			pi.events.emit("voice:speak", { text: summaryText, file: summaryFile, source: "kanban" });
		}
	}
}
