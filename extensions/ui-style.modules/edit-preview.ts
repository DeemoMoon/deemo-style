/**
 * edit 工具的“执行中 diff 预览”。
 *
 * 这一层只做两件事：
 *   1. 把工具参数归一成 PreviewInput；
 *   2. 用与 pi edit 工具一致的匹配语义（精确 → fuzzy、唯一命中、不重叠）
 *      在内存里试算，然后生成 unified diff。
 *
 * 独立成模块的原因：这些算法与 pi 的 edit-diff 语义强绑定，应该能单独
 * 测“和 pi 同语义”，而不是只能通过 TUI 行为测试间接验证。
 */

import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	BAD_RED,
	fg24,
	HOME,
	MUTED,
	OK_GREEN,
	RESET_FG,
	stripBom,
} from "./core.ts";

/** 执行中 diff 预览读取文件的大小上限（异步读，但超大文件也没必要为预览重塑）。 */
export const MAX_EDIT_PREVIEW_BYTES = 1_000_000;

/** diff 预览的输入：路径 + 编辑列表（单编辑形式归一成数组）。 */
export interface PreviewInput {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

export function getPreviewInput(args: unknown): PreviewInput | undefined {
	const record = args as
		| {
				path?: unknown;
				file_path?: unknown;
				oldText?: unknown;
				newText?: unknown;
				edits?: unknown;
		  }
		| undefined;
	if (!record || typeof record !== "object") return undefined;
	const path =
		typeof record.file_path === "string"
			? record.file_path
			: typeof record.path === "string"
				? record.path
				: undefined;
	if (!path) return undefined;

	if (
		Array.isArray(record.edits) &&
		record.edits.length > 0 &&
		record.edits.every(
			(edit) =>
				typeof (edit as { oldText?: unknown })?.oldText === "string" &&
				typeof (edit as { newText?: unknown })?.newText === "string",
		)
	) {
		return { path, edits: record.edits as PreviewInput["edits"] };
	}
	if (typeof record.oldText === "string" && typeof record.newText === "string") {
		return { path, edits: [{ oldText: record.oldText, newText: record.newText }] };
	}
	return undefined;
}

// ---- edit 预览的匹配语义（与 pi edit 工具对齐） ----------------------------
//
// pi 的 edit 工具（core/tools/edit-diff.ts）不是「顺序就地替换」：
//   1. 所有 oldText 都对**同一份原始内容**匹配，命中后再按偏移倒序应用；
//   2. 精确匹配失败时做 fuzzy 归一（NFKC、行尾空白、智能引号/破折号/特殊空格）；
//   3. 每处必须唯一命中，且彼此不重叠。
// 预览必须用同一套规则，否则会出现「预览说找不到、真实却成功了」这类误导。
// 差别只有一处：预览不需要把归一化结果回写到原始字节，所以省掉了
// widenReplacementsToLines 那一步。

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface PreviewReplacement {
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** 统计 needle 在 text 里出现的次数（不分配 split 的大数组）。 */
function countOccurrences(text: string, needle: string): number {
	if (needle === "") return text.length + 1;
	let count = 0;
	let index = 0;
	while (true) {
		const found = text.indexOf(needle, index);
		if (found === -1) return count;
		count += 1;
		index = found + needle.length;
	}
}

/**
 * 在内存里应用编辑（与 pi edit 工具同语义，仅用于执行中预览）。
 * 返回用于 diff 的基准内容与结果内容（fuzzy 命中时基准是归一化后的文本）。
 */
export function applyPreviewEdits(
	content: string,
	edits: PreviewInput["edits"],
): { base: string; content: string } | { error: string } {
	const normalized = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	for (let i = 0; i < normalized.length; i++) {
		if (!normalized[i]!.oldText) return { error: `预览失败：edits[${i}].oldText 为空` };
	}

	// 与 pi 一致：只要有一处需要 fuzzy，整体就在归一化空间里算。
	const useFuzzy = normalized.some((edit) => !content.includes(edit.oldText));
	const base = useFuzzy ? normalizeForFuzzyMatch(content) : content;

	const matched: PreviewReplacement[] = [];
	for (let i = 0; i < normalized.length; i++) {
		const edit = normalized[i]!;
		// base 已经是归一化空间时，oldText 也只归一化一次；不再为每个 edit
		// 重新 normalize 整个 base（旧实现是 O(edits × 文件大小)）。
		const needle = useFuzzy ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText;
		const index = base.indexOf(needle);
		if (index === -1) return { error: `预览失败：edits[${i}] 未找到要替换的文本` };
		if (countOccurrences(base, needle) > 1) {
			return { error: `预览失败：edits[${i}] 匹配不唯一` };
		}
		matched.push({
			matchIndex: index,
			matchLength: needle.length,
			newText: edit.newText,
		});
	}

	matched.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matched.length; i++) {
		const previous = matched[i - 1]!;
		const current = matched[i]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			return { error: "预览失败：编辑区域重叠" };
		}
	}

	let result = base;
	for (let i = matched.length - 1; i >= 0; i--) {
		const replacement = matched[i]!;
		result =
			result.slice(0, replacement.matchIndex) +
			replacement.newText +
			result.slice(replacement.matchIndex + replacement.matchLength);
	}
	if (result === base) return { error: "预览失败：替换后内容无变化" };
	return { base, content: result };
}

/** 给统一 diff 的单行上色：+ 绿、- 红、@@ 暗灰、其余原样。 */
export function colorizeDiffLine(line: string): string {
	if (line.startsWith("+")) return fg24(OK_GREEN, line);
	if (line.startsWith("-")) return fg24(BAD_RED, line);
	if (line.startsWith("@@")) return `${MUTED}${line}${RESET_FG}`;
	return line;
}
/** 把 edit 的路径参数变成绝对路径（与 pi 一致：相对 cwd，支持 `~`）。 */
export function resolvePreviewPath(path: string, cwd: string): string {
	if (path === "~") return HOME;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(HOME, path.slice(2));
	return resolve(cwd, path);
}

/**
 * 执行中的 diff 预览（异步）。
 *
 * pi 自己的 edit 渲染器就是这么做的：`computeEditsDiff(...).then(
 * () => context.invalidate())`。同步 readFileSync 会把整个 TUI 卡住一帧
 * （网络盘/冷缓存时更明显）。
 */
export async function computeEditPreview(
	input: PreviewInput,
	cwd: string,
): Promise<{ diff?: string } | { error: string }> {
	const absolutePath = resolvePreviewPath(input.path, cwd);
	try {
		const info = await statAsync(absolutePath);
		// 超大文件放弃预览：结果区的 details.diff 仍是权威来源。
		if (info.size > MAX_EDIT_PREVIEW_BYTES) return {};
		const raw = await readFileAsync(absolutePath, "utf8");
		const applied = applyPreviewEdits(normalizeToLF(stripBom(raw)), input.edits);
		if ("error" in applied) return { error: applied.error };
		const diff = generateDiffString(applied.base, applied.content).diff;
		return diff ? { diff } : {};
	} catch (error) {
		return { error: `预览失败：${error instanceof Error ? error.message : String(error)}` };
	}
}
