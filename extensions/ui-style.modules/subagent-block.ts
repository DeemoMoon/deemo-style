/**
 * 子代理面板的**块视图层**：一个子代理块的完整渲染（任务 / 滚动输出 / 结论 / 底行）。
 *
 * 从 `subagent-panel.ts` 拆出来的原因：那里 5 个 class + 一堆行拼装助手混在一起，
 * 有效代码超过 700 行；而块渲染是其中最大、且**与面板外壳无关**的一块（单个模式、
 * 并行块、链式块都用它）。拆开后外壳只负责"摆几个块"（窗口选择 / 轮播 / 入口注册）。
 *
 * 依赖方向：`subagent-data.ts`（纯函数）→ 本文件（块渲染）→ `subagent-panel.ts`（外壳）。
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	CachedView,
	DIM_GRAY,
	LiveTailView,
	newWindowSnapshot,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	PREVIEW_CONNECTOR_WIDTH,
	RESET_FG,
	sgr,
	touchClock,
	UI_INDENT,
	UI_INDENT_WIDTH,
} from "./core.ts";
import type {
	BlockClock,
	ThemeLike,
	WindowSnapshot,
} from "./core.ts";
import {
	childActivityText,
	childFinalOutput,
	childFooterText,
	childKey,
	childTitle,
	conclusionHead,
	displayItems,
	failureText,
	isChildActive,
	processSummary,
	RESULT_CONCLUSION_LINES,
	RESULT_SINGLE_ITEMS,
	RESULT_TEXT_LINES,
	SUBAGENT_TAIL_LINES,
	TASK_TEXT_RGB,
	TASK_WRAP_CLOSE,
	TASK_WRAP_OPEN,
} from "./subagent-data.ts";
import type {
	DisplayItem,
	SubagentChildLike,
	SubagentPanelState,
} from "./subagent-data.ts";

// ---- 渲染状态小助手 ---------------------------------------------------------

/**
 * 每个子代理的计时：运行中打点、结束就地定格（与工具面板同一套 BlockClock）。
 */
export function childClock(state: SubagentPanelState, child: SubagentChildLike): BlockClock {
	state.clocks ??= new Map();
	const key = childKey(child);
	let clock = state.clocks.get(key);
	if (!clock) {
		clock = {};
		state.clocks.set(key, clock);
	}
	touchClock(clock, isChildActive(child));
	return clock;
}

/** 每个子代理的尾窗快照（跨帧/跨组件实例复用，避免每帧往上顶）。 */
function childWindow(state: SubagentPanelState, child: SubagentChildLike): WindowSnapshot {
	state.windows ??= new Map();
	const key = childKey(child);
	let window = state.windows.get(key) as WindowSnapshot | undefined;
	if (!window) {
		window = newWindowSnapshot();
		state.windows.set(key, window);
	}
	return window;
}

// ---- 共享块：任务行 / 结论行 / 过程摘要（单个与并行/链式共用同一套） --------

/**
 * 并行/链式里，每个子代理块相对外层再缩进一列数（嵌套一级）。
 *
 * 3 列 = 连接符 "⎿ "（字形 + 1 空格）的宽度：视觉上"这一块挂在上面那行下面"。
 * 单个模式不嵌套（nest = ""），因为它本身就是最外层。
 */
export const CHILD_NEST = "   ";

/**
 * 与 `PREVIEW_CONNECTOR_FIRST` **等宽但没有 ⎿** 的前缀（5 个空格）。
 *
 * 块顶部的状态行、子代理块的标题行用它：内容列与其它行严格对齐，但不再画连接符
 * ——这两行是"标题性质"的，挂个 ⎿ 反而像在连下一行。
 */
export const BLANK_CONNECTOR = " ".repeat(PREVIEW_CONNECTOR_WIDTH);

/**
 * 任务行：黄色、整段用「」包起来、续行对齐到「后面那个字。
 *
 * 宽度预算要把**三样**都扣掉：块缩进 + 连接符 + 引号（首行是「、续行是 hang）。
 * 漏掉 UI_INDENT_WIDTH 会让每行多算 1 列，靠 CachedView 的 truncateToWidth
 * 兜底切掉——那会吃掉最后一个字，首行/续行字数就对不上了。
 */
export function taskLines(task: string | undefined, width: number, nest = ""): string[] {
	if (!task || !task.trim()) return [];
	const openWidth = Math.max(1, visibleWidth(TASK_WRAP_OPEN));
	const contentWidth = Math.max(
		1,
		width - UI_INDENT_WIDTH - visibleWidth(nest) - PREVIEW_CONNECTOR_WIDTH - openWidth,
	);
	// 压掉空行：链式的任务里是上一步的完整输出，常带段落分隔（\n\n）。
	// 任务区是"这一步要做什么"的连续说明，中间夹空行只会把块撑高、读起来断断续续。
	const compact = task.replace(/\n[ \t]*\n+/g, "\n");
	const wrapped = `${TASK_WRAP_OPEN}${compact}${TASK_WRAP_CLOSE}`;
	const hang = " ".repeat(openWidth);
	// 任务描述**完整显示**（不截断）：链式的任务里含 `{previous}` 被替换后的上一步
	// 输出，那是"这一步的输入"，截掉就看不到上下文了。只显示一个块时高度可控。
	return wrapTextWithAnsi(wrapped, contentWidth).map((segment, index) => {
		const prefix = index === 0 ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST + hang;
		return `${UI_INDENT}${nest}${prefix}${sgr(TASK_TEXT_RGB)}${segment}${RESET_FG}`;
	});
}

/** 底行：输入/输出 token · 模型 · 思考强度 · 命中率（一块的最后一行）。 */
export function footerLine(child: SubagentChildLike, nest = ""): string {
	return `${UI_INDENT}${nest}${PREVIEW_CONNECTOR_REST}${DIM_GRAY}${childFooterText(child)}${RESET_FG}`;
}

/** 结论 + 折叠提示（看头部 N 行；展开态给全文）。 */
export function conclusionLines(
	conclusion: string,
	expanded: boolean,
	theme: ThemeLike,
	nest = "",
): string[] {
	const body = `${UI_INDENT}${nest}${PREVIEW_CONNECTOR_REST}`;
	if (!conclusion) {
		return [`${body}${theme.fg("muted", "(无输出)")}`];
	}
	if (expanded) {
		return conclusion.split("\n").map((line) => `${body}${theme.fg("text", line)}`);
	}
	const head = conclusionHead(conclusion, RESULT_CONCLUSION_LINES);
	const lines = head.lines.map((line) => `${body}${theme.fg("text", line)}`);
	if (head.remaining > 0) {
		lines.push(
			`${body}${theme.fg("muted", `... 还有 ${head.remaining} 行${expandedHint()}`)}`,
		);
	}
	return lines;
}

/** 展开提示的措辞（单个块才有 Ctrl+O；块内提示保持简短）。 */
function expandedHint(): string {
	return "（Ctrl+O 展开）";
}

/** 过程摘要一行（`N 次工具调用`），没有调用时不产生行。 */
export function processSummaryLine(child: SubagentChildLike, theme: ThemeLike, nest = ""): string[] {
	const summary = processSummary(child.messages);
	return summary === undefined
		? []
		: [`${UI_INDENT}${nest}${PREVIEW_CONNECTOR_REST}${theme.fg("muted", summary)}`];
}

/**
 * 一个子代理块的完整渲染（运行中 / 完成态共用）。
 *
 * 「和单个 agent 一样的样式」就靠这里统一：
 *   [标题（可选）] → 任务行（黄） → 滚动输出 或 结论 → [过程摘要] → 底行
 *
 * - 单个模式：标题由 renderCall 画，这里 showTitle=false（否则重复两行）
 * - 并行/链式：每块自己带标题（showTitle=true），所以每块看起来就是一个
 *   缩小版的单个 agent
 */
export class AgentBlockView extends CachedView {
	private readonly child: SubagentChildLike;
	private readonly state: SubagentPanelState;
	private readonly theme: ThemeLike;
	private readonly running: boolean;
	private readonly expanded: boolean;
	private readonly showTitle: boolean;
	/** 单个模式的任务行在 renderCall 里（args.task），块内不再画一遍。 */
	private readonly showTask: boolean;
	/** 正文（任务/结论/过程/底行）的额外缩进。 */
	private readonly nest: string;

	/** 完成态的结论文本（单个模式来自 result.content，多块模式来自各自 messages）。 */
	private readonly resultText: string | undefined;
	private readonly tail: LiveTailView;

	constructor(options: {
		child: SubagentChildLike;
		state: SubagentPanelState;
		theme: ThemeLike;
		running: boolean;
		expanded: boolean;
		showTitle: boolean;
		/** 是否画任务行（单个模式由 renderCall 画，这里传 false 避免重复）。 */
		showTask?: boolean;
		/** 整块再缩进的前缀（并行/链式的块嵌在外层标题下面）。 */
		nest?: string;
		/** 只有单个模式需要外部结论（多块各自从 messages 取），不传就不显示结论。 */
		resultText?: string;
	}) {
		super();
		this.child = options.child;
		this.state = options.state;
		this.theme = options.theme;
		this.running = options.running;
		this.expanded = options.expanded;
		this.showTitle = options.showTitle;
		this.showTask = options.showTask !== false;
		this.nest = options.nest ?? "";

		this.resultText = options.resultText;
		this.tail = new LiveTailView(
			{
				text: () => childActivityText(this.child.messages),
				finished: () => !this.running,
				window: childWindow(options.state, options.child),
			},
			options.theme,
			// 任务行已经占了 ⎿，窗口内容全部走等宽续行前缀（一层里不要两个 ⎿）。
			{
				maxLines: SUBAGENT_TAIL_LINES,
				cursor: this.running,
				firstConnector: false,
				indent: options.nest ?? "",
			},
		);
	}

	protected override cacheKey(): string {
		const activity = childActivityText(this.child.messages);
		return [
			this.showTitle ? 1 : 0,
			this.showTask ? 1 : 0,
			this.nest,
			this.running ? 1 : 0,
			this.expanded ? 1 : 0,
			this.child.status,
			this.running ? Math.floor(Date.now() / 50) : 0,
			activity.length,
			activity.slice(-24),
			this.child.usage.input,
			this.child.usage.output,
			this.resultText?.length ?? 0,
		].join("\u0000");
	}

	invalidate(): void {
		this.tail.invalidate();
		super.invalidate();
	}

	protected renderLines(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];

		// 1) 标题（多块模式才有；单个模式的标题在 renderCall 里）
		if (this.showTitle) {
			const clock = childClock(this.state, this.child);
			lines.push(
				`${UI_INDENT}${BLANK_CONNECTOR}${childTitle(this.child, clock, this.running)}`,
			);
		}

		// 2) 任务行（黄色、「」包裹）；单个模式由 renderCall 负责，避免两行重复
		if (this.showTask) lines.push(...taskLines(this.child.task, width, this.nest));

		// 3) 失败：给错误证据，不再显示结论
		const failure = failureText(this.child);
		if (failure) {
			lines.push(`${UI_INDENT}${this.nest}${PREVIEW_CONNECTOR_REST}${theme.fg("error", failure)}`);
			lines.push(footerLine(this.child, this.nest));
			return lines;
		}

		if (this.running) {
			// 4a) 运行中：4 行滚动输出（末行 ▍）
			const tailLines = this.tail.render(width);
			if (tailLines.length > 0) {
				lines.push(...tailLines);
			} else {
				const label = this.child.status === "pending" ? "(等待中...)" : "(执行中...)";
				lines.push(`${UI_INDENT}${this.nest}${PREVIEW_CONNECTOR_REST}${theme.fg("muted", label)}`);
			}
		} else {
			// 4b) 完成：结论（默认取该子代理自己的最后一条 assistant 文本）
			const conclusion = (this.resultText ?? childFinalOutput(this.child.messages)).trim();
			lines.push(...conclusionLines(conclusion, this.expanded, theme, this.nest));
			// 5) 过程：折叠态只留一行摘要；展开态铺完整工具调用列表
			//    （text 片段已经作结论显示过，这里只取 toolCall，避免同一段文字出现两遍）。
			if (this.expanded) {
				const process = processItems(displayItems(this.child.messages));
				for (const line of collapsedItemLines(process, RESULT_SINGLE_ITEMS, theme, false)) {
					lines.push(`${UI_INDENT}${this.nest}${PREVIEW_CONNECTOR_REST}${line}`);
				}
			} else {
				lines.push(...processSummaryLine(this.child, theme, this.nest));
			}
		}

		// 6) 底行
		lines.push(footerLine(this.child, this.nest));
		return lines;
	}
}

// ---- 结束态：折叠摘要 -------------------------------------------------------

/** 折叠态的 display item 行（text 只取前几行，工具调用是一行摘要）。 */
export function collapsedItemLines(
	items: readonly DisplayItem[],
	limit: number,
	theme: ThemeLike,
	expanded: boolean,
): string[] {
	const shown = items.slice(-limit);
	const lines: string[] = [];
	const skipped = items.length - shown.length;
	if (skipped > 0) lines.push(theme.fg("muted", `... 前面还有 ${skipped} 项`));
	for (const item of shown) {
		if (item.type === "toolCall") {
			lines.push(`${theme.fg("muted", "→ ")}${theme.fg("text", item.name)}`);
			continue;
		}
		const body = expanded ? item.text : item.text.split("\n").slice(0, RESULT_TEXT_LINES).join("\n");
		for (const line of body.split("\n")) lines.push(theme.fg("text", line));
	}
	return lines;
}

/**
 * 过程项 = 只取工具调用。
 *
 * messages 里的 text 片段已经作为「结论」显示过了，展开时再铺一遍就会在同一个块里
 * 出现两遍同样的文字。
 */
export function processItems(items: readonly DisplayItem[]): DisplayItem[] {
	return items.filter((item) => item.type === "toolCall");
}
