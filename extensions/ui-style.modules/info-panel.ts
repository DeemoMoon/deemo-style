/**
 * 十四、会话信息面板（`alt+i` / `/info`）
 *
 * 一个带边框、自动居中的 overlay：
 *   - 上半部分是**可直接改**的三项：会话名、模型、思考强度；
 *   - 下半部分是只读汇总：上下文占用、输入/输出/总 token、缓存命中率、费用、
 *     累计用时、会话时长、消息规模、目录、会话 id。
 *
 * 为什么用 overlay 而不是再加一行状态栏：状态栏每帧都要重算/重绘，只能放最常
 * 看的几个数；这些"偶尔想确认/顺便改一下"的东西更适合按需弹出。overlay 独占
 * 键盘、关掉就消失，不占常驻空间。
 *
 * 数据口径：
 *   - token / 费用 / 缓存 / 用时 → `computeSessionStats(getBranch())`（与状态栏同一份实现）；
 *   - 上下文占用 → `contextUsageCached(ctx)`（与信息条/状态栏共用缓存）；
 *   - 模型/思考 → `ctx.model` / `pi.getThinkingLevel()`；
 *   - 打开时取一次快照，按 `r` 重新取（不做常驻刷新，避免与 pi 的帧循环打架）。
 *
 * 重绘纪律（避免闪烁）：
 *   - 面板宽高在打开时就定下来，内容变化只重排、不改盒子尺寸；
 *   - 操作结果画在底边框里（不新增内容行），高度不会跳；
 *   - 切换模型是异步的，期间**一帧都不重绘**（以前先画个 "…" 占位，
 *     底边框会闪一下），等 setModel 回来一次性更新。
 *
 * 编辑都是官方 setter，不碰任何配置文件：
 *   - 名称 → `pi.setSessionName()`
 *   - 模型 → `pi.setModel()`（返回 false 表示该 provider 没配凭据）
 *   - 思考 → `pi.setThinkingLevel()`（内部会 clamp 到模型支持的档位）
 * 因此改动**只对本次会话有效**，不会改 settings.json。
 */

import {
	fuzzyFilter,
	SelectList,
	truncateToWidth,
	visibleWidth,
	isKeyRelease,
	matchesKey,
	type Component,
	type SelectItem,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	BAD_RED,
	BOLD_OFF,
	BOLD_ON,
	contextUsageCached,
	DIM_GRAY,
	fg24,
	formatCwd,
	formatDuration,
	formatTokens,
	MUTED,
	OK_GREEN,
	RESET_FG,
	SKY_BLUE,
	WARN_YELLOW,
} from "./core.ts";
import { hitRateRgb, levelRgb, renderContextBar } from "./context-bar.ts";
import { supportedThinkingLevels, THINKING_COLORS } from "./levels.ts";
import { computeSessionStats, type SessionStats } from "./session-stats.ts";

/** pi 的 usage.cost 单位是美元；与状态栏同一汇率。 */
const USD_TO_CNY = 7.2;

/** 弹窗宽度策略：内容宽度 = 最长一行，夹在 [MIN_INNER, max] 之间。 */
const MIN_INNER = 54; // 至少放得下底部提示（见 HINT_IDLE）
const MAX_INNER = 74;
/** 边框 + 左右各一列内边距。 */
const FRAME_EXTRA = 4;
/** 终端太窄时留出的余量（避免贴边）。 */
const TERMINAL_MARGIN = 4;

/** 标签列宽：两个全角字（4 列）+ 2 列间隔。 */
const LABEL_WIDTH = 6;
/** 同一行多格之间的间隔。 */
const CELL_GAP = 3;
/** 上下文色条最多格数。 */
const BAR_CELLS_MAX = 26;
/** 可见内容行数下限。 */
const MIN_VIEWPORT = 5;
/** 下拉列表最多同时显示多少项（超过就滚动）。 */
const DROPDOWN_MAX_VISIBLE = 8;
/** 下拉框内部左右各留一列。 */
const DROPDOWN_PAD = 2;
/** 模型/思考行右侧的点击箭头。 */
const ARROW_LEFT = "\u2039";
const ARROW_RIGHT = "\u203A";
const ARROW_ZONE = `${ARROW_LEFT} ${ARROW_RIGHT}`;
/** 下拉列表布局：模型 id 列窄一点，把宽度让给 provider/窗口说明。 */
const DROPDOWN_LAYOUT = { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 24 };
/** 双击改名后的反显（SGR 7 / 27）。 */
const SELECT_ALL_ON = "\x1b[7m";
const SELECT_ALL_OFF = "\x1b[27m";

/** 可编辑的三项（Tab / ↑↓ 切换焦点）。 */
export type EditableField = "name" | "model" | "thinking";

const FIELDS: EditableField[] = ["name", "model", "thinking"];

const BORDER = `${DIM_GRAY}`;
const BAR_FILLED = "\u2588";
const BAR_EMPTY = "\u2591";
const FOCUS_MARK = "\u25B8";
/** 内容行统一左缩进一列（与焦点标记 ▸ 同宽，焦点切换时文字不跳）。 */
const IND = " ";

// ---- 纯函数（可单测） ------------------------------------------------------

/** 千分位精确 token 数。 */
export function exactTokens(count: number): string {
	return Math.round(count).toLocaleString("en-US");
}

/** `3.2k (3,200)`。 */
export function tokenCell(count: number): string {
	return `${formatTokens(count)} (${exactTokens(count)})`;
}

/** 弹窗里用到的模型最小形状（避免依赖 pi-ai 的 Model 类型）。 */
export interface ModelLike {
	id: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, unknown> | null;
}

/** 模型的稳定标识（provider/id），用于比较"是不是同一个模型"。 */
export function modelKey(model: ModelLike | undefined): string {
	return model ? `${model.provider}/${model.id}` : "";
}

/** 模型显示名：`id (provider)`，过宽时由调用方截断。 */
export function modelLabel(model: ModelLike | undefined): string {
	if (!model) return "no-model";
	return `${model.id} (${model.provider})`;
}

/** 点击列 → 光标下标（宽字符按 visibleWidth 累加）。 */
export function cursorAtColumn(chars: string[], column: number): number {
	if (column <= 0) return 0;
	let width = 0;
	for (let i = 0; i < chars.length; i++) {
		const charWidth = visibleWidth(chars[i]!);
		if (width + charWidth / 2 >= column) return i;
		width += charWidth;
	}
	return chars.length;
}

/** 按可见宽度补空格（行尾对齐用）。 */
function padTo(line: string, width: number): string {
	const current = visibleWidth(line);
	if (current >= width) return truncateToWidth(line, width, "");
	return line + " ".repeat(width - current);
}

/** 居中：左侧补一半余量（右侧由 padTo 补满）。 */
function centerIn(line: string, width: number): string {
	const current = visibleWidth(line);
	if (current >= width) return truncateToWidth(line, width, "");
	const left = Math.floor((width - current) / 2);
	return " ".repeat(left) + line;
}

/** 一行里的值可以带 ANSI；`hint` 是不参与着色的灰色说明（如 “← → 切换”）。 */
export interface Cell {
	label: string;
	value: string;
	hint?: string;
}

/** 内容行：文本 + 该行对应的可编辑字段（有则说明是可改的行）。 */
export interface ContentRow {
	text: string;
	field?: EditableField;
	/** 该行"自然宽度"（比如上下文行尾部是拉伸的色条，不能用来量宽度）。 */
	minWidth?: number;
	/** `‹ ›` 箭头在该行里的起始列（0 基，未着色文本计算，供鼠标命中用）。 */
	arrowsCol?: number;
	/** 值在该行里的起始列（改名时把点击位置换算成光标位置）。 */
	valueCol?: number;
	/** 这一行属于内联下拉（用于算下拉区间 / 鼠标转发）。 */
	dropdown?: boolean;
}

/** 打开面板时从 ctx 抓的一份快照。 */
export interface SessionInfoView {
	model: ModelLike | undefined;
	thought: string;
	sessionName: string;
	cwd: string;
	sessionId: string;
	contextTokens: number | undefined;
	contextWindow: number;
	contextPercent: number | undefined;
	stats: SessionStats;
	entryCount: number;
	streaming: boolean;
	/** 可切换的模型列表（scoped 优先）。 */
	models: ModelLike[];
	/** 模型下标 / 思考档位下标（编辑用）。 */
	modelIndex: number;
	levelIndex: number;
}

export function collectSessionInfoView(
	ctx: ExtensionContext,
	thinking: string,
	now = Date.now(),
): SessionInfoView {
	const model = ctx.model as unknown as ModelLike | undefined;
	const usage = contextUsageCached(ctx);
	const branch = ctx.sessionManager.getBranch() as unknown as Parameters<
		typeof computeSessionStats
	>[0];

	const scoped = (ctx.scopedModels ?? []).map((entry) => entry.model as unknown as ModelLike);
	const available = (ctx.modelRegistry?.getAvailable?.() ?? []) as unknown as ModelLike[];
	const seen = new Set<string>();
	const models: ModelLike[] = [];
	for (const candidate of [...scoped, ...available]) {
		if (!candidate) continue;
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		models.push(candidate);
	}
	const currentKey = model ? `${model.provider}/${model.id}` : "";
	const modelIndex = Math.max(
		0,
		models.findIndex((entry) => `${entry.provider}/${entry.id}` === currentKey),
	);

	const levels = supportedThinkingLevels(model);
	const levelIndex = Math.max(0, levels.indexOf(thinking));

	return {
		model,
		thought: thinking,
		sessionName: ctx.sessionManager.getSessionName() ?? "",
		cwd: ctx.sessionManager.getCwd() || ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : undefined,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		contextPercent: typeof usage?.percent === "number" ? usage.percent : undefined,
		stats: computeSessionStats(branch, now),
		entryCount: branch.length,
		streaming: !ctx.isIdle(),
		models,
		modelIndex,
		levelIndex,
	};
}

/** 单元格 → 文本（标签补到 LABEL_WIDTH）。 */
function cellText(cell: Cell): string {
	const pad = " ".repeat(Math.max(2, LABEL_WIDTH - visibleWidth(cell.label)));
	const hint = cell.hint ? `${MUTED}${cell.hint}${RESET_FG}` : "";
	return `${MUTED}${cell.label}${RESET_FG}${pad}${cell.value}${hint}`;
}

/** 多格并排：先按等宽分，最后一格吃掉余量。 */
function cellsLine(cells: Cell[], width: number): string {
	if (cells.length === 1) return truncateToWidth(IND + cellText(cells[0]!), width, "");
	const share = Math.floor((width - CELL_GAP * (cells.length - 1)) / cells.length);
	const parts: string[] = [];
	let used = 0;
	for (let i = 0; i < cells.length; i++) {
		const budget = i === cells.length - 1 ? Math.max(0, width - used) : Math.max(0, share);
		const text = truncateToWidth(cellText(cells[i]!), budget, "…");
		parts.push(text);
		used += visibleWidth(text) + CELL_GAP;
	}
	return truncateToWidth(IND + parts.join(" ".repeat(CELL_GAP)), width, "");
}

/** 可编辑行：焦点行前面加 ▸，标签与值都用强调色。 */
function fieldRow(
	cell: Cell,
	field: EditableField,
	focus: EditableField | undefined,
	editing: boolean,
	draft: string,
	cursor: number,
	theme: Theme,
	width: number,
	arrows: boolean,
	selectAll = false,
): { text: string; arrowsCol?: number; valueCol?: number; minWidth?: number } {
	const focused = focus === field;
	const pad = " ".repeat(Math.max(2, LABEL_WIDTH - visibleWidth(cell.label)));
	const mark = focused ? `${SKY_BLUE}${FOCUS_MARK}${RESET_FG}` : " ";
	const label = focused ? `${SKY_BLUE}${cell.label}${RESET_FG}` : `${MUTED}${cell.label}${RESET_FG}`;

	let value = cell.value;
	const hint = cell.hint ? `${MUTED}${cell.hint}${RESET_FG}` : "";
	if (editing) {
		// 文本编辑：光标用一条细竖线表示（不闪烁，避免额外定时器）
		const chars = Array.from(draft);
		if (selectAll && chars.length > 0) {
			// 全选态：反显整段（下一次输入就整体替换）
			value = `${SELECT_ALL_ON}${theme.fg("text", chars.join(""))}${SELECT_ALL_OFF}${SKY_BLUE}▏${RESET_FG}`;
		} else {
			const before = chars.slice(0, cursor).join("");
			const after = chars.slice(cursor).join("");
			value = `${theme.fg("text", before)}${SKY_BLUE}▏${RESET_FG}${theme.fg("text", after)}`;
		}
	} else if (focused) {
		value = `${SKY_BLUE}${stripForRecolor(cell.value)}${RESET_FG}`;
	}

	// 右侧箭头区（鼠标可点；键盘 ←→ 等价）
	const arrowText = arrows ? (focused ? `${SKY_BLUE}${ARROW_ZONE}${RESET_FG}` : `${MUTED}${ARROW_ZONE}${RESET_FG}`) : "";
	const arrowWidth = visibleWidth(ARROW_ZONE);
	// 值先给 hint / 箭头让位：那些是固定短语，值可以被截断
	const fixed =
		visibleWidth(mark) + visibleWidth(label) + pad.length + visibleWidth(hint) +
		(arrows ? arrowWidth + 1 : 0);
	const valueCol = visibleWidth(mark) + visibleWidth(label) + pad.length;
	const valueText = truncateToWidth(value, Math.max(4, width - fixed), "…");

	const left = `${mark}${label}${pad}${valueText}${hint}`;
	if (!arrows) return { text: truncateToWidth(left, width, "…"), valueCol };

	// 箭头右对齐；但"自然宽度"只算到箭头为止（否则整行会被撑满、弹窗跟着变宽）
	const natural = visibleWidth(left) + arrowWidth + 1;
	const gap = Math.max(1, width - visibleWidth(left) - arrowWidth);
	const text = truncateToWidth(`${left}${" ".repeat(gap)}${arrowText}`, width, "…");
	const arrowsCol = Math.max(0, visibleWidth(left) + gap);
	return { text, arrowsCol, valueCol, minWidth: natural };
}

/** 去掉 ANSI 序列（底边框是单行纯文本）。 */
function stripAnsiText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** 把已经着色的值还原成纯文本（焦点行统一换成强调色，避免两种颜色打架）。 */
function stripForRecolor(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

export interface BuildOptions {
	focus?: EditableField;
	editing?: boolean;
	/** 双击改名后的"全选"状态：渲染成反显，第一次输入即整体替换 */
	selectAll?: boolean;
	draft?: string;
	cursor?: number;
	message?: string;
	/** 内联下拉：插在指定字段行之后（行文本已由 SelectList 渲染好）。 */
	dropdown?: { after: EditableField; lines: string[] };
	/** 量宽度时假装"总是有箭头"，避免切换模型后面板变窄。 */
	forceArrows?: boolean;
}

/** 组装面板内容行（不含边框）。 */
export function buildSessionInfoRows(
	view: SessionInfoView,
	theme: Theme,
	width: number,
	options: BuildOptions = {},
): ContentRow[] {
	const stats = view.stats;
	const inner = Math.max(16, width);
	const plain = (value: string) => theme.fg("text", value);
	const focused = options.focus;

	const percentText =
		view.contextPercent === undefined ? "?" : `${view.contextPercent.toFixed(1)}%`;
	const usedText = view.contextTokens === undefined ? "?" : formatTokens(view.contextTokens);
	const windowText = view.contextWindow > 0 ? formatTokens(view.contextWindow) : "?";

	// 上下文行：文字在左，色条右对齐。
	const ctxLeft = `${FG_LABEL}上下文${RESET_FG}  ${fg24(levelRgb(view.contextPercent), percentText)}${RESET_FG}${plain(
		`  ${usedText} / ${windowText}`,
	)}`;
	const barBudget = inner - visibleWidth(ctxLeft) - 2;
	const barCells = Math.min(BAR_CELLS_MAX, Math.max(0, Math.floor(barBudget)));
	const ctxLine =
		barCells >= 6
			? `${padTo(ctxLeft, inner - barCells)}${renderContextBar(view.contextPercent, barCells, "block")}`
			: truncateToWidth(ctxLeft, inner, "…");

	// token 行：窄了就只给缩写，不留半截括号。
	const tokenBudget = Math.floor((inner - CELL_GAP * 2) / 3) - LABEL_WIDTH;
	const tokenValue = (count: number) => {
		const detailed = tokenCell(count);
		return plain(visibleWidth(detailed) <= tokenBudget ? detailed : formatTokens(count));
	};

	const rate = stats.hasCache ? stats.cacheHitRate : undefined;
	const cacheValue =
		rate === undefined
			? `${MUTED}--${RESET_FG}`
			: `${fg24(hitRateRgb(rate), `${rate.toFixed(1)}%`)}${RESET_FG}${plain(
					`  读 ${formatTokens(stats.cacheReadTokens)} · 写 ${formatTokens(stats.cacheWriteTokens)}`,
				)}`;

	const costDetailed = `￥${(stats.cost * USD_TO_CNY).toFixed(2)}  ($${stats.cost.toFixed(4)})`;
	const costShort = `￥${(stats.cost * USD_TO_CNY).toFixed(2)}`;
	const costBudget = Math.floor((inner - CELL_GAP) / 2) - LABEL_WIDTH;
	const costValue = plain(
		visibleWidth(costDetailed) <= costBudget ? costDetailed : costShort,
	);

	const thinkingColor = THINKING_COLORS[view.thought];
	const thoughtValue = thinkingColor
		? `${fg24(thinkingColor, view.thought)}${RESET_FG}`
		: plain(view.thought);
	const levelCount = supportedThinkingLevels(view.model).length;

	// 当前模型可能不在可切换列表里（例如没配凭据），此时显示真实模型而不是列表首项
	const listed = view.models[view.modelIndex];
	const current = view.model;
	const sameAsListed =
		listed && current && listed.provider === current.provider && listed.id === current.id;
	const model = current && !sameAsListed ? current : (listed ?? current);
	const modelValue = plain(modelLabel(model));
	const nameValue = view.sessionName ? plain(view.sessionName) : `${MUTED}未命名${RESET_FG}`;

	const rows: ContentRow[] = [];

	// ---- 概览（可改） ----
	// 可编辑行统一用 fieldRow：右侧带 ‹ › 点击箭头（键盘 ←→ 等价）
	const pushField = (
		row: { text: string; arrowsCol?: number; valueCol?: number },
		field: EditableField,
	) => {
		rows.push({ ...row, field });
		if (options.dropdown?.after === field) {
			for (const line of options.dropdown.lines) rows.push({ text: line, dropdown: true });
		}
	};

	rows.push({ text: `${IND}${DIM_GRAY}概览${RESET_FG}` });
	pushField(
		fieldRow(
			{ label: "模型", value: modelValue },
			"model",
			focused,
			false,
			"",
			0,
			theme,
			inner,
			options.forceArrows === true || view.models.length > 1,
		),
		"model",
	);
	pushField(
		fieldRow(
			{ label: "思考", value: thoughtValue },
			"thinking",
			focused,
			false,
			"",
			0,
			theme,
			inner,
			options.forceArrows === true || levelCount > 1,
		),
		"thinking",
	);
	pushField(
		fieldRow(
			{ label: "会话", value: nameValue },
			"name",
			focused,
			options.editing === true && focused === "name",
			options.draft ?? view.sessionName,
			options.cursor ?? 0,
			theme,
			inner,
			false,
			options.selectAll === true,
		),
		"name",
	);
	rows.push({
		text: cellsLine(
			[
				{
					label: "状态",
					value: view.streaming
						? `${fg24(OK_GREEN, "● 生成中")}${RESET_FG}`
						: `${MUTED}○ 空闲${RESET_FG}`,
				},
				{ label: "分支", value: plain(`${view.entryCount} 条目`) },
			],
			inner,
		),
	});
	rows.push({ text: "" });

	// ---- 用量 ----
	rows.push({ text: `${IND}${DIM_GRAY}用量${RESET_FG}` });
	rows.push({ text: ctxLine, minWidth: visibleWidth(ctxLeft) + 10 });
	rows.push({
		text: cellsLine(
			[
				{ label: "输入", value: tokenValue(stats.inputTokens) },
				{ label: "输出", value: tokenValue(stats.outputTokens) },
				{ label: "总计", value: tokenValue(stats.totalTokens) },
			],
			inner,
		),
	});
	rows.push({ text: cellsLine([{ label: "缓存", value: cacheValue }], inner) });
	rows.push({
		text: cellsLine(
			[
				{ label: "费用", value: costValue },
				{
					label: "消息",
					value: plain(`${stats.messageCount} 条 · ${stats.turnCount} 轮`),
				},
			],
			inner,
		),
	});
	rows.push({ text: "" });

	// ---- 时间与位置 ----
	rows.push({ text: `${IND}${DIM_GRAY}时间与位置${RESET_FG}` });
	rows.push({
		text: cellsLine(
			[
				{ label: "用时", value: plain(formatDuration(stats.activeMs)) },
				{ label: "时长", value: plain(formatDuration(stats.wallMs)) },
			],
			inner,
		),
	});
	rows.push({
		text: cellsLine([{ label: "目录", value: plain(shortenForPanel(formatCwd(view.cwd), inner)) }], inner),
	});
	rows.push({
		text: cellsLine([{ label: "id", value: `${MUTED}${view.sessionId}${RESET_FG}` }], inner),
	});

	return rows.map((row) => ({ ...row, text: truncateToWidth(row.text, inner, "…") }));
}

const FG_LABEL = `${MUTED}`;

/** 目录在面板里再收一次（面板比整屏窄）。 */
function shortenForPanel(path: string, width: number): string {
	const budget = Math.max(8, width - LABEL_WIDTH);
	if (visibleWidth(path) <= budget) return path;
	const segments = path.split("/").filter(Boolean);
	for (let keep = segments.length - 1; keep >= 1; keep--) {
		const candidate = `…/${segments.slice(-keep).join("/")}`;
		if (visibleWidth(candidate) <= budget) return candidate;
	}
	return truncateToWidth(path, budget, "…");
}

/** 内容行 → 带边框的完整弹窗行（宽度 = inner + FRAME_EXTRA，必然居中可算）。 */
export function framePanel(
	rows: ContentRow[],
	inner: number,
	title: string,
	hint: string,
	viewport: number,
	top: number,
): string[] {
	const total = inner + FRAME_EXTRA;

	const topFill = Math.max(0, total - 4 - visibleWidth(title) - 1);
	const titleLine = `${BORDER}╭─ ${SKY_BLUE}${BOLD_ON}${title}${BOLD_OFF}${RESET_FG}${BORDER} ${"─".repeat(topFill)}╮${RESET_FG}`;

	const position =
		rows.length > viewport
			? `  ${top + 1}-${Math.min(rows.length, top + viewport)}/${rows.length}`
			: "";
	// 提示过长时先截提示，否则会把底边撑宽
	const hintText = truncateToWidth(`${hint}${position}`, Math.max(0, total - 5), "…");
	const bottomFill = Math.max(0, total - 5 - visibleWidth(hintText));
	const bottomLine = `${BORDER}╰─ ${MUTED}${hintText}${RESET_FG}${BORDER} ${"─".repeat(bottomFill)}╯${RESET_FG}`;

	const body = rows
		.slice(top, top + viewport)
		.map((row) => `${BORDER}│${RESET_FG} ${padTo(row.text, inner)} ${BORDER}│${RESET_FG}`);

	return [titleLine, ...body, bottomLine];
}

/** 可见内容行数：终端行数扣掉边框与提示，再按内容封顶。 */
export function panelViewport(terminalRows: number, lineCount: number): number {
	const available = Math.max(MIN_VIEWPORT, terminalRows - 3);
	return Math.max(1, Math.min(lineCount, available));
}

/** 夹住滚动位置。 */
export function clampScroll(top: number, lineCount: number, viewport: number): number {
	return Math.max(0, Math.min(top, Math.max(0, lineCount - viewport)));
}

/** 内容宽度：取最长行，夹在 [MIN_INNER, MAX_INNER] 与终端宽度之间。 */
export function panelInnerWidth(maxRowWidth: number, terminalCols: number): number {
	const byTerminal = Math.max(MIN_INNER, terminalCols - FRAME_EXTRA - TERMINAL_MARGIN);
	return Math.max(MIN_INNER, Math.min(MAX_INNER, byTerminal, Math.max(MIN_INNER, maxRowWidth)));
}

// ---- 组件 ------------------------------------------------------------------

const HINT_IDLE = "Enter 列表/改名 · ←→ 快切 · r 刷新 · Esc 关闭";
const HINT_EDITING = "输入名称 · Enter 保存 · Esc 取消";

class SessionInfoPanel implements Component {
	private view: SessionInfoView;
	private focus: EditableField = "name";
	private editing = false;
	/** 双击改名：第一次输入/删除就整体替换 */
	private selectAll = false;
	private draft = "";
	private cursor = 0;
	private message: string | undefined;
	private busy = false;
	private top = 0;
	private rows: ContentRow[] = [];
	private width = 0;
	/** 当前打开的下拉（模型 / 思考）；undefined = 没开 */
	private dropdown: { field: EditableField; list: SelectList; query: string; all: SelectItem[] } | undefined;
	/** 下拉在整个面板行里占的区间 [start, end)，用于鼠标 hit-test */
	private dropdownRange: { start: number; end: number } | undefined;
	/** 箭头列（下拉打开时用来算 x 偏移） */
	private hits: { field?: EditableField; arrowsCol?: number; valueCol?: number }[] = [];
	/**
	 * 刚切换成功的模型。
	 * `ctx.model` 是实时值，但在 setModel 落地的同一 tick 里可能还是旧值；
	 * 记一份本地权威值，等 ctx 追上后自动失效，避免"按 → 一直停在同一个模型"。
	 */
	private modelOverride: ModelLike | undefined;

	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly done: () => void;
	private readonly terminalRows: number;

	constructor(
		theme: Theme,
		tui: TUI,
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		done: () => void,
		terminalRows: number,
	) {
		this.theme = theme;
		this.tui = tui;
		this.pi = pi;
		this.ctx = ctx;
		this.done = done;
		this.terminalRows = terminalRows;
		this.view = collectSessionInfoView(ctx, pi.getThinkingLevel());
	}

	invalidate(): void {
		this.width = 0;
	}

	render(width: number): string[] {
		// 宽度固定用 overlay 给的值（打开时已按内容算好）：内容变化只重排，不改盒子宽度，
		// 否则换模型后盒子会变窄并在弹窗里左移。
		const effective = Math.max(FRAME_EXTRA + 16, width);
		if (this.width !== effective) {
			this.width = effective;
			this.rebuild();
		}
		const viewport = panelViewport(this.terminalRows, this.rows.length);
		this.revealFocus(viewport);
		// 底边框文案：编辑态 > 最近一次操作结果 > 默认提示。
		// 切换模型是异步的，这期间**不打断**当前文案（以前会闪一下 "…"）。
		const hint = this.editing
			? HINT_EDITING
			: this.message
				? stripAnsiText(this.message)
				: HINT_IDLE;
		return framePanel(this.rows, this.width - FRAME_EXTRA, "会话信息", hint, viewport, this.top);
	}

	/** 组件希望占的宽度（含边框）：由内容最长行决定，供 overlayOptions 居中。 */
	preferredWidth(): number {
		return this.desiredWidth();
	}

	/** 弹窗希望占多宽：内容最长行决定，夹在上下限之间。 */
	private desiredWidth(): number {
		const cols = (this.tui as unknown as { terminal?: { columns?: number } }).terminal?.columns ?? 100;
		// 先用一个足够宽的宽度排一遍，量出最长行。
		// 注意：箭头按"总是存在"算——否则切到只有 off 的模型时，思考行失去箭头、
		// 面板变窄，看起来像位置在跳。
		const probe = buildSessionInfoRows(this.view, this.theme, MAX_INNER, {
			...this.buildOptions(MAX_INNER),
			forceArrows: true,
		});
		const widest = probe.reduce(
			(max, row) => Math.max(max, row.minWidth ?? visibleWidth(row.text)),
			0,
		);
		return panelInnerWidth(widest, cols) + FRAME_EXTRA;
	}

	private buildOptions(inner: number): BuildOptions {
		const dropdown = this.dropdown
			? { after: this.dropdown.field, lines: this.dropdownLines(inner) }
			: undefined;
		return {
			focus: this.focus,
			editing: this.editing,
			selectAll: this.selectAll,
			draft: this.draft,
			cursor: this.cursor,
			message: this.message,
			dropdown,
		};
	}

	/** 下拉内部宽度（两边留白 + 边框） */
	private dropdownInner(inner: number): number {
		return Math.max(12, inner - DROPDOWN_PAD * 2 - 2);
	}

	/**
	 * 把 SelectList 渲染成"带框的一小段内容行"：
	 * 顶边 + 选中项 + 底边（底边里嵌操作提示和位置）。
	 */
	private dropdownLines(inner: number): string[] {
		const state = this.dropdown;
		if (!state) return [];
		const boxInner = this.dropdownInner(inner);
		const body = state.list.render(boxInner);
		const total = boxInner + DROPDOWN_PAD + 2;
		const left = " ".repeat(DROPDOWN_PAD);
		const topFill = Math.max(0, total - 3);
		const lines: string[] = [`${BORDER}${left}╭${"─".repeat(topFill)}╮${RESET_FG}`];
		for (const line of body) {
			lines.push(
				`${BORDER}${left}│${RESET_FG} ${padTo(line, boxInner)} ${BORDER}│${RESET_FG}`,
			);
		}
		const hint = state.query ? ` 过滤：${state.query}` : " ↑↓ 选择 · 输入过滤 · Enter 确认 · Esc 取消";
		const hintText = truncateToWidth(hint, Math.max(0, total - 5), "…");
		const bottomFill = Math.max(0, total - 5 - visibleWidth(hintText));
		lines.push(
			`${BORDER}${left}╰─${MUTED}${hintText}${RESET_FG}${BORDER}${"─".repeat(bottomFill)}╯${RESET_FG}`,
		);
		return lines;
	}

	private rebuild(): void {
		const inner = Math.max(16, this.width - FRAME_EXTRA);
		this.rows = buildSessionInfoRows(this.view, this.theme, inner, this.buildOptions(inner));
		this.hits = this.rows.map((row) => ({
			field: row.field,
			arrowsCol: row.arrowsCol,
			valueCol: row.valueCol,
		}));
		// 下拉占的行区间（紧跟字段行之后，行上有 dropdown 标记）
		let start = -1;
		let end = -1;
		for (let i = 0; i < this.rows.length; i++) {
			if (!this.rows[i]!.dropdown) continue;
			if (start < 0) start = i;
			end = i + 1;
		}
		this.dropdownRange = start >= 0 ? { start, end } : undefined;
	}

	/** 焦点行始终留在可见窗口里。 */
	private revealFocus(viewport: number): void {
		const index = this.rows.findIndex((row) => row.field === this.focus);
		if (index < 0) return;
		if (index < this.top) this.top = index;
		else if (index >= this.top + viewport) this.top = index - viewport + 1;
		this.top = clampScroll(this.top, this.rows.length, viewport);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.busy) return;

		// 下拉打开时，按键先交给 SelectList（↑↓/PgUp/PgDn/Enter/Esc 它自己处理）
		if (this.dropdown) {
			if (this.handleDropdownInput(data)) return;
		}

		if (this.editing) {
			this.handleEditInput(data);
			return;
		}

		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.moveFocus(1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.moveFocus(-1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.moveFocus(-1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.moveFocus(1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			if (this.focus === "name") this.startEditing();
			else this.openDropdown(this.focus);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "left")) {
			const direction = matchesKey(data, "right") ? 1 : -1;
			void this.cycle(direction);
			return;
		}
		if (data === "r" || data === "R") {
			this.refresh();
			return;
		}
	}

	// ---- 下拉（模型 / 思考） -------------------------------------------------

	/** 模型 / 思考的可选项（label 给列表显示，value 给回写时定位）。 */
	private dropdownItems(field: EditableField): SelectItem[] {
		if (field === "model") {
			return this.view.models.map((model) => {
				const ctxWindow = model.contextWindow ? ` · ${formatTokens(model.contextWindow)}` : "";
				const reasoning = model.reasoning ? " · ⚡" : "";
				return {
					value: `${model.provider}/${model.id}`,
					label: model.id,
					description: `${model.provider}${ctxWindow}${reasoning}`,
				};
			});
		}
		const levels = supportedThinkingLevels(this.view.model);
		const notes: Record<string, string> = {
			off: "不思考",
			minimal: "最少",
			low: "低",
			medium: "中",
			high: "高",
			xhigh: "很高",
			max: "最大",
		};
		return levels.map((level) => ({
			value: level,
			label: level,
			description: notes[level] ?? "",
		}));
	}

	private openDropdown(field: EditableField): void {
		if (field === "name") return;
		if (!this.ctx.isIdle()) {
			this.message = `${WARN_YELLOW}⚠ 正在生成，等这一轮结束再切换${RESET_FG}`;
			this.requestRender();
			return;
		}
		const all = this.dropdownItems(field);
		if (all.length === 0) {
			this.message = `${WARN_YELLOW}⚠ 没有可选项${RESET_FG}`;
			this.requestRender();
			return;
		}
		const maxVisible = Math.max(3, Math.min(DROPDOWN_MAX_VISIBLE, this.terminalRows - 16));
		const list = new SelectList(all, maxVisible, getSelectListTheme(), DROPDOWN_LAYOUT);
		const currentKey =
			field === "model"
				? `${this.view.model?.provider}/${this.view.model?.id}`
				: this.view.thought;
		const currentIndex = all.findIndex((item) => item.value === currentKey);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => {
			this.dropdown = undefined;
			this.message = undefined;
			this.requestRender(); // 先把列表收起来
			void this.applyChoice(field, item.value);
		};
		list.onCancel = () => {
			this.dropdown = undefined;
			this.requestRender();
		};
		this.focus = field;
		this.dropdown = { field, list, query: "", all };
		this.message = undefined;
		this.requestRender();
	}

	/** 下拉打开时的按键：导航键交给 SelectList，其余可打印字符当过滤词。 */
	private handleDropdownInput(data: string): boolean {
		const state = this.dropdown;
		if (!state) return false;

		// Tab 关掉下拉并把焦点交回外层（方便继续 Tab 走）
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.dropdown = undefined;
			this.requestRender();
			return false;
		}

		const isNav =
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageup") ||
			matchesKey(data, "pagedown") ||
			matchesKey(data, "return") ||
			matchesKey(data, "escape") ||
			data === "\x03";
		if (isNav) {
			state.list.handleInput(data);
			if (this.dropdown) this.requestRender();
			return true;
		}

		if (matchesKey(data, "backspace")) {
			if (state.query) {
				state.query = state.query.slice(0, -1);
				this.applyDropdownFilter(state);
				this.requestRender();
			}
			return true;
		}

		// 粘贴：抽出括起来的正文当过滤词
		const pasted = /\x1b\[20[01]~([\s\S]*)\x1b\[20[12]~/.exec(data);
		if (pasted) {
			const text = pasted[1]!.replace(/[\x00-\x1f\x7f]/g, "");
			if (text) {
				state.query += text;
				this.applyDropdownFilter(state);
				this.requestRender();
			}
			return true;
		}

		// 其余以 ESC 开头的都是功能键序列（方向键变体、Home/End…）：一律忽略，
		// 否则会把 "[C" 这种尾巴当成过滤词。
		if (data.startsWith("\x1b")) return true;

		const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
		if (!printable) return true;
		state.query += printable;
		this.applyDropdownFilter(state);
		this.requestRender();
		return true;
	}

	private applyDropdownFilter(state: NonNullable<typeof this.dropdown>): void {
		const items = state.query
			? fuzzyFilter(state.all, state.query, (item) => `${item.value} ${item.description ?? ""}`)
			: state.all;
		const maxVisible = Math.max(3, Math.min(DROPDOWN_MAX_VISIBLE, this.terminalRows - 16));
		const list = new SelectList(
			items.length > 0 ? items : state.all,
			maxVisible,
			getSelectListTheme(),
			DROPDOWN_LAYOUT,
		);
		list.onSelect = (item) => {
			this.dropdown = undefined;
			this.message = undefined;
			this.requestRender();
			void this.applyChoice(state.field, item.value);
		};
		list.onCancel = () => {
			this.dropdown = undefined;
			this.requestRender();
		};
		state.list = list;
	}

	/** 应用下拉选择（模型 → setModel，思考 → setThinkingLevel）。 */
	private async applyChoice(field: EditableField, value: string): Promise<void> {
		if (field === "model") {
			const target = this.view.models.find((model) => `${model.provider}/${model.id}` === value);
			if (!target) {
				this.requestRender();
				return;
			}
			// 先不渲染：setModel 是异步的，中途重绘会让底边框闪一下
			this.busy = true;
			try {
				const ok = await this.pi.setModel(
					target as unknown as Parameters<ExtensionAPI["setModel"]>[0],
				);
				if (ok) this.modelOverride = target;
				this.message = ok
					? `${fg24(OK_GREEN, `✓ 已切换到 ${target.id}`)}${RESET_FG}`
					: `${fg24(BAD_RED, `× ${target.provider} 未配置凭据，模型未切换`)}${RESET_FG}`;
			} catch (error) {
				this.message = `${fg24(BAD_RED, `× ${String(error)}`)}${RESET_FG}`;
			}
			this.busy = false;
			this.refresh(false);
			return;
		}

		try {
			this.pi.setThinkingLevel(value as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			this.message = `${fg24(OK_GREEN, `✓ 思考强度 → ${value}`)}${RESET_FG}`;
		} catch (error) {
			this.message = `${fg24(BAD_RED, `× ${String(error)}`)}${RESET_FG}`;
		}
		this.refresh(false);
	}

	// ---- 鼠标 ---------------------------------------------------------------

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 滚轮：滚动内容（下拉列表内部优先自己处理）
		if (event.type === "wheel") {
			// wheelDelta 正值 = 向下滚（与 pi 的约定一致：负值向上）
			const delta = event.wheelDelta ?? 0;
			const viewport = panelViewport(this.terminalRows, this.rows.length);
			const before = this.top;
			this.top = clampScroll(this.top + delta, this.rows.length, viewport);
			this.requestRender();
			return { handled: true, render: this.top !== before };
		}

		// 下拉区域：把坐标换算成 SelectList 的局部坐标后转给它
		if (this.dropdown && this.dropdownRange) {
			const dropdownTop = this.dropdownRange.start - this.top + 1; // +1 = 顶边框
			const dropdownHeight = this.dropdownRange.end - this.dropdownRange.start;
			if (event.y >= dropdownTop && event.y < dropdownTop + dropdownHeight) {
				const result = this.dropdown.list.handleMouse({
					...event,
					x: Math.max(0, event.x - DROPDOWN_PAD - 2),
					y: event.y - dropdownTop - 1, // -1 = 下拉自己的顶边
					width: this.dropdownInner(this.width - FRAME_EXTRA),
					height: dropdownHeight,
				});
				if (result) {
					this.requestRender();
					// 焦点始终留在面板上（不要让 pi 把焦点给列表组件）
					return { ...result, focus: false };
				}
				return { handled: true };
			}
			// 点到下拉外面：先收起，再继续按普通点击处理
			if (event.type === "press") {
				this.dropdown = undefined;
				this.requestRender();
			} else {
				return { handled: true };
			}
		}

		if (event.type !== "press" && event.type !== "click") {
			return undefined;
		}
		if (event.button !== "left") return undefined;

		const bodyRow = event.y - 1 + this.top; // -1 = 顶边框
		const hit = this.hits[bodyRow];
		if (!hit || bodyRow < 0 || bodyRow >= this.rows.length) return undefined;

		// 箭头区：‹ ›（按"被点的那一行"切换，而不是当前焦点行）
		// 命中范围按 ARROW_ZONE 的真实可见宽度算，字形一改就自动跟着变。
		if (hit.field && hit.arrowsCol !== undefined && event.x >= hit.arrowsCol) {
			const field = hit.field;
			const leftWidth = visibleWidth(ARROW_LEFT);
			const zoneWidth = visibleWidth(ARROW_ZONE);
			const offset = event.x - hit.arrowsCol;
			if (offset < zoneWidth) {
				this.focus = field;
				const direction = offset < leftWidth ? -1 : 1;
				void this.cycle(direction, field);
				return { handled: true, focus: true };
			}
		}

		if (!hit.field) return { handled: false };

		const field = hit.field;
		const valueCol = hit.valueCol ?? 0;
		const onValue = event.x >= valueCol;
		const doubleClick = (event.clickCount ?? 1) >= 2;

		// 点模型 / 思考的值 → 直接展开下拉（点箭头仍然是快切）
		if (field !== "name" && onValue) {
			this.focus = field;
			this.message = undefined;
			this.openDropdown(field);
			return { handled: true, focus: true };
		}

		// 单击行 → 聚焦；双击（或单击值）会话名 → 直接改名
		if (this.focus !== field) {
			this.focus = field;
			this.message = undefined;
		}
		if (field === "name" && (doubleClick || onValue)) {
			this.startEditing(doubleClick, event.x - valueCol);
			return { handled: true, focus: true };
		}
		this.requestRender();
		return { handled: true, focus: true };
	}

	private handleEditInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.editing = false;
			this.selectAll = false;
			this.message = undefined;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			void this.commitName();
			return;
		}
		if (matchesKey(data, "left")) {
			this.selectAll = false;
			this.cursor = Math.max(0, this.cursor - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(Array.from(this.draft).length, this.cursor + 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
			this.selectAll = false;
			this.cursor = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			this.cursor = Array.from(this.draft).length;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.selectAll) {
				this.selectAll = false;
				this.draft = "";
				this.cursor = 0;
				this.requestRender();
				return;
			}
			const chars = Array.from(this.draft);
			if (this.cursor > 0) {
				chars.splice(this.cursor - 1, 1);
				this.cursor -= 1;
				this.draft = chars.join("");
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			const chars = Array.from(this.draft);
			if (this.cursor < chars.length) {
				chars.splice(this.cursor, 1);
				this.draft = chars.join("");
				this.requestRender();
			}
			return;
		}
		// 普通字符 / 粘贴：去掉括起来的粘贴标记与控制字符
		const text = data
			.replace(/\x1b\[20[01]~/g, "")
			.replace(/[\x00-\x1f\x7f]/g, "");
		if (!text) return;
		if (this.selectAll) {
			// 双击全选后第一次输入 = 整体替换
			this.selectAll = false;
			this.draft = "";
			this.cursor = 0;
		}
		const chars = Array.from(this.draft);
		chars.splice(this.cursor, 0, ...Array.from(text));
		this.cursor += Array.from(text).length;
		this.draft = chars.join("");
		this.requestRender();
	}

	private startEditing(selectAll = false, clickOffset = -1): void {
		this.editing = true;
		this.selectAll = selectAll;
		this.draft = this.view.sessionName;
		const chars = Array.from(this.draft);
		// 单击定位：把点击列换算成光标下标；否则光标停在末尾
		this.cursor = clickOffset >= 0 ? cursorAtColumn(chars, clickOffset) : chars.length;
		this.message = undefined;
		this.requestRender();
	}

	private async commitName(): Promise<void> {
		const name = this.draft.replace(/\s+/g, " ").trim().slice(0, 80);
		if (!name) {
			this.message = `${WARN_YELLOW}⚠ 名称不能为空${RESET_FG}`;
			this.editing = false;
			this.requestRender();
			return;
		}
		this.busy = true;
		let message: string;
		try {
			this.pi.setSessionName(name);
			message = `${fg24(OK_GREEN, "✓ 已更新会话名")}${RESET_FG}`;
		} catch (error) {
			message = `${fg24(BAD_RED, `× ${String(error)}`)}${RESET_FG}`;
		}
		this.busy = false;
		this.editing = false;
		this.selectAll = false;
		// 先写好提示再刷新，只重绘一次
		this.message = message;
		this.refresh(false);
	}

	private moveFocus(direction: number): void {
		const index = FIELDS.indexOf(this.focus);
		this.focus = FIELDS[(index + direction + FIELDS.length) % FIELDS.length]!;
		this.message = undefined;
	}

	/** ←→：在可选模型 / 思考档位之间循环，并立刻应用。 */
	private async cycle(direction: number, field: EditableField = this.focus): Promise<void> {
		if (field === "name") return;

		if (!this.ctx.isIdle()) {
			this.message = `${WARN_YELLOW}⚠ 正在生成，等这一轮结束再切换${RESET_FG}`;
			this.requestRender();
			return;
		}

		if (field === "model") {
			const models = this.view.models;
			if (models.length === 0) {
				this.message = `${WARN_YELLOW}⚠ 没有可用模型${RESET_FG}`;
				this.requestRender();
				return;
			}
			const next = (this.view.modelIndex + direction + models.length) % models.length;
			const target = models[next]!;
			// 先不渲染也不清提示：等 setModel 回来一次性更新（中途重绘会闪）
			this.busy = true;
			try {
				const ok = await this.pi.setModel(
					target as unknown as Parameters<ExtensionAPI["setModel"]>[0],
				);
				if (ok) this.modelOverride = target;
				this.message = ok
					? `${fg24(OK_GREEN, `✓ 已切换到 ${target.id}`)}${RESET_FG}`
					: `${fg24(BAD_RED, `× ${target.provider} 未配置凭据，模型未切换`)}${RESET_FG}`;
			} catch (error) {
				this.message = `${fg24(BAD_RED, `× ${String(error)}`)}${RESET_FG}`;
			}
			this.busy = false;
			this.refresh(false);
			return;
		}

		const levels = supportedThinkingLevels(this.view.model);
		if (levels.length <= 1) {
			this.message = `${MUTED}该模型只有 off${RESET_FG}`;
			this.requestRender();
			return;
		}
		const current = levels.indexOf(this.view.thought);
		const next = levels[(Math.max(0, current) + direction + levels.length) % levels.length]!;
		try {
			this.pi.setThinkingLevel(next as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			this.message = `${fg24(OK_GREEN, `✓ 思考强度 → ${next}`)}${RESET_FG}`;
		} catch (error) {
			this.message = `${fg24(BAD_RED, `× ${String(error)}`)}${RESET_FG}`;
		}
		this.refresh(false);
	}

	private refresh(clearMessage = true): void {
		const next = collectSessionInfoView(this.ctx, this.pi.getThinkingLevel());
		if (this.modelOverride) {
			// ctx.model 追上本地权威值 → 覆盖作废；否则继续用本地值
			// （有的环境里 ctx.model 在同一 tick 还是旧值，会让人以为"按 → 没反应"）
			if (modelKey(next.model) === modelKey(this.modelOverride)) {
				this.modelOverride = undefined;
			} else {
				const index = next.models.findIndex(
					(entry) => modelKey(entry) === modelKey(this.modelOverride),
				);
				next.model = this.modelOverride;
				if (index >= 0) next.modelIndex = index;
			}
		}
		this.view = next;
		if (clearMessage) this.message = undefined;
		this.requestRender();
	}

	/** 内容（焦点 / 草稿 / 提示）变了：标记脏，下一帧按新内容重排并重绘。 */
	private requestRender(): void {
		this.width = 0;
		this.tui.requestRender();
	}
}

// ---- 入口 ------------------------------------------------------------------

/** 打开信息面板（命令与快捷键共用）。 */
export async function showSessionInfoPanel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;

	// overlay 的宽度 = 内容宽度（这样才是"盒子居中"，而不是"文字贴左"）。
	// 宽度只能从 tui 问到，所以用可变对象 + 函数式 overlayOptions 让它跟随渲染。
	const size = { width: MIN_INNER + FRAME_EXTRA };

	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			const panel = new SessionInfoPanel(
				theme,
				tui,
				pi,
				ctx,
				() => done(undefined),
				(tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24,
			);
			size.width = Math.min(
				MAX_INNER + FRAME_EXTRA,
				Math.max(MIN_INNER + FRAME_EXTRA, panel.preferredWidth()),
			);
			return panel;
		},
		{
			overlay: true,
			overlayOptions: () => ({
				width: size.width,
				maxHeight: "95%",
				anchor: "center",
				margin: 1,
			}),
		},
	);
}

export function setupSessionInfoPanel(pi: ExtensionAPI): void {
	// 只注册快捷键（不做命令注册：避免和别人的 /info 撞名）
	pi.registerShortcut("alt+i", {
		description: "会话信息面板",
		handler: async (ctx) => {
			await showSessionInfoPanel(pi, ctx);
		},
	});
}
