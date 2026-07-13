import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const TOOL_NAME = "vim_edit";

const VimCommandSchema = Type.Object({
  keys: Type.String({ description: "A single Vim normal-mode command, e.g. 'dw', '2w', 'd$', 'c2w', 'rX', 'gg', 'G'." }),
  text: Type.Optional(Type.String({ description: "Replacement text for 'c' (change) commands." })),
});

const VimEditParams = Type.Object({
  path: Type.String({ description: "Path to the target file (absolute or relative)." }),
  commands: Type.Array(VimCommandSchema, { minItems: 1, description: "Commands executed in order." }),
  line: Type.Optional(Type.Number({ minimum: 1, description: "1-based starting line. Defaults to 1." })),
  column: Type.Optional(Type.Number({ minimum: 1, description: "1-based starting column. Defaults to 1." })),
});

type VimCommand = { keys: string; text?: string };

type MotionToken = "h" | "j" | "k" | "l" | "w" | "b" | "e" | "$" | "^" | "0" | "G" | "gg";
type TextObjScope = "inner" | "around";

type BufferState = {
  text: string;
  cursor: number;
};

export default function vimEditExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Vim Edit",
    description: "Apply precise file edits using Vim-like motions and operators.",
    promptSnippet: "Use Vim-style commands for precise line/word edits when edit/write replacements would be awkward.",
    promptGuidelines: [
      "Use this tool for precise cursor-relative edits with Vim motions/operators.",
      "For large structural rewrites, still prefer edit/write.",
      "For change commands (c...), provide replacement text in the command item's text field.",
    ],
    parameters: VimEditParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const inputPath = stripAtPrefix(params.path);
        const absPath = path.resolve(ctx.cwd, inputPath);
        const original = await readFile(absPath, "utf8");

        const state: BufferState = {
          text: original,
          cursor: lineColToOffset(original, params.line ?? 1, params.column ?? 1),
        };

        const logs: string[] = [];

        for (const cmd of params.commands as VimCommand[]) {
          applyCommand(state, cmd);
          const pos = offsetToLineCol(state.text, state.cursor);
          logs.push(`${cmd.keys} -> ${pos.line}:${pos.column}`);
        }

        if (state.text !== original) {
          await writeFile(absPath, state.text, "utf8");
        }

        const finalPos = offsetToLineCol(state.text, state.cursor);
        return {
          content: [
            {
              type: "text",
              text:
                `Applied ${params.commands.length} Vim command(s) to ${params.path}.\n` +
                `Final cursor: ${finalPos.line}:${finalPos.column}\n` +
                logs.map((l) => `- ${l}`).join("\n"),
            },
          ],
          details: {
            path: params.path,
            changed: state.text !== original,
            commandCount: params.commands.length,
            finalLine: finalPos.line,
            finalColumn: finalPos.column,
          },
        };
      } catch (err) {
        const message = (err as Error).message;
        return {
          isError: true,
          content: [{ type: "text", text: `vim_edit error: ${message}` }],
          details: { error: message },
        };
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("vim_edit "))}${theme.fg("muted", args.path)} ${theme.fg("dim", `(${Array.isArray(args.commands) ? args.commands.length : 0} cmd)`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      if ((result.details as any)?.error) {
        return new Text(theme.fg("error", `vim_edit error: ${(result.details as any).error}`), 0, 0);
      }
      return new Text(theme.fg("success", "✓ vim_edit applied"), 0, 0);
    },
  });
}

function applyCommand(state: BufferState, cmd: VimCommand): void {
  const keys = cmd.keys;
  if (!keys || !keys.trim()) {
    throw new Error("Command keys must be non-empty");
  }

  let index = 0;
  const [count1, i1] = parseCount(keys, index, false);
  const prefixCount = count1 ?? 1;
  index = i1;

  const op = keys[index];
  if (!op) throw new Error(`Incomplete command: ${keys}`);

  if (op === "d" || op === "c") {
    index += 1;
    const [count2, i2] = parseCount(keys, index, true);
    index = i2;
    const effectiveCount = prefixCount * (count2 ?? 1);

    const textObj = parseTextObject(keys, index);
    if (textObj) {
      index += textObj.length;
      if (index !== keys.length) throw new Error(`Unsupported trailing keys in '${keys}'`);
      applyOperatorTextObject(state, op, textObj.scope, textObj.objType, effectiveCount, cmd.text);
      return;
    }

    const motion = parseMotion(keys, index);
    if (!motion) throw new Error(`Expected motion or text-object after ${op} in '${keys}'`);
    index += motion.length;
    if (index !== keys.length) throw new Error(`Unsupported trailing keys in '${keys}'`);

    applyOperator(state, op, motion.token, effectiveCount, cmd.text);
    return;
  }

  if (op === "r") {
    index += 1;
    const ch = keys[index];
    if (!ch) throw new Error(`Expected replacement character in '${keys}'`);
    index += 1;
    if (index !== keys.length) throw new Error(`Unsupported trailing keys in '${keys}'`);
    applyReplace(state, ch, prefixCount);
    return;
  }

  const motion = parseMotion(keys, index);
  if (!motion) throw new Error(`Unsupported command '${keys}'`);
  index += motion.length;
  if (index !== keys.length) throw new Error(`Unsupported trailing keys in '${keys}'`);
  state.cursor = moveByMotion(state.text, state.cursor, motion.token, prefixCount);
}

function applyOperator(
  state: BufferState,
  op: "d" | "c",
  motion: MotionToken,
  count: number,
  replacementText?: string,
): void {
  const from = state.cursor;
  const to = moveByMotion(state.text, state.cursor, motion, count);
  let start = Math.min(from, to);
  let end = Math.max(from, to);

  const linewise = motion === "j" || motion === "k" || motion === "G" || motion === "gg";

  if (linewise) {
    ({ start, end } = linewiseRange(state.text, from, to));
  } else if (isInclusiveMotion(motion) && from <= to) {
    end = nextOffset(state.text, end);
  }

  if (op === "c") {
    if (replacementText === undefined) {
      throw new Error(`Change command '${op}${motion}' requires command.text`);
    }
    state.text = state.text.slice(0, start) + replacementText + state.text.slice(end);
    state.cursor = Math.min(start + replacementText.length, state.text.length);
    return;
  }

  state.text = state.text.slice(0, start) + state.text.slice(end);
  state.cursor = Math.min(start, state.text.length);
}

function applyReplace(state: BufferState, ch: string, count: number): void {
  if (state.cursor >= state.text.length) return;
  let text = state.text;
  let pos = state.cursor;
  for (let i = 0; i < count && pos < text.length; i++) {
    const end = nextOffset(text, pos);
    text = text.slice(0, pos) + ch + text.slice(end);
    pos += ch.length;
  }
  state.text = text;
  state.cursor = Math.max(0, pos - ch.length);
}

function moveByMotion(text: string, start: number, motion: MotionToken, count: number): number {
  let cursor = clamp(start, 0, text.length);

  if (motion === "G") {
    if (count > 1) return lineColToOffset(text, count, 1);
    return lineStartOffset(text, getLineCount(text));
  }

  if (motion === "gg") {
    if (count > 1) return lineColToOffset(text, count, 1);
    return 0;
  }

  for (let i = 0; i < count; i++) {
    const next = moveSingle(text, cursor, motion);
    if (next === cursor) break;
    cursor = next;
  }

  return cursor;
}

function moveSingle(text: string, cursor: number, motion: Exclude<MotionToken, "G" | "gg">): number {
  switch (motion) {
    case "h":
      return prevOffset(text, cursor);
    case "l":
      return nextOffset(text, cursor);
    case "j":
      return moveVertical(text, cursor, 1);
    case "k":
      return moveVertical(text, cursor, -1);
    case "w":
      return nextWordStart(text, cursor);
    case "b":
      return prevWordStart(text, cursor);
    case "e":
      return endOfWord(text, cursor);
    case "$":
      return lineEndOffset(text, lineOfOffset(text, cursor));
    case "^": {
      const line = lineOfOffset(text, cursor);
      return firstNonBlank(text, line);
    }
    case "0":
      return lineStartOffset(text, lineOfOffset(text, cursor) + 1);
  }
}

function parseMotion(input: string, index: number): { token: MotionToken; length: number } | null {
  if (input.slice(index, index + 2) === "gg") return { token: "gg", length: 2 };
  const ch = input[index] as MotionToken | undefined;
  if (!ch) return null;
  if (["h", "j", "k", "l", "w", "b", "e", "$", "^", "0", "G"].includes(ch)) {
    return { token: ch, length: 1 };
  }
  return null;
}

function parseTextObject(
  input: string,
  index: number,
): { scope: TextObjScope; objType: string; length: number } | null {
  const scopeKey = input[index];
  const objType = input[index + 1];
  if (!scopeKey || !objType) return null;

  const scope = scopeKey === "i" ? "inner" : scopeKey === "a" ? "around" : null;
  if (!scope) return null;

  const validObjTypes = new Set(["w", "W", '"', "'", "`", "(", ")", "b", "[", "]", "{", "}", "B", "<", ">"]);
  if (!validObjTypes.has(objType)) return null;

  return { scope, objType, length: 2 };
}

function parseCount(input: string, index: number, allowZeroPrefix: boolean): [number | null, number] {
  let i = index;
  let digits = "";
  while (i < input.length && /[0-9]/.test(input[i] ?? "")) {
    digits += input[i];
    i += 1;
  }
  if (!digits) return [null, index];
  if (!allowZeroPrefix && digits.startsWith("0")) return [null, index];
  return [Math.max(1, parseInt(digits, 10)), i];
}

function linewiseRange(text: string, from: number, to: number): { start: number; end: number } {
  const fromLine = lineOfOffset(text, from) + 1;
  const toLine = lineOfOffset(text, to) + 1;
  const startLine = Math.min(fromLine, toLine);
  const endLine = Math.max(fromLine, toLine);

  let start = lineStartOffset(text, startLine);
  let end = lineEndOffsetWithNewline(text, endLine);

  if (end === text.length && start > 0 && text[start - 1] === "\n") {
    start -= 1;
  }

  return { start, end };
}

function isInclusiveMotion(motion: MotionToken): boolean {
  return motion === "e" || motion === "$";
}

function lineOfOffset(text: string, offset: number): number {
  const off = clamp(offset, 0, text.length);
  let line = 0;
  for (let i = 0; i < off; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function lineStartOffset(text: string, line1: number): number {
  const target = Math.max(1, line1);
  if (target === 1) return 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
      if (line === target) return i + 1;
    }
  }
  return text.length;
}

function lineEndOffset(text: string, zeroBasedLine: number): number {
  const start = lineStartOffset(text, zeroBasedLine + 1);
  const nl = text.indexOf("\n", start);
  if (nl === -1) return text.length;
  return nl > start ? nl - 1 : start;
}

function lineEndOffsetWithNewline(text: string, line1: number): number {
  const start = lineStartOffset(text, line1);
  const nl = text.indexOf("\n", start);
  if (nl === -1) return text.length;
  return nl + 1;
}

function firstNonBlank(text: string, zeroBasedLine: number): number {
  const start = lineStartOffset(text, zeroBasedLine + 1);
  const endExclusive = lineEndOffsetWithNewline(text, zeroBasedLine + 1);
  for (let i = start; i < endExclusive; i++) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t" && ch !== "\n") return i;
  }
  return start;
}

function getLineCount(text: string): number {
  if (text.length === 0) return 1;
  let lines = 1;
  for (const ch of text) if (ch === "\n") lines += 1;
  return lines;
}

function moveVertical(text: string, cursor: number, delta: 1 | -1): number {
  const currentLine = lineOfOffset(text, cursor) + 1;
  const col = offsetToLineCol(text, cursor).column;
  const targetLine = clamp(currentLine + delta, 1, getLineCount(text));
  return lineColToOffset(text, targetLine, col);
}

function nextWordStart(text: string, cursor: number): number {
  let i = clamp(cursor, 0, text.length);
  if (i >= text.length) return i;

  const cls = charClass(text[i]);
  while (i < text.length && charClass(text[i]) === cls) i = nextOffset(text, i);
  while (i < text.length && charClass(text[i]) === "space") i = nextOffset(text, i);
  return i;
}

function prevWordStart(text: string, cursor: number): number {
  let i = prevOffset(text, clamp(cursor, 0, text.length));
  while (i > 0 && charClass(text[i]) === "space") i = prevOffset(text, i);
  const cls = charClass(text[i]);
  while (i > 0 && charClass(text[prevOffset(text, i)]) === cls) i = prevOffset(text, i);
  return i;
}

function endOfWord(text: string, cursor: number): number {
  let i = clamp(cursor, 0, text.length);
  if (i >= text.length) return Math.max(0, text.length - 1);

  while (i < text.length && charClass(text[i]) === "space") i = nextOffset(text, i);
  if (i >= text.length) return Math.max(0, text.length - 1);

  const cls = charClass(text[i]);
  let last = i;
  while (i < text.length && charClass(text[i]) === cls) {
    last = i;
    i = nextOffset(text, i);
  }
  return last;
}

type TextObjectRange = { start: number; end: number } | null;

function applyOperatorTextObject(
  state: BufferState,
  op: "d" | "c",
  scope: TextObjScope,
  objType: string,
  count: number,
  replacementText?: string,
): void {
  const first = findTextObject(state.text, state.cursor, objType, scope === "inner");
  if (!first) return;

  let start = first.start;
  let end = first.end;
  let probe = end;

  for (let i = 1; i < count; i++) {
    const next = findTextObject(state.text, probe, objType, scope === "inner");
    if (!next || (next.start === start && next.end === end)) break;
    end = next.end;
    probe = next.end;
  }

  if (op === "c") {
    if (replacementText === undefined) {
      throw new Error(`Change command requires command.text (e.g. ciw + text)`);
    }
    state.text = state.text.slice(0, start) + replacementText + state.text.slice(end);
    state.cursor = Math.min(start + replacementText.length, state.text.length);
    return;
  }

  state.text = state.text.slice(0, start) + state.text.slice(end);
  state.cursor = Math.min(start, state.text.length);
}

function findTextObject(text: string, offset: number, objectType: string, isInner: boolean): TextObjectRange {
  if (objectType === "w") return findWordObject(text, offset, isInner, (ch) => /[A-Za-z0-9_]/.test(ch));
  if (objectType === "W") return findWordObject(text, offset, isInner, (ch) => !/\s/.test(ch));

  const pairs: Record<string, [string, string]> = {
    "(": ["(", ")"],
    ")": ["(", ")"],
    b: ["(", ")"],
    "[": ["[", "]"],
    "]": ["[", "]"],
    "{": ["{", "}"],
    "}": ["{", "}"],
    B: ["{", "}"],
    "<": ["<", ">"],
    ">": ["<", ">"],
    '"': ['"', '"'],
    "'": ["'", "'"],
    "`": ["`", "`"],
  };

  const pair = pairs[objectType];
  if (!pair) return null;

  const [open, close] = pair;
  if (open === close) return findQuoteObject(text, offset, open, isInner);
  return findBracketObject(text, offset, open, close, isInner);
}

function findWordObject(
  text: string,
  offset: number,
  isInner: boolean,
  isWordChar: (ch: string) => boolean,
): TextObjectRange {
  if (text.length === 0) return null;
  let i = clamp(offset, 0, Math.max(0, text.length - 1));

  const isWs = (idx: number) => /\s/.test(text[idx] ?? "");
  const isWord = (idx: number) => isWordChar(text[idx] ?? "");
  const isPunct = (idx: number) => {
    const ch = text[idx] ?? "";
    return !!ch && !isWs(idx) && !isWord(idx);
  };

  let start = i;
  let end = i + 1;

  if (isWord(i)) {
    while (start > 0 && isWord(start - 1)) start--;
    while (end < text.length && isWord(end)) end++;
  } else if (isWs(i)) {
    while (start > 0 && isWs(start - 1)) start--;
    while (end < text.length && isWs(end)) end++;
    return { start, end };
  } else if (isPunct(i)) {
    while (start > 0 && isPunct(start - 1)) start--;
    while (end < text.length && isPunct(end)) end++;
  }

  if (!isInner) {
    if (end < text.length && isWs(end)) {
      while (end < text.length && isWs(end)) end++;
    } else if (start > 0 && isWs(start - 1)) {
      while (start > 0 && isWs(start - 1)) start--;
    }
  }

  return { start, end };
}

function findQuoteObject(text: string, offset: number, quote: string, isInner: boolean): TextObjectRange {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const effectiveEnd = lineEnd === -1 ? text.length : lineEnd;
  const line = text.slice(lineStart, effectiveEnd);
  const posInLine = offset - lineStart;

  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) positions.push(i);
  }

  for (let i = 0; i < positions.length - 1; i += 2) {
    const s = positions[i]!;
    const e = positions[i + 1]!;
    if (s <= posInLine && posInLine <= e) {
      return isInner ? { start: lineStart + s + 1, end: lineStart + e } : { start: lineStart + s, end: lineStart + e + 1 };
    }
  }

  return null;
}

function findBracketObject(text: string, offset: number, open: string, close: string, isInner: boolean): TextObjectRange {
  let depth = 0;
  let start = -1;

  for (let i = offset; i >= 0; i--) {
    if (text[i] === close && i !== offset) depth++;
    else if (text[i] === open) {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  let end = -1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    }
  }
  if (end === -1) return null;

  return isInner ? { start: start + 1, end } : { start, end: end + 1 };
}

function charClass(ch: string | undefined): "space" | "word" | "punct" {
  if (!ch || /\s/.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

function prevOffset(_text: string, offset: number): number {
  return Math.max(0, offset - 1);
}

function nextOffset(text: string, offset: number): number {
  return Math.min(text.length, offset + 1);
}

function lineColToOffset(text: string, line1: number, col1: number): number {
  const start = lineStartOffset(text, line1);
  const endExclusive = lineEndOffsetWithNewline(text, line1);
  const width = Math.max(0, endExclusive - start - (text[endExclusive - 1] === "\n" ? 1 : 0));
  const col = clamp(col1, 1, width + 1);
  return start + (col - 1);
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  const off = clamp(offset, 0, text.length);
  let line = 1;
  let start = 0;
  for (let i = 0; i < off; i++) {
    if (text[i] === "\n") {
      line += 1;
      start = i + 1;
    }
  }
  return { line, column: off - start + 1 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stripAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}
