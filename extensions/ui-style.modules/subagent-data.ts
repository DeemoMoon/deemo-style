/**
 * 子代理面板的**数据层**：details 形状、常量、纯函数（图标/耗时/底行/标题）。
 *
 * 与 `subagent-panel.ts`（视图层）拆开的原因：
 *   - 这些函数是纯的，可以单测，不需要 pi-tui 的组件与宽度计算；
 *   - 视图层已经有 4 个组件类，混在一起会让文件比 `panels.ts` 还长。
 * 与 `edit-preview.ts` 从 `panels.ts` 拆出去是同一个思路。
 *
 * 数据源：subagent 工具执行期间用 `onUpdate` 推送 partial result，`details`
 * 里带每个子代理的 status / messages / usage / model（见 pi 的 subagent 扩展）。
 */

import {
	liveClockText,
	formatTokens,
	ICON_CLOCK,
	mixRgb,
	normalizeNewlines,
	RESET_FG,
	shimmerText,
	sgr,
	BOLD_OFF,
	BOLD_ON,
	BAD_RED,
	OK_GREEN,
	WARN_YELLOW,
} from "./core.ts";
import type { BlockClock, Rgb } from "./core.ts";
// 命中率档位色：越高越好（别和 context-bar 的 levelOf 混用，那个是"越高越糟"）。
import { hitRateMuted } from "./context-bar.ts";

// ---- 图标与常量 -------------------------------------------------------------

/** 子代理图标（Nerd Font）：单个、链式、每个子代理块的标题都用它。 */
export const ICON_SUBAGENT = "\uF4BE";
/** 并行模式标题图标。 */
export const ICON_PARALLEL = "\uEE0D";
/** token 输入/输出图标（与信息条一致）。 */
export const ICON_TOKEN_IN = "\uF176";
export const ICON_TOKEN_OUT = "\uF175";
/** 耗时用的时钟图标（与工具面板同一个）。 */
export const ICON_TIMER = ICON_CLOCK;
/**
 * “执行中”的状态标记（U+F0211，Nerd Font 的转轮/沙漏一类字形）。
 * 成功用 `✓`、失败用 `✗`，见 statusMark()。
 */
export const ICON_STATUS_RUNNING = "\uDB80\uDE11";

/** 每个子代理块的滚动窗口行数。 */
export const SUBAGENT_TAIL_LINES = 4;
/** 子代理标题色（与 bash / 技能横幅同族蓝）。 */
export const ACCENT_SUBAGENT: Rgb = [95, 135, 215];

/** 完成态**结论**保留的行数（看头部）：超出用「还有 N 行」提示，Ctrl+O 展开。 */
export const RESULT_CONCLUSION_LINES = 4;
/** 展开态每个子代理最多显示多少个 display item（过程）。 */
export const RESULT_SINGLE_ITEMS = 10;
/** text 型 item 折叠时最多显示几行。 */
export const RESULT_TEXT_LINES = 3;

// ---- 数据形状（本地最小形状，不依赖 pi 的类型） ----------------------------

export interface SubagentUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}

export type SubagentContentPart = { type?: string; text?: string; name?: string; arguments?: unknown };

export interface SubagentMessageLike {
	role?: string;
	thinkingLevel?: string;
	model?: string;
	content?: SubagentContentPart[];
}

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface SubagentChildLike {
	agent: string;
	agentSource?: string;
	task: string;
	status: SubagentStatus;
	messages: SubagentMessageLike[];
	stderr: string;
	usage: SubagentUsageLike;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetailsLike {
	mode: "single" | "parallel" | "chain";
	results: SubagentChildLike[];
	isError: boolean;
}

/** subagent 工具参数的本地最小形状（renderCall 阶段只有它）。 */
export interface SubagentArgsLike {
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
	chain?: unknown;
}

/** 渲染状态：总计时 + 每个子代理各自的计时与尾窗快照。 */
export interface SubagentPanelState extends BlockClock {
	/**
	 * 最后一次由 renderResult 观测到的状态标记。
	 *
	 * renderCall 拿不到 details（只有 args），结束后仍要继续渲染标题；把状态
	 * 缓存在这里，失败的子代理才不会在标题上显示成 ✓。
	 */
	mark?: StatusMark;
	clocks?: Map<string, BlockClock>;
	/** 尾窗快照的存储形状由视图层填充（这里只声明键与容器的关系）。 */
	windows?: Map<string, unknown>;
	/** 块渲染结果缓存（面板层填充：签名 → 渲染好的行，避免每帧重渲全部块）。 */
	blockCache?: Map<string, { signature: string; lines: string[] }>;
}

// ---- 纯函数 -----------------------------------------------------------------

/** 子代理是否还在推进（决定计时定格、光标闪烁、扫光）。 */
export function isChildActive(child: SubagentChildLike): boolean {
	return child.status === "running" || child.status === "pending";
}


/** 缓存命中率（%）；没有缓存读写时返回 undefined（显示 `--`，不误报 0%）。 */
export function cacheHitRate(usage: SubagentUsageLike): number | undefined {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	if (prompt <= 0 || (usage.cacheRead === 0 && usage.cacheWrite === 0)) return undefined;
	return (usage.cacheRead / prompt) * 100;
}

/** 从 messages 里翻最近一次 thinkingLevel（子代理自己的思考强度）。 */
export function childThinkingLevel(messages: SubagentMessageLike[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const level = messages[i]?.thinkingLevel;
		if (typeof level === "string" && level) return level;
	}
	return undefined;
}

/** 子代理实际用的模型（details.model 优先，退回最后一条 assistant 的 model）。 */
export function childModel(child: SubagentChildLike): string | undefined {
	if (child.model) return child.model;
	for (let i = child.messages.length - 1; i >= 0; i--) {
		const model = child.messages[i]?.model;
		if (typeof model === "string" && model) return model;
	}
	return undefined;
}

/** display item：assistant 的 text 片段或工具调用摘要。 */
export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string };

/** 抽 display items（与 pi 的 getDisplayItems 同口径：只看 assistant 消息）。 */
export function displayItems(messages: SubagentMessageLike[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (part.type === "text" && part.text) items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") {
				items.push({ type: "toolCall", name: String(part.name ?? "tool") });
			}
		}
	}
	return items;
}

/**
 * 执行内容文本的缓存（键 = messages 数组引用 + 长度 + 末条消息引用）。
 *
 * 每帧至少被问 3 次（块的 cacheKey、LiveTailView 的 cacheKey 与 renderLines），
 * 每次都全量遍历 messages 太贵。流式时数组是新对象、或末条消息被替换，于是缓存
 * 自然失效；历史回放时数组引用稳定，命中后几乎零成本。
 */
const activityCache = new WeakMap<
	SubagentMessageLike[],
	{ length: number; last: SubagentMessageLike | undefined; text: string }
>();

/** 执行内容文本：text 与 `→ 工具` 摘要拼成一段（滚动窗口用）。 */
export function childActivityText(messages: SubagentMessageLike[]): string {
	const cached = activityCache.get(messages);
	const last = messages[messages.length - 1];
	if (cached !== undefined && cached.length === messages.length && cached.last === last) {
		return cached.text;
	}
	const parts: string[] = [];
	for (const item of displayItems(messages)) {
		parts.push(item.type === "text" ? item.text : `→ ${item.name}`);
	}
	const text = parts.join("\n");
	activityCache.set(messages, { length: messages.length, last, text });
	return text;
}

/**
 * 块耗时文案：运行中的第一帧（0~几 ms）不显示。
 *
 * 计时口径是「块一出现就开始」，所以首帧 elapsed 必为 0ms；直接显示会闪一下
 * "0ms" 再跳到真实值。结束后照常显示（3ms 这种本机工具的真实耗时有意义）。
 */
export function elapsedText(clock: BlockClock): string | undefined {
	return liveClockText(clock);
}

/** 耗时后缀（` · ⏱ 2.4s`），没有可信计时时为空串。 */
function timerSuffix(clock: BlockClock): string {
	const elapsed = elapsedText(clock);
	return elapsed === undefined ? "" : ` · ${ICON_TIMER} ${elapsed}`;
}

/**
 * 底行：输入 token · 输出 token · 模型 · 思考强度 · 缓存命中率。
 *
 * 逐段着色、**不整体包一层**：外层包 DIM_GRAY 会被内层（缓存命中率的档位色）
 * 的 RESET 提前终止，后半行颜色就断了。
 */
export function childFooterText(child: SubagentChildLike): string {
	const usage = child.usage;
	const parts: string[] = [
		`${ICON_TOKEN_IN} ${formatTokens(usage.input)}`,
		`${ICON_TOKEN_OUT} ${formatTokens(usage.output)}`,
	];
	const model = childModel(child);
	if (model) parts.push(model);
	// 思考强度与缓存命中率**不带图标**（只留文字值），避免小图标在状态行里抢视线。
	const thinking = childThinkingLevel(child.messages);
	if (thinking) parts.push(thinking);
	const rate = cacheHitRate(usage);
	parts.push(
		rate === undefined ? "--" : `${sgr(hitRateMuted(rate))}${rate.toFixed(1)}%${RESET_FG}`,
	);
	return parts.join(" · ");
}

/**
 * 子代理块的标题正文：`[步骤号] \uF4BE 名称 · ⏱ 耗时`。
 *
 * 与单个模式的标题同一套语法（图标 + 名称 + 耗时），区别只是不带"子代理"字样
 * ——并行/链式里外层标题已经说过了，每块再重复一遍太啰嗦。
 */
export function childTitlePlain(child: SubagentChildLike, clock: BlockClock): string {
	const step = child.step !== undefined ? `${child.step}. ` : "";
	return `${step}${ICON_SUBAGENT} ${child.agent}${timerSuffix(clock)}`;
}

/**
 * 子代理块标题的着色版：正文 + 行尾状态标记（✓/✗/󰈑），运行中整行扫光。
 *
 * 和单个模式的面板标题完全同一套规则，所以并行/链式里每一块看起来就是
 * "一个缩小版的单个 agent"。
 */
export function childTitle(
	child: SubagentChildLike,
	clock: BlockClock,
	running: boolean,
): string {
	const mark = statusMark([child], running);
	const plain = childTitlePlain(child, clock);
	if (running) {
		const full = `${plain} · ${statusMarkGlyph(mark)}`;
		return `${BOLD_ON}${shimmerText(full, ACCENT_SUBAGENT, clock.startedAt)}${BOLD_OFF}${RESET_FG}`;
	}
	return `${sgr(ACCENT_SUBAGENT)}${BOLD_ON}${plain}${BOLD_OFF}${RESET_FG}${statusMarkText(mark)}`;
}



/** 状态标记的种类：执行中 / 成功 / 失败。 */
export type StatusKind = "running" | "ok" | "fail";

/** 状态标记（字形与颜色由 kind 决定；executing 时字形是动画帧）。 */
export interface StatusMark {
	kind: StatusKind;
}

/**
 * 亮度衰减：状态标记用语义色，但比标题暗一档，避免和标题抢视线。
 * 0.25 = 向黑色混 25%（保持色相，只降亮度）。
 */
const MARK_DIM = 0.25;
const DIM_BLACK: Rgb = [0, 0, 0];

/** 执行中标记的颜色：与标题同色（ACCENT_SUBAGENT），亮度降低一档。 */
const MARK_RUNNING_RGB: Rgb = mixRgb(ACCENT_SUBAGENT, DIM_BLACK, MARK_DIM);

/**
 * 任务描述行的颜色：**黄色**（用「」包起来，和蓝色的标题/白色的结论区分开）。
 *
 * 任务行是"这块要做什么"，与"这块是谁/多久"（标题）和"结果是什么"（结论）是
 * 三类信息，用不同色相分开；黄色也正好是思考块那套配色里最"提示性"的一档。
 */
export const TASK_TEXT_RGB: Rgb = WARN_YELLOW;
/** 任务描述的包裹符号（中文直角引号）。 */
export const TASK_WRAP_OPEN = "「";
export const TASK_WRAP_CLOSE = "」";
/** 成功 / 失败同样降亮度，但保留绿/红色相（一眼能区分成败）。 */
const MARK_OK_RGB: Rgb = mixRgb(OK_GREEN, DIM_BLACK, MARK_DIM);
const MARK_FAIL_RGB: Rgb = mixRgb(BAD_RED, DIM_BLACK, MARK_DIM);

/**
 * 标题末尾的状态标记（取代原来的一串文字）。
 *
 * ✓ = 执行成功、✗ = 执行失败、U+F0211 = 还在执行中（动画）。
 */
export function statusMark(results: readonly SubagentChildLike[], running: boolean): StatusMark {
	if (running || results.some(isChildActive)) return { kind: "running" };
	if (results.some((child) => child.status === "failed" || child.status === "aborted")) {
		return { kind: "fail" };
	}
	return { kind: "ok" };
}

/** 状态标记的字形（不含颜色）。 */
export function statusMarkGlyph(mark: StatusMark): string {
	if (mark.kind === "running") return ICON_STATUS_RUNNING;
	return mark.kind === "ok" ? "✓" : "✗";
}

/**
 * 状态标记的着色文本（` · ✓`）。
 *
 * 执行中这份只用在「标题不扫光」的路径上（renderCall 的骨架首帧等）；标题在
 * 运行时会把字形一起交给 shimmerText，**让高光扫过 󰈑**，见 titleWithMark()。
 */
export function statusMarkText(mark: StatusMark): string {
	const rgb = mark.kind === "running" ? MARK_RUNNING_RGB : mark.kind === "ok" ? MARK_OK_RGB : MARK_FAIL_RGB;
	return ` · ${sgr(rgb)}${statusMarkGlyph(mark)}${RESET_FG}`;
}

/** 面板标题的纯文本部分（扫光要把整行当字符流处理，所以单独一份）。 */
export function panelTitlePlain(
	mode: SubagentDetailsLike["mode"],
	results: readonly SubagentChildLike[],
	clock: BlockClock,
): string {
	const label =
		mode === "single"
			? `子代理${results[0] ? ` · ${results[0].agent}` : ""}`
			: mode === "parallel"
				? `子代理 · 并行 · ${results.length} 个任务`
				: `子代理 · 链式 · 共 ${results.length} 步`;
	const icon = mode === "parallel" ? ICON_PARALLEL : ICON_SUBAGENT;
	return `${icon} ${label}${timerSuffix(clock)}`;
}


/** 标题 = 正文（运行中整行扫光）+ 行尾状态标记（标记不参与扫光）。 */
function titleWithMark(plain: string, mark: StatusMark, clock: BlockClock, running: boolean): string {
	if (running) {
		// 状态标记**一起进扫光**：高光带从标题一路扫到 󰈑，字形不再是"贴在
		// 扫光外面"的独立色块（早期版本把标记拼在 shimmerText 之后，扫光扫不到它）。
		const full = `${plain} · ${statusMarkGlyph(mark)}`;
		return `${BOLD_ON}${shimmerText(full, ACCENT_SUBAGENT, clock.startedAt)}${BOLD_OFF}${RESET_FG}`;
	}
	const body = `${sgr(ACCENT_SUBAGENT)}${BOLD_ON}${plain}${BOLD_OFF}`;
	return `${body}${RESET_FG}${statusMarkText(mark)}`;
}

/**
 * renderCall 阶段的标题：那时还没有 details（参数可能还在流式），
 * 但 args 里已经有模式与数量，先按它出标题，别让块空着。
 */
export function titleFromArgs(
	args: unknown,
	clock: BlockClock,
	running: boolean,
	/** 结束态的真实状态（renderCall 拿不到 details，由 renderResult 缓存在 state 上）。 */
	mark: StatusMark = { kind: "ok" },
): string {
	const record = (args ?? {}) as SubagentArgsLike;
	const tasks = Array.isArray(record.tasks) ? record.tasks.length : 0;
	const chain = Array.isArray(record.chain) ? record.chain.length : 0;
	const mode: SubagentDetailsLike["mode"] = tasks > 0 ? "parallel" : chain > 0 ? "chain" : "single";
	const agent = typeof record.agent === "string" && record.agent ? record.agent : "";
	const label =
		mode === "single"
			? `子代理${agent ? ` · ${agent}` : ""}`
			: mode === "parallel"
				? `子代理 · 并行 · ${tasks} 个任务`
				: `子代理 · 链式 · 共 ${chain} 步`;
	const icon = mode === "parallel" ? ICON_PARALLEL : ICON_SUBAGENT;
	const plain = `${icon} ${label}${timerSuffix(clock)}`;
	const resolved = running ? statusMark([], true) : mark;
	return titleWithMark(plain, resolved, clock, running);
}

/**
 * 子代理的**结论**：最后一条 assistant 消息里的**第一个 text 块**。
 *
 * 语义与 pi 的 `getFinalOutput()` 完全一致（并行/链式的 `result.content` 就是用它
 * 拼的），这样"块里显示的结论"和"主 agent 实际收到的文本"不会打架。
 * 注意不是"最后一段 text"——一条消息里可能先有前言、再有工具调用、最后才是结论，
 * pi 取的是前言那一块，我们跟随。
 *
 * 单个模式的权威来源仍是 `result.content`；这里提供从 messages 推导的版本，
 * 供并行/链式按块显示各自的结论。
 */
export function childFinalOutput(messages: SubagentMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (part.type === "text" && part.text) return part.text;
		}
	}
	return "";
}

/**
 * 结论的折叠视图：**看头部** N 行（结论通常先说结论，后文是细节）。
 *
 * 返回要显示的行 + 被折叠掉的行数（0 表示全部显示）。
 */
export function conclusionHead(
	text: string,
	maxLines: number,
): { lines: string[]; remaining: number } {
	const lines = normalizeNewlines(text).split("\n");
	// 尾部空行不计入（模型常在结尾多留一个换行）。
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
	if (end <= maxLines) return { lines: lines.slice(0, end), remaining: 0 };
	return { lines: lines.slice(0, maxLines), remaining: end - maxLines };
}

/** 过程摘要：工具调用次数（0 次返回 undefined，不显示空摘要）。 */
export function processSummary(messages: SubagentMessageLike[]): string | undefined {
	const count = displayItems(messages).filter((item) => item.type === "toolCall").length;
	if (count === 0) return undefined;
	return `${count} 次工具调用`;
}

/** 汇总用量（并行/链式底部的 Total）。 */
export function totalUsage(results: readonly SubagentChildLike[]): SubagentUsageLike {
	const total: SubagentUsageLike = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const child of results) {
		total.input += child.usage.input;
		total.output += child.usage.output;
		total.cacheRead += child.usage.cacheRead;
		total.cacheWrite += child.usage.cacheWrite;
		total.cost += child.usage.cost;
	}
	return total;
}


/** 失败证据（错误信息 / stderr / 停止原因），没有失败时返回 undefined。 */
export function failureText(child: SubagentChildLike): string | undefined {
	if (child.status !== "failed" && child.status !== "aborted") return undefined;
	const evidence = child.errorMessage?.trim() || child.stderr.trim() || child.stopReason;
	return evidence ? evidence : "(已中止)";
}

/**
 * 每个子代理的稳定键：**用结果数组下标**，不用 agent 名。
 *
 * 以前是 `step ?? agent`：并行传两个同名 agent（比如都是 scout）时 key 相同，
 * 于是它们的 `state.clocks` / `state.windows` 互相覆盖——第一个结束后第二个的
 * 计时被定格、两个块显示同一份滚动输出。下标在同一个 toolCall 里唯一且稳定
 * （并行数组定长、链式只追加），所以改用它。
 */
export function childKey(index: number): string {
	return `child:${index}`;
}
