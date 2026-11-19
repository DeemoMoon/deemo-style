/**
 * 十五、子代理面板（subagent 工具：single / parallel / chain）
 *
 * subagent 是 pi 自带扩展注册的工具，默认渲染是「✓✗⏳ + ─── Step ─── 分隔线」
 * 那套；这里把它收进本扩展的统一视觉：Nerd Font 图标 + 着色标题 + ⎿ 连接的
 * 滚动窗口 + BlockClock 计时，与工具面板 / 思考块 / `!` 命令同列同风格。
 *
 * 纯函数与数据形状在 `subagent-data.ts`（可单测，不依赖组件）。
 *
 * 三个渲染槽位各管一段（pi 里 call 区与 result 区是两个独立子组件，两边都画
 * 标题就会出现两份，所以分工必须清楚）：
 *
 *   renderCall —— 参数流式期间还没有 details，只出标题骨架。
 *
 *   renderResult + isPartial —— 「运行中块」，数据来自 onUpdate 推的 partial
 *   result。**只有这个分支能拿到 details**（renderCall 的 context 里没有）。
 *
 *     单个：**不做两级结构**，一个标题 + 滚动内容 + 底行就够了：
 *       \uF4BE 子代理 · scout · ⏱ 8.2s
 *         ⎿  在 /home/... 列出所有 .ts 文件...
 *             → ls
 *             → bash
 *             18.4k · 1.3k · claude-sonnet-4 · high · 45.5%
 *
 *     并行 / 链式：多个子代理必须分组，每个一块（标题 + 4 行 + 底行）：
 *       \uEE0D 子代理 · 并行 · 8 个任务 · ⏱ 总耗时
 *         ⎿  \uF4BE ✓ reviewer · ⏱ 3.1s
 *         ⎿  ...
 *            底行
 *         ⎿  \uF4BE ⏳ worker · ⏱ 2.4s
 *         ...
 *
 *   renderResult + !isPartial —— 「折叠摘要」：
 *     单个：\uF4BE ✓ 名称 [状态] + 错误行 + 最后 10 项（text 只取前 3 行）
 *           + (Ctrl+O to expand) + 底行
 *     并行：状态行（2/4 完成, 1 运行, 1 待处理）+ 每个任务 ─── 名称 ✓ + 5 项 + Total
 *     链式：同上，任务行带 Step 编号
 */

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	BAD_RED,
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	formatTokens,
	getTimerState,
	OK_GREEN,
	PREVIEW_CONNECTOR_REST,
	RESET_FG,
	sgr,
	touchClock,
	UI_INDENT,
	WARN_YELLOW,
} from "./core.ts";
import { hitRateMuted } from "./context-bar.ts";
import type {
	RenderResultOptionsLike,
	Rgb,
	ThemeLike,
	ToolRenderContextLike,
	ToolResultLike,
} from "./core.ts";
import {
	cacheHitRate,
	isChildActive,
	statusMark,
	totalUsage,
	titleFromArgs,
} from "./subagent-data.ts";
import type {
	SubagentChildLike,
	SubagentDetailsLike,
	SubagentPanelState,
} from "./subagent-data.ts";

// 纯函数与形状对外统一从本模块转发，调用方只认一个入口（与 core → path-text 同做法）。
export * from "./subagent-data.ts";
export * from "./subagent-block.ts";

import {
	AgentBlockView,
	BLANK_CONNECTOR,
	CHILD_NEST,
	taskLines,
} from "./subagent-block.ts";

/**
 * 进度点：只有两种字形，靠颜色区分四种状态。
 *
 *   未完成：`○`（空心）—— 未开始=灰、执行中=黄
 *   已完成：`●`（实心）—— 成功=绿、失败=红
 *
 * 为什么不用 `◑`（半实心）表示执行中：它是"半填充"的另一种笔画结构，视觉比
 * `●`/`○` 更粗更大（用户直接反馈"◑ 比 ○ 和 ● 大"）。只用同一套圆形的空/实两态，
 * 四个状态的字重就完全一致，状态差异全靠颜色表达。
 *
 * 四个字形都是 1 列宽（非 emoji），所以 DOT_CELL_WIDTH = 1，不需要补空格。
 */
const DOT_FILLED = "●";
const DOT_HOLLOW = "○";
/** 每个进度点占的列数（取最宽字形的宽度；当前两种字形都是 1 列）。 */
const DOT_CELL_WIDTH = 1;
/** 未开始点的颜色（暗灰，别和绿/黄抢视线）。 */
const DOT_PENDING_RGB: Rgb = [110, 110, 110];

/**
 * 固定窗口：一次最多显示几个子代理块，其余靠轮播。
 *
 * 8 个任务时每块 4~5 行，全铺出来 40 行，把整屏都占了。改成窗口 3 块 + 轮播：
 * 高度恒定、能挨个看到每个子代理，完整列表按 Ctrl+O 展开。
 */
const CHILD_WINDOW = 3;
/**
 * 轮播间隔（毫秒）：每隔这么久往后挪一个块。
 *
 * 相位由 `Date.now()` 算（纯函数）：**本模块不持有任何定时器**。
 * 推动它的是 pi 自己的帧（运行中 working spinner 每 80ms 重绘一次，子代理的
 * partial result 也会持续触发重绘），所以轮播是"搭车"而不是"自己踩油门"。
 *
 * 早期版本为此起过一个 2.5s 的定时器，结果 8 个任务时每隔 2.5s 就强制整屏
 * 重渲染一次，屏幕上会"闪一下"；去掉后不再有不必要的重画。
 */
const CHILD_ROTATE_MS = 2500;

/**
 * 选出当前要显示的块（纯函数，便于单测）。
 *
 * - 展开态 / 总数 ≤ 窗口：全部显示
 * - 运行中：从 `floor(now / CHILD_ROTATE_MS) % total` 开始取 3 块（可环绕）
 * - 运行结束：固定在**第一屏**（offset = 0），不再随渲染时间变化
 */
export function windowedChildren<T>(
	children: readonly T[],
	expanded: boolean,
	/** 只有运行中才轮播；结束后固定在窗口起点（不再动，避免读历史时被拽动）。 */
	running: boolean,
	now = Date.now(),
): { visible: T[]; hidden: number; indices: number[] } {
	if (expanded || children.length <= CHILD_WINDOW) {
		return {
			visible: [...children],
			hidden: 0,
			indices: children.map((_item, index) => index),
		};
	}
	const offset = running ? Math.floor(now / CHILD_ROTATE_MS) % children.length : 0;
	const visible: T[] = [];
	const indices: number[] = [];
	for (let i = 0; i < CHILD_WINDOW; i++) {
		const index = (offset + i) % children.length;
		indices.push(index);
		visible.push(children[index]!);
	}
	return { visible, hidden: children.length - CHILD_WINDOW, indices };
}

/**
 * 链式只看"当前这一步"：正在跑的那步优先，否则第一个待处理，都结束了显示最后一步。
 *
 * 链式是严格串行的，同时只有一步在动；把 3 步全铺出来只是重复历史（而且每步任务里
 * 还塞着上一步的完整输出）。只显示当前步 → 高度恒定、注意力集中在正在发生的事上。
 */
export function chainWindowChildren<T extends { status: string }>(
	children: readonly T[],
	expanded: boolean,
): { indices: number[]; hidden: number } {
	if (expanded || children.length <= 1) {
		return { indices: children.map((_item, index) => index), hidden: 0 };
	}
	const running = children.findIndex((child) => child.status === "running");
	if (running >= 0) return { indices: [running], hidden: children.length - 1 };
	const pending = children.findIndex((child) => child.status === "pending");
	if (pending >= 0) return { indices: [pending], hidden: children.length - 1 };
	// 全部结束：显示最后一步（它的结论就是返回给主 agent 的最终结果）
	return { indices: [children.length - 1], hidden: children.length - 1 };
}

/**
 * 渲染窗口内的块，并**把每块补齐到同一高度**。
 *
 * 为什么必须补齐：轮播时窗口里的块是变动的（这次成功块高、下次失败块矮），
 * 总行数在 15~18 之间来回跳，pi 的 ScrollView 按总高度排版，于是每 1.5 秒整屏
 * 就往上/往下顶一次——表现就是"消息窗口自己乱跳"。
 *
 * 补齐高度取**全部子代理里的最高块**（不是当前窗口内的最高块）：后者会随相位
 * 变化，补了也还是跳；取全体最大值在数据不变时是常量，窗口总高因此恒定。
 */
function renderPaddedWindow(options: {
	children: readonly SubagentChildLike[];
	indices: readonly number[];
	build: (child: SubagentChildLike) => string[];
	/** 是否需要等高（轮播时才需要；一次性铺全部时不必） */
	pad: boolean;
}): string[] {
	const { children, indices, build, pad } = options;
	if (!pad) {
		const lines: string[] = [];
		for (const index of indices) lines.push(...build(children[index]!));
		return lines;
	}
	const built = children.map((child) => build(child));
	const maxHeight = built.reduce((max, lines) => Math.max(max, lines.length), 0);
	const lines: string[] = [];
	for (const index of indices) {
		const blockLines = built[index] ?? [];
		lines.push(...blockLines);
		for (let i = blockLines.length; i < maxHeight; i++) lines.push("");
	}
	return lines;
}

/**
 * 块顶部那一行「进度 + 汇总」。
 *
 * 运行中：`●●○ 1 运行中, 1 待处理`（token 还在涨，写进来会一直跳，所以不写）
 * 完成态：`●●● 3/3 完成 · in 55k · out 3.9k · cache 62.1%`
 *         —— 汇总并进这一行，所以**不需要单独的 Total 行了**。
 */
function statusLine(
	results: readonly SubagentChildLike[],
	mode: SubagentDetailsLike["mode"],
	running: boolean,
	/**
	 * 计划里的总数量（链式用 `args.chain.length`）。
	 *
	 * 链式的 details.results 是**执行一步长一个**的，如果只看 results，进度点就会
	 * 一个一个冒出来；这里按计划总数画满，未开始的补成 `○`，一眼就能看到"一共几步"。
	 */
	expectedTotal?: number,
): string {
	const chain = mode === "chain";
	const active = results.some(isChildActive);
	const total = Math.max(results.length, expectedTotal ?? 0);
	const notStarted = Math.max(0, total - results.length);
	const done = results.filter((child) => child.status === "completed").length;
	const failed = results.filter(
		(child) => child.status === "failed" || child.status === "aborted",
	).length;

	// 进度点：实心 ● = 已结束（绿=成功 / 红=失败），空心 ○ = 未结束（黄=执行中 / 灰=未开始）。
	// 每个点补齐到 DOT_CELL_WIDTH 列 + 点间一个空格：四个字形都是 1 列，补齐是
	// 空操作，但保留这层，将来换字形（比如又引入 2 列宽的符号）时点位仍然不抖。
	const dots = [...results, ...Array.from({ length: notStarted }, () => undefined)]
		.map((child) => {
			const done = child?.status === "completed";
			const bad = child?.status === "failed" || child?.status === "aborted";
			const runningNow = child?.status === "running";
			// 空心 = 未完成，实心 = 已完成；颜色再区分"进行中 / 成功 / 失败"。
			const glyph = done || bad ? DOT_FILLED : DOT_HOLLOW;
			const rgb = done ? OK_GREEN : bad ? BAD_RED : runningNow ? WARN_YELLOW : DOT_PENDING_RGB;
			const pad = Math.max(0, DOT_CELL_WIDTH - visibleWidth(glyph));
			return `${sgr(rgb)}${glyph}${" ".repeat(pad)}${RESET_FG}`;
		})
		.join(" ");

	let text: string;
	if (running || active) {
		const runningCount = results.filter((child) => child.status === "running").length;
		const pendingCount =
			results.filter((child) => child.status === "pending").length + notStarted;
		const parts: string[] = [];
		if (runningCount > 0) parts.push(`${runningCount} 运行中`);
		if (pendingCount > 0) parts.push(`${pendingCount} 待处理`);
		if (failed > 0) parts.push(`${failed} 失败`);
		text = `${dots}${parts.length > 0 ? ` ${parts.join(", ")}` : ""}`;
	} else {
		const head = chain ? `${done}/${total} 步完成` : `${done}/${total} 完成`;
		const usage = totalUsage(results);
		const rate = cacheHitRate(usage);
		// 命中率着色规则与各块底行完全一致（hitRateMuted：越高越好），
		// 别在这里另写一套阈值，否则同一屏会出现两种"绿"。
		const rateText =
			rate === undefined ? "--" : `${sgr(hitRateMuted(rate))}${rate.toFixed(1)}%${RESET_FG}`;
		text =
			`${dots} ${head}` +
			(failed > 0 ? ` · ${failed} 失败` : "") +
			` · in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)}` +
			` · cache ${rateText}`;
	}
	return `${UI_INDENT}${BLANK_CONNECTOR}${BOLD_ON}${text}${BOLD_OFF}${RESET_FG}`;
}

// ---- 基础视图 ---------------------------------------------------------------

/** 单行视图：按宽度**截断**（不是换行），用于退化路径。 */
class LineView extends CachedView {
	private readonly content: () => string;

	constructor(content: () => string) {
		super();
		this.content = content;
	}

	protected override cacheKey(): string {
		return this.content();
	}

	protected renderLines(width: number): string[] {
		return [truncateToWidth(this.content(), Math.max(1, width), "…")];
	}
}

/**
 * 标题 + 任务描述。
 *
 * 任务描述**换行而不是截断**：它是"这块在做什么"的唯一线索，被截掉半句就没用了。
 * 首行用 ⎿ 连接，后续行用等宽续行前缀，所以换行后仍然对齐。
 *
 * 两个 getter 都是**惰性**求值：pi 的 updateDisplay 会先调 renderCall、再调
 * renderResult，状态标记由后者写入 state；如果标题在构造时就把状态取出来，
 * 就会永远读到上一帧的旧状态（跑完还显示"执行中"）。
 */
class HeaderView extends CachedView {
	private readonly title: () => string;
	private readonly task: () => string | undefined;

	constructor(title: () => string, task: () => string | undefined) {
		super();
		this.title = title;
		this.task = task;
	}

	protected override cacheKey(): string {
		return `${this.title()}\u0000${this.task() ?? ""}`;
	}

	protected renderLines(width: number): string[] {
		const lines = [truncateToWidth(this.title(), Math.max(1, width), "…")];
		const task = this.task();
		if (task === undefined) return lines;
		// 任务行与块内任务共用同一套实现（「」包裹 + 黄色 + 续行对齐 + 压空行），
		// 别在这里再抄一遍——以前两份实现漂过一次（宽度预算漏扣 1 列）。
		lines.push(...taskLines(task, width));
		return lines;
	}
}

// ---- 运行中：整块（并行 / 链式） --------------------------------------------

class MultiAgentView extends CachedView {
	private readonly details: SubagentDetailsLike;
	private readonly state: SubagentPanelState;
	private readonly theme: ThemeLike;
	private readonly running: boolean;
	/** 计划里的总数量（链式从 args.chain.length 来）。 */
	private readonly expectedTotal: number | undefined;

	constructor(
		details: SubagentDetailsLike,
		state: SubagentPanelState,
		theme: ThemeLike,
		running: boolean,
		expectedTotal?: number,
	) {
		super();
		this.details = details;
		this.state = state;
		this.theme = theme;
		this.running = running;
		this.expectedTotal = expectedTotal;
	}

	protected override cacheKey(): string {
		const sig = this.details.results
			.map((child) => `${child.status}:${child.usage.input}:${child.usage.output}`)
			.join(",");
		// 轮播相位也进缓存键（仅运行中），否则窗口停在第一屏不动
		const phase = this.running ? Math.floor(Date.now() / CHILD_ROTATE_MS) : 0;
		return `${this.details.mode}:${sig}:${phase}:${this.running ? Math.floor(Date.now() / 50) : 0}`;
	}

	protected renderLines(width: number): string[] {
		// 外层标题由 renderCall 负责（模式/任务数）；这里先给一行进度，再铺窗口内的块。
		const lines: string[] = [
			statusLine(this.details.results, this.details.mode, this.running, this.expectedTotal),
		];
		const selection =
			this.details.mode === "chain"
				? chainWindowChildren(this.details.results, false)
				: windowedChildren(this.details.results, false, this.running);
		const { hidden, indices } = selection;
		lines.push(
			...renderPaddedWindow({
				children: this.details.results,
				indices,
				// 链式只显示 1 块、不轮播：补齐没有意义（而且会把"最高的那一步"的高度
				// 套到当前步上，补出一大片空白）。切换步骤时的高度变化是预期内的。
				pad: hidden > 0 && this.details.mode !== "chain",
				build: (child) =>
					new AgentBlockView({
						child,
						state: this.state,
						theme: this.theme,
						running: this.running && isChildActive(child),
						expanded: false,
						showTitle: true,
						nest: CHILD_NEST,
					}).render(width),
			}),
		);
		if (hidden > 0) {
			lines.push(
				`${UI_INDENT}${CHILD_NEST}${PREVIEW_CONNECTOR_REST}${this.theme.fg(
					"muted",
					this.details.mode === "chain"
						? `… 还有 ${hidden} 步（Ctrl+O 展开全部）`
						: `… 还有 ${hidden} 个子代理（循环显示，Ctrl+O 展开全部）`,
				)}`,
			);
		}
		return lines;
	}
}

class SubagentResultView extends CachedView {
	private readonly details: SubagentDetailsLike;
	private readonly theme: ThemeLike;
	private readonly expanded: boolean;
	private readonly state: SubagentPanelState;
	/** 返回给主 agent 的结论（`result.content`，单个模式的权威来源）。 */
	private readonly resultText: string;
	private readonly expectedTotal: number | undefined;

	constructor(
		details: SubagentDetailsLike,
		theme: ThemeLike,
		expanded: boolean,
		state: SubagentPanelState,
		resultText: string,
		expectedTotal?: number,
	) {
		super();
		this.details = details;
		this.theme = theme;
		this.expanded = expanded;
		this.state = state;
		this.resultText = resultText;
		this.expectedTotal = expectedTotal;
	}

	protected override cacheKey(): string {
		return [
			this.details.mode,
			this.expanded ? 1 : 0,
			this.details.results
				.map((child) => `${child.status}:${child.usage.input}:${child.usage.output}`)
				.join(","),
			this.resultText.length,
			// 结束态不轮播，相位恒为 0
			0,
		].join("\u0000");
	}

	protected renderLines(width: number): string[] {
		return this.details.mode === "single" ? this.singleLines(width) : this.multiLines(width);
	}

	/**
	 * 单个：结论 + 过程摘要 + 底行（任务行与标题由 renderCall 负责）。
	 *
	 * 和并行/链式里的每一块是**同一个渲染器**（AgentBlockView），只是这里
	 * showTitle=false、结论来自 result.content。
	 */
	private singleLines(width: number): string[] {
		return new AgentBlockView({
			child: this.details.results[0]!,
			state: this.state,
			theme: this.theme,
			running: false,
			expanded: this.expanded,
			showTitle: false,
			showTask: false,
			resultText: this.resultText,
		}).render(width);
	}

	/**
	 * 并行 / 链式：状态行 + 每个子代理一块（与单个同款）+ Total。
	 *
	 * 每块自带标题（`\uF4BE 名称 · ⏱ 耗时 · ✓`），所以不再需要 `───` 分隔线
	 * ——那套是 pi 默认渲染的视觉，和这里的 Nerd Font 块不搭。
	 */
	private multiLines(width: number): string[] {
		const theme = this.theme;
		const results = this.details.results;

		// 进度 + 用量合并成一行（替代以前的独立 Total 行）
		const lines = [statusLine(results, this.details.mode, false, this.expectedTotal)];

		// 窗口化 + 等高补齐（轮播时总高度恒定，避免整屏跳动）。
		const selection =
			this.details.mode === "chain"
				? chainWindowChildren(results, this.expanded)
				: windowedChildren(results, this.expanded, false);
		const { hidden, indices } = selection;
		lines.push(
			...renderPaddedWindow({
				children: results,
				indices,
				pad: hidden > 0 && this.details.mode !== "chain",
				build: (child) =>
					new AgentBlockView({
						child,
						state: this.state,
						theme,
						running: false,
						expanded: this.expanded,
						showTitle: true,
						nest: CHILD_NEST,
					}).render(width),
			}),
		);
		if (hidden > 0) {
			lines.push(
				`${UI_INDENT}${CHILD_NEST}${PREVIEW_CONNECTOR_REST}${theme.fg(
					"muted",
					this.details.mode === "chain"
						? `… 还有 ${hidden} 步（Ctrl+O 展开全部）`
						: `… 还有 ${hidden} 个子代理（Ctrl+O 展开全部）`,
				)}`,
			);
		}

		if (!this.expanded) {
			lines.push(
				`${UI_INDENT}${PREVIEW_CONNECTOR_REST}${theme.fg("muted", "(Ctrl+O to expand)")}`,
			);
		}
		return lines;
	}
}

// ---- 渲染器入口 -------------------------------------------------------------

/** 链式计划里的总步数（`args.chain.length`）；其它模式返回 undefined。 */
function chainTotalFromArgs(args: unknown): number | undefined {
	const chain = (args as { chain?: unknown } | undefined)?.chain;
	return Array.isArray(chain) && chain.length > 0 ? chain.length : undefined;
}

function detailsOf(result: ToolResultLike): SubagentDetailsLike | undefined {
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const candidate = details as SubagentDetailsLike;
	if (!Array.isArray(candidate.results) || candidate.results.length === 0) return undefined;
	return candidate;
}

/** 结果文本（details 缺失时的退化路径）。 */
function resultText(result: ToolResultLike): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

/** subagent 面板（single / parallel / chain 统一入口）。 */
export function subagentPanel(): {
	renderShell: "self";
	renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike): Component;
	renderResult(
		result: ToolResultLike,
		options: RenderResultOptionsLike,
		theme: Theme,
		context: ToolRenderContextLike,
	): Component;
} {
	return {
		renderShell: "self" as const,

		renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike): Component {
			const state = getTimerState(context) as SubagentPanelState;
			// 用 context.isPartial 而不是写死 true：结束后 renderCall 仍会重渲染，
			// 写死 true 会让标题永远扫光、耗时一直往上涨。
			touchClock(state, context.isPartial);
			// 参数流式期间还没有 details：标题（模式与数量从 args 取）+ 任务行。
			// 任务也是一行，所以这里返回两行的视图。
			// 状态标记必须**惰性**读 state：pi 的 updateDisplay 先调 renderCall 再调
			// renderResult，后者才把这一帧的状态写进 state.mark。构造时就取会永远
			// 慢一帧（跑完还显示"执行中"）。
			return new HeaderView(
				() => {
					const mark = state.mark ?? { kind: context.isPartial ? "running" : "ok" };
					return `${UI_INDENT}${titleFromArgs(args, state, context.isPartial, mark as never)}`;
				},
				() => {
					const task = (args as { task?: unknown } | undefined)?.task;
					return typeof task === "string" && task.trim() ? task : undefined;
				},
			);
		},

		renderResult(
			result: ToolResultLike,
			options: RenderResultOptionsLike,
			theme: Theme,
			context: ToolRenderContextLike,
		): Component {
			const state = getTimerState(context) as SubagentPanelState;
			touchClock(state, options.isPartial);
			const details = detailsOf(result);
			// 链式的 details.results 是逐步增长的；计划里的总步数只有 args 知道。
			const expectedTotal = chainTotalFromArgs(context.args);
			if (!details) {
				// 异常路径（没有 details）：退化成一行文本，不把块打没。
				return new LineView(
					() => `${UI_INDENT}${theme.fg("text", resultText(result) || "(无输出)")}`,
				);
			}
			// 把状态缓存下来：renderCall 拿不到 details，标题行尾的 ✓/✗/󰈑 靠它。
			state.mark = statusMark(details.results, options.isPartial);
			if (options.isPartial) {
				// 运行中：单个走扁平块（标题在 renderCall 里，这里不重复画）；
				// 并行/链式每个子代理一块，块内自带标题。
				if (details.mode === "single" && details.results.length === 1) {
					return new AgentBlockView({
						child: details.results[0]!,
						state,
						theme,
						running: true,
						expanded: false,
						showTitle: false,
						showTask: false,
					});
				}
				return new MultiAgentView(details, state, theme, true, expectedTotal);
			}
			// 结束后：折叠摘要。
			return new SubagentResultView(
				details,
				theme,
				options.expanded,
				state,
				resultText(result),
				expectedTotal,
			);
		},
	};
}

/** 注册 subagent 面板渲染器（只有 subagent 命中，其余交还 pi）。 */
export function registerSubagentPanel(pi: ExtensionAPI): void {
	// 拿 TUI 引用（借 0 高度 widget），会话结束/重载时停掉轮播。
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "subagent") return next();
		return subagentPanel();
	});
}
