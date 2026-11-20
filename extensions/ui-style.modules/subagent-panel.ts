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

import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	BAD_RED,
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	cleanText,
	clockText,
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
import { hitRateText } from "./context-bar.ts";
import { captureOverlayUi, showChildResultOverlay } from "./subagent-result-overlay.ts";
import type {
	RenderResultOptionsLike,
	Rgb,
	ThemeLike,
	ToolRenderContextLike,
	ToolResultLike,
} from "./core.ts";
import {
	cacheHitRate,
	childActivityText,
	childKey,
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
	childClock,
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
 * 固定窗口：一次最多显示几个子代理块，其余折叠成「还有 N 个」。
 *
 * **不轮播**：早期做过"每 2.5s 往后挪一格"，但每换一屏窗口内容整体变一次、屏幕
 * 跟着重排（等高补齐也挡不住），读起来很吵。现在固定显示**前 N 个**，其余按
 * Ctrl+O 展开。
 */
const CHILD_WINDOW = 3;
/** 并行块里"执行内容"窗口的行数（一屏要放 3 块，所以比单个/链式矮）。 */
const PARALLEL_TAIL_LINES = 2;

/**
 * 选出当前要显示的块（纯函数，便于单测）。
 *
 * - 展开态 / 总数 ≤ 窗口：全部显示
 * - 否则：**前 N 个**（不再随时间轮播）
 */
export function windowedChildren<T>(
	children: readonly T[],
	expanded: boolean,
): { visible: T[]; hidden: number; indices: number[] } {
	if (expanded || children.length <= CHILD_WINDOW) {
		return {
			visible: [...children],
			hidden: 0,
			indices: children.map((_item, index) => index),
		};
	}
	const visible = children.slice(0, CHILD_WINDOW);
	return {
		visible,
		hidden: children.length - CHILD_WINDOW,
		indices: visible.map((_item, index) => index),
	};
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
 * 渲染窗口内的块（带内容签名缓存）。
 *
 * 缓存只为"别每帧重渲全部块"：8 个任务时旧实现要把 8 块都渲染一遍（只为显示 3 个），
 * 现在签名命中直接复用上次的行。签名覆盖宽度、展开态、状态、用量、消息条数与 model，
 * 流式中只有正在跑的那个块会失效。
 *
 * **不再做等高补齐**：窗口固定（前 3 个）、每块高度在流式中基本恒定，补齐只剩副作用
 * （把"最高的那一块"的高度套到别的块上，补出大片空白）。
 */
function renderCachedBlocks(options: {
	state: SubagentPanelState;
	children: readonly SubagentChildLike[];
	indices: readonly number[];
	build: (child: SubagentChildLike, index: number) => string[];
	/** 缓存签名里要带上的额外状态（展开态等）。 */
	extra: string;
	width: number;
}): string[] {
	const { state, children, indices, build, extra, width } = options;
	state.blockCache ??= new Map<string, { signature: string; lines: string[] }>();

	const renderOne = (index: number): string[] => {
		const child = children[index]!;
		const signature = [
			width,
			extra,
			child.status,
			child.usage.input,
			child.usage.output,
			child.messages.length,
			childActivityText(child.messages).length,
			// model 也进签名：底行用 childModel()，若 pi 之后才补写 details.model，
			// 不带它就会命中旧缓存、底行永久缺模型名。
			child.model ?? "",
		].join("\u0000");
		const cached = state.blockCache!.get(childKey(index));
		if (cached !== undefined && cached.signature === signature) return cached.lines;
		const lines = build(child, index);
		state.blockCache!.set(childKey(index), { signature, lines });
		return lines;
	};

	const lines: string[] = [];
	for (const index of indices) lines.push(...renderOne(index));
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
		// 命中率文案与各块底行共用 hitRateText（避免同一屏出现两种"绿"）。
		const rateText = hitRateText(cacheHitRate(usage));
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
	/**
	 * 展开态（Ctrl+O **或鼠标点击**都会让 pi 调 setExpanded → 这里拿到 true）。
	 *
	 * 运行中也要响应：以前这里写死 false，所以点击/快捷键都没反应，只有结束后展开
	 * 才看得出来。展开后显示全部子代理（不再折叠成「还有 N 个」），执行窗口也放宽。
	 */
	private readonly expanded: boolean;

	constructor(
		details: SubagentDetailsLike,
		state: SubagentPanelState,
		theme: ThemeLike,
		running: boolean,
		expectedTotal?: number,
		expanded = false,
	) {
		super();
		this.details = details;
		this.state = state;
		this.theme = theme;
		this.running = running;
		this.expectedTotal = expectedTotal;
		this.expanded = expanded;
	}

	protected override cacheKey(): string {
		const sig = this.details.results
			.map((child) => `${child.status}:${child.usage.input}:${child.usage.output}`)
			.join(",");
		// 运行中带 50ms 帧号（扫光/耗时需要重画）；窗口已固定，不需要相位。
		return `${this.details.mode}:${sig}:${this.expanded ? 1 : 0}:${this.running ? Math.floor(Date.now() / 50) : 0}`;
	}

	protected renderLines(width: number): string[] {
		// 外层标题由 renderCall 负责（模式/任务数）；这里先给一行进度，再铺窗口内的块。
		const lines: string[] = [
			statusLine(this.details.results, this.details.mode, this.running, this.expectedTotal),
		];
		const selection =
			this.details.mode === "chain"
				? chainWindowChildren(this.details.results, false)
				: windowedChildren(this.details.results, this.expanded);
		const { hidden, indices } = selection;
		const blockLines: string[] = [];
		lines.push(
			...renderCachedBlocks({
				state: this.state,
				children: this.details.results,
				indices,
				extra: `run:${this.running ? 1 : 0}`,
				width,
				build: (child, index) =>
					new AgentBlockView({
						child,
						state: this.state,
						theme: this.theme,
						running: this.running && isChildActive(child),
						expanded: false,
						showTitle: true,
						nest: CHILD_NEST,
						index,
						// 并行块一屏要放 3 个，执行内容只留 2 行（展开态放宽到 4 行）；
						// 单个/链式保持 4 行。
						tailLines:
							this.details.mode === "parallel" && !this.expanded
								? PARALLEL_TAIL_LINES
								: undefined,
					}).render(width),
			}),
		);
		if (hidden > 0) {
			lines.push(
				`${UI_INDENT}${CHILD_NEST}${PREVIEW_CONNECTOR_REST}${this.theme.fg(
					"muted",
					this.details.mode === "chain"
						? `… 还有 ${hidden} 步（Ctrl+O 展开全部）`
						: `… 还有 ${hidden} 个子代理（Ctrl+O 展开全部）`,
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
	/**
	 * 上一次 render 时每个子代理块占的行区间（相对本组件的 y）。
	 *
	 * 用来把点击坐标映射到"点了哪个子代理"，然后弹只读结果窗。
	 * render 每帧都会重算，所以 handleMouse 用到的永远是"屏幕上那一份"布局。
	 */
	private blockRanges: Array<{ index: number; start: number; end: number }> = [];

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
			index: 0,
		}).render(width);
	}

	/**
	 * 点击某个子代理块 → 弹只读结果窗（只显示它返回给主 agent 的结论）。
	 *
	 * pi 的 `MouseRegion.handleMouse` 会先把事件转发给子组件，所以这里能抢在
	 * pi 的"点击展开/收起"之前拿到点击；返回 `{ handled: true }` 就不再冒泡。
	 * 滚轮不拦（`return undefined`），让 pi 正常滚动 transcript。
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") return undefined;
		if (event.type !== "press" && event.type !== "click") return undefined;
		if (event.button !== "left") return undefined;
		const hit = this.blockRanges.find(
			(range) => event.y >= range.start && event.y < range.end,
		);
		if (hit === undefined) return undefined;
		const child = this.details.results[hit.index];
		if (child === undefined) return undefined;
		void showChildResultOverlay(child, clockText(childClock(this.state, child, hit.index)));
		return { handled: true };
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

		// 窗口化（固定前 3 个 / 展开全部）。
		const selection =
			this.details.mode === "chain"
				? chainWindowChildren(results, this.expanded)
				: windowedChildren(results, this.expanded);
		const { hidden, indices } = selection;
		// 先逐块渲染并记录行区间（供 handleMouse 判断"点了哪个子代理"）。
		this.blockRanges = [];
		let cursor = lines.length;
		for (const index of indices) {
			const blockLines = renderCachedBlocks({
				state: this.state,
				children: results,
				indices: [index],
				extra: `done:${this.expanded ? 1 : 0}`,
				width,
				build: (child, childIndex) =>
					new AgentBlockView({
						child,
						state: this.state,
						theme,
						running: false,
						expanded: this.expanded,
						showTitle: true,
						nest: CHILD_NEST,
						index: childIndex,
					}).render(width),
			});
			lines.push(...blockLines);
			this.blockRanges.push({ index, start: cursor, end: cursor + blockLines.length });
			cursor += blockLines.length;
		}
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

/**
 * 结果文本（`result.content`）。
 *
 * 用 `cleanText` 与工具面板的 `resultOutput()` 保持同一清洗口径（去 ANSI / 归一
 * 换行 / 制表符展开）；细节是这里**不**裁剪尾部空行，结论的段落结构要留着。
 */
function resultText(result: ToolResultLike): string {
	return cleanText(
		result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	).trim();
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
					return `${UI_INDENT}${titleFromArgs(args, state, context.isPartial, mark)}`;
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
						index: 0,
					});
				}
				return new MultiAgentView(
					details,
					state,
					theme,
					true,
					expectedTotal,
					options.expanded,
				);
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
	// 结果弹窗要用 ctx.ui.custom，而渲染器里拿不到 ctx —— 在事件里存一份引用。
	captureOverlayUi(pi);
	// 拿 TUI 引用（借 0 高度 widget），会话结束/重载时停掉轮播。
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "subagent") return next();
		return subagentPanel();
	});
}
