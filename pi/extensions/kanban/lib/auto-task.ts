import { Task } from "./types.js";

const AUTO_TASK_MIN_WORDS = 20;
const AUTO_TASK_MIN_CHARS = 120;
const BIG_TASK_MIN_WORDS = 60;
const BIG_TASK_MIN_CHARS = 280;
const MAX_AUTO_TASKS = 5;
const MIN_SPLIT_ITEM_WORDS = 4;
const MAX_TITLE_LENGTH = 120;

export function extractTextFromMessage(message?: { content?: Array<{ type: string; text?: string }> }): string {
	if (!message?.content) return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join(" ")
		.trim();
}

export function sanitizeForSpeech(text: string): string {
	let cleaned = text.replace(/```[\s\S]*?```/g, " ");
	cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
	cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
	cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	cleaned = cleaned.replace(/^\s*#+\s+/gm, "");
	cleaned = cleaned.replace(/^\s*>\s?/gm, "");
	cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, "");
	cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, "");
	cleaned = cleaned.replace(/^\s*\|.*\|\s*$/gm, "");
	cleaned = cleaned.replace(/^\s*-{3,}\s*$/gm, "");
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	return cleaned;
}

export function buildSpeakableSummary(task: Task, sourceText: string, maxLength = 1200): string {
	const intro = `Task ${task.id} "${task.title}" is complete.`;
	const cleaned = sanitizeForSpeech(sourceText);
	const fallback = task.files.length > 0
		? `Files touched include ${task.files.join(", ")}.`
		: "The work is done.";
	let summary = [intro, cleaned || fallback].filter(Boolean).join(" ").trim();
	if (summary.length > maxLength) {
		summary = summary.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
	}
	return summary;
}

export function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).filter(Boolean).length;
}

export function normalizeTaskTitle(text: string): string {
	const cleaned = text
		.replace(/^[-*+\d.\)]\s+/, "")
		.replace(/^\[\s*\]\s+/, "")
		.replace(/^"|"$/g, "")
		.replace(/^'|'$/g, "")
		.replace(/^`|`$/g, "")
		.trim();
	if (!cleaned) return "(untitled task)";
	if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;
	return cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
}

export function extractListItems(text: string): string[] {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const items = lines
		.map((line) => {
			const match = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
			if (match) return match[1].trim();
			const checkbox = line.match(/^\[\s*\]\s+(.*)$/);
			if (checkbox) return checkbox[1].trim();
			return "";
		})
		.filter(Boolean);
	return items.length >= 2 ? items : [];
}

export function splitIntoSentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+|;\s+/)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
}

export function splitOnConjunctions(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/\b(?:and|then|also|plus)\b/gi)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
}

export function shouldAutoCreateTask(text: string): boolean {
	const words = countWords(text);
	if (words >= AUTO_TASK_MIN_WORDS) return true;
	if (text.length >= AUTO_TASK_MIN_CHARS) return true;
	return extractListItems(text).length >= 2;
}

export function splitLargeTask(text: string): string[] {
	const listItems = extractListItems(text);
	if (listItems.length >= 2) return listItems;

	const words = countWords(text);
	const isBig = words >= BIG_TASK_MIN_WORDS || text.length >= BIG_TASK_MIN_CHARS;
	if (!isBig) return [text];

	const sentences = splitIntoSentences(text);
	if (sentences.length >= 2) return sentences;

	const conj = splitOnConjunctions(text);
	if (conj.length >= 2) return conj;

	return [text];
}

export function clampAutoTasks(titles: string[]): { titles: string[]; overflow?: string[] } {
	if (titles.length <= MAX_AUTO_TASKS) return { titles };
	return { titles: titles.slice(0, MAX_AUTO_TASKS), overflow: titles.slice(MAX_AUTO_TASKS) };
}

export function resolveAutoTaskTitles(text: string): { titles: string[]; overflow?: string[] } | null {
	if (!shouldAutoCreateTask(text)) return null;
	const split = splitLargeTask(text).map(normalizeTaskTitle).filter((title) => countWords(title) >= MIN_SPLIT_ITEM_WORDS);
	const titles = split.length > 0 ? split : [normalizeTaskTitle(text)];
	return clampAutoTasks(titles);
}
