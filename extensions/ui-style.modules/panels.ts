/**
 * 四、工具面板（bash / codemode / read / write / edit / grep / find / ls / powershell）
 *
 * 统一视觉：Nerd Font 图标 + 着色工具名 + ⎿ 连接的折叠预览（ctrl+o 展开）、
 * 无状态背景色、块左边缘与助手图标同列。仅显示层，不影响会话内容。
 *
 * 计时口径：从块出现（参数开始流式）算到结果返回；历史块用 pi 持久化的
 * toolResult.durationMs 兜底，没有可信计时就不显示。
 */

import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	ACCENT_BLUE,
	ACCENT_CYAN,
	ACCENT_GREEN,
	ACCENT_VIOLET,
	BAD_RED,
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	cleanText,
	clockText,
	formatPanelDuration,
	getTimerState,
	ICON_BASH,
	ICON_CLOCK,
	ICON_EDIT,
	ICON_READ,
	ICON_SEARCH,
	ICON_WEB,
	ICON_WRITE,
	IndentedPreviewView,
	LiveTailView,
	MIN_EXEC_CLOCK_MS,
	newWindowSnapshot,
	normalizeNewlines,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	PREVIEW_CONNECTOR_WIDTH,
	RESET_FG,
	resultOutput,
	runningLine,
	setText,
	shimmerFrame,
	shimmerText,
	sgr,
	touchClock,
	UI_INDENT,
	UI_INDENT_WIDTH,
} from "./core.ts";
import type {
	KeyHintFn,
	RenderResultOptionsLike,
	WindowSnapshot,
	Rgb,
	ThemeLike,
	TimerState,
	ToolRenderContextLike,
	ToolResultLike,
} from "./core.ts";
import {
	colorizeDiffLine,
	computeEditPreview,
	getPreviewInput,
} from "./edit-preview.ts";

/** 工具框的内容高度（行）：运行中看过程、完成后看尾部，都不超过这个数。 */
const LIVE_PANEL_LINES = 3;
/**
 * web_search 的结果窗口行数。
 *
 * 比其它工具多给一行：搜索结果是一份"清单"（标题 + URL + 元信息 + 摘要），
 * 3 行连第一条都看不完整；4 行刚好能看到「标题 + URL + 元信息」。
 */
const SEARCH_WINDOW_LINES = 4;
/**
 * 标题行是否带 “· N 行”。
 * 想严格只留「图标 + 标题 + 时钟 + 耗时」就把这里改成 false。
 */
const SHOW_LINE_COUNT = true;
/**
 * 实时窗口最多往前取多少字符做清洗。
 * 50KB 是 pi 送给模型的默认输出上限；这里只取尾部 8KB，避免每个 partial 都
 * 全量 cleanText。
 */
const LIVE_TAIL_CHARS = 8 * 1024;

/** 面板渲染状态：计时 + 尾窗快照 + 完成后的行数。 */
type PanelState = TimerState & {
	/** 尾窗内容快照（跨帧保存；面板默认不启用节流快照）。 */
	window?: WindowSnapshot;
	/** 完成后结果体的行数（给标题行的 “· N 行”）。 */
	resultLines?: number;
	/** 运行中是否已经有实时内容（有的话标题下方就不再打“执行中...”）。 */
	liveOutput?: boolean;
};

/**
 * 取文本尾部并清洗；切点要落在完整行/完整转义序列上。
 *
 * 直接 `raw.slice()` 后 cleanText 可能把 `\x1b[38;2;...m` 切成半截：
 * ESC 被清掉、剩下的 `[38;2;...` 会作为可见文本闪一帧。优先从下一个换行开始；
 * 单行超长时至少回退到完整的 SGR 序列起点。
 */
function cleanedTailText(raw: string, limit: number): string {
	if (raw.length <= limit) return cleanText(raw).replace(/\n+$/, "");

	let start = raw.length - limit;
	const newline = raw.indexOf("\n", start);
	if (newline !== -1 && newline + 1 < raw.length) {
		// 从下一个完整行开始，避免把 SGR 序列切一半。
		// 注意 `newline + 1 === raw.length` 的情况：尾部只有一个换行（单行超长输出
		// + 末尾换行），切到这里会得到空串、面板显示「执行中...」——此时保持原切点。
		start = newline + 1;
	} else {
		// 单行文本：若切点落在一个 SGR 序列中间，回退到 ESC 起点。
		// 最多回扫 40 字符（最长 SGR 序列也就这么长）：超出一律当作不在
		// 序列中间，避免超长单行每次都在这里回扫整个 8KB 窗口。
		const escape = raw.lastIndexOf("\x1b", start);
		if (escape !== -1) {
			const end = raw.indexOf("m", escape);
			if (end === -1) {
				// 尾部整段都还在一个未终止的 SGR 里：没有可显示的正文。
				// 直接把 start 推到末尾，避免 cleanText 留下 `[38;2;…` 这种参数片段。
				start = raw.length;
			} else if (end >= start) {
				// 切点落在序列中间：回退到 ESC 起点；序列本身太长（>40 字符）时
				// 就跳到终止符之后，反正参数部分不是给人看的。
				start = escape >= start - 40 ? escape : end + 1;
			}
		}
	}
	return cleanText(raw.slice(start)).replace(/\n+$/, "");
}

/** partial 结果只取尾部一小段文本（省掉每次都对全量做 cleanText）。 */
function liveOutputText(result: ToolResultLike): string {
	// 从 content 尾部倒序累加：只收够清洗余量的那一段（LIVE_TAIL_CHARS * 2），
	// 而不是对全量做 filter+map+join——大输出下每个 partial 帧全量 join 太贵。
	let tail = "";
	const parts = result.content;
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i]!;
		if (part.type !== "text") continue;
		tail = tail === "" ? (part.text ?? "") : `${part.text ?? ""}\n${tail}`;
		if (tail.length >= LIVE_TAIL_CHARS * 2) break;
	}
	if (!tail) return "";
	return cleanedTailText(tail, LIVE_TAIL_CHARS);
}

/**
 * 面板标题的规格：所有工具面板（bash / codemode / read / write / edit /
 * grep / find / ls / powershell）共用同一张表。
 *
 * 标题行只放「图标 + 工具名 + 时钟 + 耗时（+ 行数）」，**不再带摘要**：
 * 参数摘要（命令、路径、+N -M）都收起了，内容统一从第二行开始缩进显示。
 */
export interface PanelHeaderSpec {
	icon: string;
	label: string;
	accent: Rgb;
	showClock: boolean;
	/**
	 * 运行中/完成后用不同标题（「搜索中」→「搜索结果」）。
	 *
	 * 为什么不用一个固定名字：搜索/抓取是少数"过程名和结果名本来就不一样"的工具，
	 * `bash`/`read` 那种「工具名 + 耗时」就够了。回放的历史块（startedAt 缺失）
	 * 一律按已完成显示，不会闪一下"XX中"。
	 */
	labelWhen?: { running: string; done: string };
}

/** 面板标题视图：图标 + 着色工具名 + 时钟 + 耗时；running 时附“执行中”行。 */
export class PanelHeaderView extends CachedView {
	private readonly spec: PanelHeaderSpec;
	/** 每次 render 调用：执行中直接算当前耗时，无需定时器推动。 */
	private readonly getDuration: () => string | undefined;
	/** 渲染状态：`startedAt`/`endedAt` 决定扫光与耗时，`resultLines` 给标题加 “· N 行”。 */
	private readonly state: PanelState;
	/**
	 * 扫光条件 = 时钟还活着（块已出现且尚未结束）。
	 *
	 * **不能**用 `isPartial && executionStarted`：`executionStarted` 要等参数流式
	 * 结束、工具真正开跑才为 true（edit/write 的大参数要流几秒），那样扫光会比块
	 * 出现晚两三秒才亮。计时口径本来就是「从块出现算起」，扫光跟它一致。
	 */
	private readonly animating: boolean;
	private readonly running: boolean;
	private readonly theme: ThemeLike;
	/** cacheKey() 里现算、renderLines() 里复用，避免一帧内取两次时间。 */
	private currentDuration?: string;
	private currentFrame = 0;

	constructor(
		spec: PanelHeaderSpec,
		getDuration: () => string | undefined,
		state: PanelState,
		running: boolean,
		theme: ThemeLike,
	) {
		super();
		this.spec = spec;
		this.getDuration = getDuration;
		this.state = state;
		this.animating = state.startedAt !== undefined && state.endedAt === undefined;
		this.running = running;
		this.theme = theme;
	}

	/**
	 * 缓存键：running 状态 + 当前耗时 + 扫光相位。
	 *
	 * 耗时与相位都在这里现算：pi 的 requestRender（working spinner / 信息条 tick /
	 * 参数流式的 token 帧）会重新调用 render，因此数字跳动与标题扫光都靠已有帧带动，
	 * 块本身不需要定时器。
	 */
	protected override cacheKey(): string {
		this.currentDuration = this.spec.showClock ? this.getDuration() : undefined;
		this.currentFrame = this.animating ? shimmerFrame(this.state.startedAt) : 0;
		return [
			this.running ? 1 : 0,
			this.running && this.state.liveOutput !== true ? 1 : 0,
			this.animating ? 1 : 0,
			this.currentLabel(),
			this.currentDuration ?? "",
			this.currentFrame,
			this.lineCountText() ?? "",
		].join("\u0000");
	}

	/**
	 * 当前该显示哪个标题。
	 *
	 * `animating` = 块已出现且尚未结束（含参数流式阶段），比 `running`
	 * （= isPartial && executionStarted）更贴近"标题在扫光"的那个时刻，两者保持一致。
	 */
	private currentLabel(): string {
		const when = this.spec.labelWhen;
		if (when === undefined) return this.spec.label;
		return this.animating ? when.running : when.done;
	}

	/** 完成后的 “N 行”（运行中/无数据时不显示）。 */
	private lineCountText(): string | undefined {
		if (!SHOW_LINE_COUNT || this.animating) return undefined;
		const count = this.state.resultLines;
		return count !== undefined && count > 0 ? `${count} 行` : undefined;
	}

	protected renderLines(width: number): string[] {
		const duration = this.currentDuration;
		const accent = sgr(this.spec.accent);
		// 标题行：图标 + 工具名 + 时钟 + 耗时（+ 行数），没有摘要。
		// 整行一起扫光：亮带从图标一路扫到耗时，而不是只在工具名上跳。
		const { clock, lines } = this.layout(width, duration);
		const plain =
			`${this.spec.icon} ${this.currentLabel()}` +
			(clock !== undefined ? ` · ${ICON_CLOCK} ${clock}` : "") +
			(lines !== undefined ? ` · ${lines}` : "");
		const line = this.animating
			? `${BOLD_ON}${shimmerText(plain, this.spec.accent, this.state.startedAt)}${BOLD_OFF}${RESET_FG}`
			: `${accent}${BOLD_ON}${plain}${BOLD_OFF}${RESET_FG}`;
		// 已经有实时内容时，标题下面不再重复一行“执行中...”
		const showRunning = this.running && this.state.liveOutput !== true;
		return showRunning ? [UI_INDENT + line, UI_INDENT + runningLine(this.theme)] : [UI_INDENT + line];
	}

	/**
	 * 标题行的宽度分配：只分配「时钟 / 行数」这两个元数据。
	 *
	 * 降级顺序：耗时 + 行数 → 只耗时 → 都不要（只剩图标 + 工具名）。
	 * 绝不输出超宽行（pi 遇到宽于终端的行会直接报错停掉 TUI）。
	 */
	private layout(
		width: number,
		duration: string | undefined,
	): { clock: string | undefined; lines: string | undefined } {
		const avail = Math.max(0, width - UI_INDENT_WIDTH);
		const headWidth = visibleWidth(`${this.spec.icon} ${this.currentLabel()}`);
		const lineCount = this.lineCountText();

		const variants: Array<{ clock: string | undefined; lines: string | undefined }> = [
			{ clock: duration, lines: lineCount },
			{ clock: duration, lines: undefined },
			{ clock: undefined, lines: undefined },
		];
		const metaWidth = (variant: { clock: string | undefined; lines: string | undefined }): number =>
			(variant.clock !== undefined ? visibleWidth(` · ${ICON_CLOCK} ${variant.clock}`) : 0) +
			(variant.lines !== undefined ? visibleWidth(` · ${variant.lines}`) : 0);

		for (const variant of variants) {
			if (avail >= headWidth + metaWidth(variant)) return variant;
		}
		return { clock: undefined, lines: undefined };
	}
}

/**
 * 面板 renderCall 的计时入口（各面板共用）。
 *
 * 两件事必须成对做，所以合成一个函数：① 用这一帧的 isPartial 打点（活跃 =
 * 块还没结束，含参数流式阶段）；② 返回一个“渲染时现算”的耗时取值函数交给
 * PanelHeaderView——执行中每次 render 都重新算，数字随 pi 已有的帧跳动，
 * 块本身不持有定时器。
 *
 * 口径与思考块、`!` 命令一致：从块出现（参数开始流式）算到结果返回。
 * 这样 read/write/edit 这类只跑几毫秒的工具也能看到过程中跳字，而不是
 * 结束时突然蹦出一个 "17ms"；结束后就地定格，不会从 "12.4s" 跳回去。
 * 代价是 write/edit 大文件时耗时会包含模型生成参数的时间。
 *
 * 历史回放的块一直是结束态（startedAt 永远为 undefined），走 pi 持久化的
 * durationMs 兜底。
 */
function usePanelClock<T extends TimerState = TimerState>(
	context: ToolRenderContextLike,
): { state: T; getDuration: () => string | undefined } {
	const state = getTimerState(context) as T;
	touchClock(state, context.isPartial);
	return {
		state,
		getDuration: () => {
			const live = clockText(state);
			// 回放会话时 pi 会先用 isPartial=true 构造组件（此时我们开始计时），
			// 紧接着 updateResult 把它置为结束态——本地时钟只跨了 0~1ms。
			// 这种“一帧内跑完”不是真实耗时，优先使用 pi 持久化的 durationMs。
			if (
				!context.isPartial &&
				state.endedAt !== undefined &&
				state.endedAt - (state.startedAt ?? state.endedAt) < MIN_EXEC_CLOCK_MS &&
				context.durationMs !== undefined
			) {
				return formatPanelDuration(context.durationMs);
			}
			if (live !== undefined) return live;
			if (!context.isPartial && context.durationMs !== undefined) {
				return formatPanelDuration(context.durationMs);
			}
			return undefined;
		},
	};
}

// ---- write 面板的附加状态：被写入内容（惰性清洗一次） ----

interface WritePanelState extends PanelState {
	/** renderCall 里记下的原始 content（O(1) 存引用，不清洗）。 */
	rawContent?: string;
	/** 惰性清洗后的预览内容，只在第一次 renderResult 时计算一次。 */
	content?: string;
}

/** 被写入的内容作为正文预览：清掉 ANSI/制表符，并去掉行尾空行。 */
function writtenContent(content: unknown): string {
	if (typeof content !== "string") return "";
	return cleanText(content).replace(/\n+$/, "");
}


interface EditPanelState extends PanelState {
	/** 执行中的 diff 预览：参数完整后计算一次，args 变化时重置。 */
	previewDiff?: string;
	previewError?: string;
	/** 上一次预览基于的 args 对象（引用比较，避免每 token 序列化整段编辑内容）。 */
	previewArgsRef?: unknown;
	/** 预计算发起/完成标记：异步计算，跑完调 context.invalidate() 重绘。 */
	previewPending?: boolean;
	previewDone?: boolean;
	/** previewDiff 的按行缓存（renderCall 是高频路径，split 只在重置后算一次）。 */
	previewLines?: string[];
}

/** args 引用变化时重置 state 上的一组字段（流式期间 pi 每次给新对象）。 */
function resetOnArgsChange<S extends object>(state: S, args: unknown, fields: readonly (keyof S & string)[], refKey: keyof S & string): boolean {
	if ((state as Record<string, unknown>)[refKey] === args) return false;
	(state as Record<string, unknown>)[refKey] = args;
	for (const field of fields) (state as Record<string, unknown>)[field] = undefined;
	return true;
}


/** renderCall 的组合视图：标题（+ 执行中行）+ 可选的 diff 预览体。 */
class EditCallView implements Component {
	private readonly header: Component;
	private readonly body?: Component;

	constructor(header: Component, body?: Component) {
		this.header = header;
		this.body = body;
	}

	invalidate(): void {
		this.header.invalidate();
		this.body?.invalidate();
	}

	render(width: number): string[] {
		// pi 1.6 起 `Component.render()` 返回 `readonly string[]`，容器在子组件未变时
		// 会**复用同一个数组**。这里始终新建：不把别人的数组原样交出去，
		// 免得以后有人在这个数组上原地改（那会让 pi 的 sameLines 走 a === b 快路径，
		// 判定"没变"→ 画面冻住）。
		const lines = this.header.render(width);
		return this.body ? [...lines, ...this.body.render(width)] : [...lines];
	}
}

// ---- grep / find / powershell / ls 面板配置 ----

/**
 * 全部工具面板的标题规格表：新增面板只要在这里加一条，再在
 * PANEL_FACTORIES 里挂上工厂即可。
 */
const PANEL_SPECS: Record<string, PanelHeaderSpec> = {
	bash: { icon: ICON_BASH, label: "Bash", accent: ACCENT_BLUE, showClock: true },
	codemode: { icon: ICON_BASH, label: "Codemode", accent: ACCENT_BLUE, showClock: true },
	read: { icon: ICON_READ, label: "读取", accent: ACCENT_CYAN, showClock: true },
	write: { icon: ICON_WRITE, label: "写入", accent: ACCENT_GREEN, showClock: true },
	edit: { icon: ICON_EDIT, label: "编辑", accent: ACCENT_VIOLET, showClock: true },
	grep: { icon: ICON_SEARCH, label: "Grep", accent: ACCENT_VIOLET, showClock: true },
	find: { icon: ICON_SEARCH, label: "Find", accent: ACCENT_VIOLET, showClock: true },
	powershell: { icon: ICON_SEARCH, label: "PowerShell", accent: ACCENT_BLUE, showClock: true },
	ls: { icon: ICON_SEARCH, label: "Ls", accent: ACCENT_GREEN, showClock: false },
	// 网络工具：与「读取」同色系（都是读外部内容）。
	// 标题随状态变（"搜索中" → "搜索结果"），因为这两个工具的过程名和结果名本来就不一样。
	web_search: {
		icon: ICON_WEB,
		label: "搜索",
		labelWhen: { running: "搜索中", done: "搜索结果" },
		accent: ACCENT_CYAN,
		showClock: true,
	},
	web_fetch: {
		icon: ICON_WEB,
		label: "抓取",
		labelWhen: { running: "抓取中", done: "抓取结果" },
		accent: ACCENT_CYAN,
		showClock: true,
	},
};

/** ls 展开态的上限：目录可能有几千项，整段塞进 transcript 会让每帧重绘变慢。 */
const MAX_LS_SOURCE_LINES = 500;
const MAX_LS_VISUAL_LINES = 800;

/**
 * ls 结果的圆角虚线边框视图：╭╌╌╌╮ / ╎ 内容 ╎ / ╰╌╌╌╯，
 * 内容按预览行数折叠；出错时边框与文本转红。
 */
class LsBoxView extends CachedView {
	/** 源行数组（**不** join 成字符串：目录大时每帧 join+split 是白跑一趟）。 */
	private readonly sourceLines: readonly string[];
	private readonly isError: boolean;
	private readonly theme: ThemeLike;

	constructor(sourceLines: readonly string[], isError: boolean, theme: ThemeLike) {
		super();
		this.sourceLines = sourceLines;
		this.isError = isError;
		this.theme = theme;
	}

	protected override renderLines(outerWidth: number): string[] {
		const width = outerWidth - UI_INDENT_WIDTH;
		const borderColor = this.isError ? sgr(BAD_RED) : sgr(ACCENT_GREEN);
		if (width < 4) {
			// 窄到放不下边框：退化成一行纯文本。
			// 注意不能直接按字符切 output——里面可能带换行，切出来会在行中嵌换行符，
			// 后续 truncateToWidth 也收不住（pi 遇超宽行会报错停 TUI）。
			const firstLine = [...this.sourceLines].find((line) => line.trim() !== "")?.trim() ?? "";
			const label = firstLine || (this.isError ? "执行失败" : "(无输出)");
			return [`${UI_INDENT}${this.theme.fg(this.isError ? "error" : "text", label)}`];
		}

		const inner = width - 2;
		const contentWidth = Math.max(1, inner);
		const contentLines: string[] = [];
		const contentColor = this.isError ? "error" : "text";

		const hasContent = this.sourceLines.some((line) => line.trim() !== "");
		if (!hasContent) {
			const label = this.theme.fg(
				this.isError ? "error" : "muted",
				this.isError ? "执行失败" : "(无输出)",
			);
			for (const segment of wrapTextWithAnsi(label, contentWidth)) {
				contentLines.push(segment);
			}
		} else {
			// 只有展开态会走到这里（收起态是 3 行尾窗）；大目录按源行/可视行封顶。
			const shown = this.sourceLines.slice(0, MAX_LS_SOURCE_LINES);
			for (const line of shown) {
				contentLines.push(
					...wrapTextWithAnsi(this.theme.fg(contentColor, line), contentWidth),
				);
			}
			const omitted = this.sourceLines.length - shown.length;
			if (omitted > 0) {
				contentLines.push(
					...wrapTextWithAnsi(
						this.theme.fg("muted", `… 还有 ${omitted} 行（输出过大，已截断）`),
						contentWidth,
					),
				);
			}
			if (contentLines.length > MAX_LS_VISUAL_LINES) {
				contentLines.length = MAX_LS_VISUAL_LINES;
				contentLines.push(
					...wrapTextWithAnsi(this.theme.fg("muted", "…（已截断）"), contentWidth),
				);
			}
		}

		const lines: string[] = [`${UI_INDENT}${borderColor}╭${"╌".repeat(inner)}╮${RESET_FG}`];
		for (const line of contentLines) {
			const padding = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			lines.push(`${UI_INDENT}${borderColor}╎${RESET_FG}${line}${padding}${borderColor}╎${RESET_FG}`);
		}
		lines.push(`${UI_INDENT}${borderColor}╰${"╌".repeat(inner)}╯${RESET_FG}`);
		return lines;
	}
}

/** 面板渲染器的最小形状（各面板工厂的返回类型）。 */
interface ToolPanelRenderer {
	renderShell: "self";
	renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike): Component;
	renderResult(
		result: ToolResultLike,
		options: RenderResultOptionsLike,
		theme: Theme,
		context: ToolRenderContextLike,
	): Component;
}

/** 面板标题视图（各面板 renderCall 共用）：现算耗时 + running 行。 */
function panelHeader(
	spec: PanelHeaderSpec,
	context: ToolRenderContextLike,
	theme: Theme,
	getDuration: () => string | undefined,
	state: PanelState,
): PanelHeaderView {
	return new PanelHeaderView(
		spec,
		getDuration,
		state,
		// 执行期间显示“执行中...”，所有面板一致。
		context.isPartial && context.executionStarted,
		theme,
	);
}

/** 结果区视图工厂：默认是 ⎿ 折叠预览；ls 换成圆角虚线框。 */
type ResultView = (
	lines: string[],
	expanded: boolean,
	isError: boolean,
	theme: Theme,
	extra: { emptyLabel?: string; colorize?: (line: string) => string; keyHint?: KeyHintFn },
) => Component;

const previewView: ResultView = (lines, expanded, isError, theme, extra) =>
	new IndentedPreviewView(lines, expanded, isError, theme, extra);

/** ls 的正文由 LsBoxView 自己折叠/换行，这里只把源行还原成整段文本。 */
/** ls：展开时用圆角虚线框；收起时和其他工具一样用 3 行尾窗。 */
// ls 只在展开态用圆角框（收起态一律走 3 行尾窗，见 panelResultBody）。
const lsView: ResultView = (lines, _expanded, isError, theme) =>
	new LsBoxView(lines, isError, theme);

/**
 * 各面板共用的结果区：
 *
 * - 展开（点击/ctrl+o）→ 完整内容（bash/grep 用 ⎿ 预览，ls 用圆角框）；
 * - 收起（默认）→ **尾部内容的窗口**（工具框 3 行），运行中带静态光标，
 *   完成后定格同样的 3 行（不再收成一行摘要）；
 * - 没有内容 → 一行占位（(无输出) / 执行失败）。
 */
function panelResultBody(
	result: ToolResultLike,
	options: RenderResultOptionsLike,
	theme: Theme,
	context: ToolRenderContextLike,
	/** 完整正文；只在需要时调用（收起态不会再 split→join 白跑一趟）。 */
	sourceText: () => string,
	extra: { emptyLabel?: string; colorize?: (line: string) => string; keyHint?: KeyHintFn } = {},
	view: ResultView = previewView,
): Component {
	const state = getTimerState(context) as PanelState;
	// keyHint 走渲染上下文（用户自定义键位才显示得对）
	const hintOptions = { ...extra, keyHint: context.keyHint };
	// 定格耗时：和 core.ts touchClock 的定格逻辑互补——renderResult 不一定
	// 经过 renderCall 的 touchClock，所以在这里也兜底定格一次（??= 幂等）。
	if (!options.isPartial && state.startedAt !== undefined) state.endedAt ??= Date.now();

	// 完整正文只取一次；收起态直接用字符串，不再 split 成数组又 join 回来。
	const fullText = options.isPartial ? undefined : sourceText().replace(/\n+$/u, "");

	if (options.expanded) {
		const expandedText = fullText ?? sourceText();
		const lines = expandedText === "" ? [] : expandedText.split("\n");
		state.resultLines = lines.length;
		// 展开分支要传 hintOptions：折叠提示的 "to expand" 键位要跟用户自定义走。
		return view(lines, true, context.isError, theme, hintOptions);
	}

	// 运行中：partial 输出（bash/codemode）给实时尾窗；没有输出就让标题下的
	// “执行中...”占位。完成后：同一块尾窗定格显示最后 3 行。
	const text = options.isPartial ? liveOutputText(result) : (fullText ?? sourceText());
	state.resultLines = options.isPartial || text === "" ? 0 : text.split("\n").length;
	if (!text.trim()) {
		state.liveOutput = false;
		if (options.isPartial) return setText(context, "");
		const label = context.isError ? "执行失败" : (extra.emptyLabel ?? "(无输出)");
		return setText(
			context,
			UI_INDENT + PREVIEW_CONNECTOR_FIRST + theme.fg(context.isError ? "error" : "muted", label),
		);
	}
	state.liveOutput = true;
	state.window ??= newWindowSnapshot();
	return new LiveTailView(
		{ text: () => text, finished: () => !options.isPartial, window: state.window },
		theme,
		// 工具框不额外打“上面还有内容”：标题行已经有 “· N 行”，省下一行给正文。
		// 失败结果的正文整体转红：去掉背景色后，这是唯一还能一眼看出的错误信号。
		{
			maxLines: LIVE_PANEL_LINES,
			cursor: true,
			colorize: context.isError ? (line) => theme.fg("error", line) : undefined,
		},
	);
}

/** 所有面板共用的 renderCall：标题 + 现算耗时（running 时附“执行中”行）。 */
function panelRenderCall(
	spec: PanelHeaderSpec,
): (args: unknown, theme: Theme, context: ToolRenderContextLike) => Component {
	return (args, theme, context) => {
		const { state, getDuration } = usePanelClock(context);
		return panelHeader(spec, context, theme, getDuration, state);
	};
}

/**
 * “标题 + 结果视图”面板（bash / codemode / read / grep / find / powershell / ls）。
 * `view` 决定结果区长什么样：默认 ⎿ 折叠预览，ls 用圆角虚线框。
 */
function simplePanel(spec: PanelHeaderSpec, view: ResultView = previewView): ToolPanelRenderer {
	return {
		renderShell: "self" as const,
		renderCall: panelRenderCall(spec),
		renderResult(
			result: ToolResultLike,
			options: RenderResultOptionsLike,
			theme: Theme,
			context: ToolRenderContextLike,
		) {
			return panelResultBody(
				result,
				options,
				theme,
				context,
				() => resultOutput(result),
				{},
				view,
			);
		},
	};
}

/** write：正文显示被写入的内容（而不是工具结果的“成功”提示）。 */
function writePanel(spec: PanelHeaderSpec): ToolPanelRenderer {
	return {
		renderShell: "self" as const,

		renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike) {
			const { state, getDuration } = usePanelClock<WritePanelState>(context);
			const rawArgs = args as { content?: unknown } | undefined;

			// renderResult 拿不到 args。参数流式期间 renderCall 会被高频调用，
			// 这里只 O(1) 存原始字符串，清洗放到 renderResult 里惰性做一次，
			// 避免反复全量 cleanText。
			const rawContent = rawArgs?.content;
			if (typeof rawContent === "string") state.rawContent = rawContent;

			const header = panelHeader(spec, context, theme, getDuration, state);
			// 参数还在流式（真实执行只有几毫秒，看不到过程）：把正在生成的内容
			// 用实时尾窗滚动出来，用户能看到"正在写什么"。
			if (!context.isPartial || typeof rawContent !== "string") return header;
			const liveText = cleanedTailText(rawContent, LIVE_TAIL_CHARS);
			state.liveOutput = liveText.trim().length > 0;
			if (!state.liveOutput) return header;
			const text = liveText;
			state.window ??= newWindowSnapshot();
			return new EditCallView(
				header,
				new LiveTailView(
					{ text: () => text, finished: () => false, window: state.window },
					theme,
					{ maxLines: LIVE_PANEL_LINES, cursor: true },
				),
			);
		},

		renderResult(
			result: ToolResultLike,
			options: RenderResultOptionsLike,
			theme: Theme,
			context: ToolRenderContextLike,
		) {
			const state = getTimerState(context) as WritePanelState;
			// 失败时显示错误文本；成功时预览被写入的内容（只清洗一次）。
			if (state.content === undefined) state.content = writtenContent(state.rawContent);
			const body = context.isError ? resultOutput(result) : state.content;
			return panelResultBody(
				result,
				options,
				theme,
				context,
				() => body,
				{ emptyLabel: "(空内容)" },
			);
		},
	};
}

/** edit：标题 + 执行中 diff 预览；结果区优先用 details.diff。 */
function editPanel(spec: PanelHeaderSpec): ToolPanelRenderer {
	return {
		renderShell: "self" as const,

		renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike) {
			const { state, getDuration } = usePanelClock<EditPanelState>(context);

			// 参数完整后才在内存里试算 diff（每个参数集只算一次）；执行结果的
			// details.diff 仍是最终显示的权威来源。这里只按 args 对象引用判断
			// “参数集变了”：pi 每次 updateArgs 都给新对象，流式期间等于每个 token
			// 重置一次（argsComplete 前本来也不会算 diff），比整段 stringify 便宜。
			resetOnArgsChange(state, args, ["previewDiff", "previewError", "previewPending", "previewDone", "previewLines"], "previewArgsRef");
			if (context.argsComplete && !state.previewDone && !state.previewPending) {
				const previewInput = getPreviewInput(args);
				if (!previewInput) {
					state.previewDone = true;
				} else {
					// 异步计算：渲染路径上不做同步 IO，算完让 pi 重建一次组件。
					state.previewPending = true;
					const requestArgs = args;
					void computeEditPreview(previewInput, context.cwd).then((outcome) => {
						// 参数已变了就丢弃（等价于 pi 的 requestKey 比对）。
						if (state.previewArgsRef !== requestArgs) return;
						state.previewPending = false;
						state.previewDone = true;
						if ("error" in outcome) state.previewError = outcome.error;
						// 赋值时就归一化换行：renderCall 是高频路径，不能每帧重新 replace。
						else state.previewDiff = outcome.diff === undefined ? undefined : normalizeNewlines(outcome.diff);
						context.invalidate();
					});
				}
			}

			// 只有运行中（还在算 diff）才在标题下面挂 diff 预览体。
			// 结束后（含展开态）完整 diff 由 result 区负责——pi 的 call 区和 result 区
			// 是两个独立子组件，两边都画就会在展开时出现两份同样的 diff。
			const showPreviewBody = context.isPartial;
			const previewBody = !showPreviewBody
				? undefined
				: state.previewError !== undefined
					? new IndentedPreviewView([state.previewError], context.expanded, true, theme)
					: state.previewDiff !== undefined
						? new IndentedPreviewView(
								// previewDiff 已在赋值时归一化；split 结果缓存到 previewLines，
								// 避免 renderCall 高频路径上每帧重复 split 整段 diff。
								(state.previewLines ??= state.previewDiff.split("\n")),
								context.expanded,
								false,
								theme,
								{ colorize: colorizeDiffLine },
							)
						: undefined;
			// 有预览体时标题下面不再重复一行“执行中...”，否则会出现两个 ⎿。
			state.liveOutput = previewBody !== undefined;

			return new EditCallView(
				panelHeader(spec, context, theme, getDuration, state),
				previewBody,
			);
		},

		renderResult(
			result: ToolResultLike,
			options: RenderResultOptionsLike,
			theme: Theme,
			context: ToolRenderContextLike,
		) {
			const state = getTimerState(context) as EditPanelState;
			// 失败时错误文本优先；成功时 details.diff 是权威，缺失才回退预览 diff。
			const typedResult = result as { details?: { diff?: unknown } };
			const rawDiff = context.isError
				? undefined
				: typeof typedResult.details?.diff === "string"
					? typedResult.details.diff
					: state.previewDiff;
			// previewDiff 已在赋值时归一化过；只有 details.diff 还需要兜底 replace。
			const diff =
				typeof rawDiff === "string"
					? rawDiff === state.previewDiff
						? rawDiff
						: rawDiff.replace(/\r\n?/gu, "\n")
					: "";
			const sourceText = diff || resultOutput(result);
			if (!sourceText) {
				// 没有 diff：一行占位（展开时也一样，没啥可展开的）
				return setText(
					context,
					UI_INDENT +
						truncateToWidth(theme.fg("muted", `${PREVIEW_CONNECTOR_FIRST}(无差异)`), 40, "…"),
				);
			}
			return panelResultBody(
				result,
				options,
				theme,
				context,
				() => sourceText,
				{ colorize: colorizeDiffLine },
			);
		},
	};
}

/**
 * 只有"特殊面板"才需要单独列：其余工具从 PANEL_SPECS 自动生成 simplePanel。
 *
 * 以前这里把 9 个工具名又抄了一遍（和 PANEL_SPECS 重复）；新增一个普通面板只要
 * 在 PANEL_SPECS 加一行即可，只有像 write/edit/ls 这种换了视图的才来这里登记。
 */
const SPECIAL_PANELS: Record<string, (spec: PanelHeaderSpec) => ToolPanelRenderer> = {
	write: writePanel,
	edit: editPanel,
	ls: (spec) => simplePanel(spec, lsView),
	web_search: (spec) =>
		webToolPanel(spec, { argField: "query", emptyLabel: "(无结果)", failureLabel: "搜索失败" }),
	web_fetch: (spec) =>
		webToolPanel(spec, { argField: "url", emptyLabel: "(无内容)", failureLabel: "抓取失败" }),
};

// ---- web_search / web_fetch：标题 + 参数行 + 4 行结果窗口 ----------------

/**
 * 标题下方的参数行：`⎿ query` / `⎿ URL`。
 *
 * 为什么不把 query 塞进标题：`site:… lang:… after:…` 这类语法能让 query 很长，
 * 塞标题会把耗时挤出屏幕；而单独一行跟单 agent 块的「标题 → ⎿ 任务」结构一致。
 */
class ArgLineView extends CachedView {
	private readonly text: string;
	private readonly theme: ThemeLike;

	constructor(text: string, theme: ThemeLike) {
		super();
		this.text = text;
		this.theme = theme;
	}

	protected renderLines(width: number): string[] {
		const avail = Math.max(1, width - UI_INDENT_WIDTH - PREVIEW_CONNECTOR_WIDTH);
		const line = truncateToWidth(this.theme.fg("text", this.text), avail, "…");
		return [`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${line}`];
	}
}

/**
 * web 工具结果的 4 行窗口。
 *
 * 与其它工具面板的尾窗（`LiveTailView`）差别：搜索结果是**按相关性排序的清单**、
 * 抓取的网页正文则是"从头读起"，**头部**才是要看的（尾窗只会露出末尾的碎片）。所以：
 *   - 运行中（有 partial 输出）→ 取尾部，滚动感与其它工具一致；
 *   - 完成后 → 取头部，先看到最相关的结果。
 * 高度恒定为 SEARCH_WINDOW_LINES：transcript 不抖、也不跳屏。
 * 段落空行一律压掉（见下方注释）：4 行本来就紧张，空行等于白占。
 */
class SearchWindowView extends CachedView {
	private readonly sourceLines: readonly string[];
	/** 运行中取尾部（滚动），完成后取头部（相关性最高的在前）。 */
	private readonly tail: boolean;
	private readonly isError: boolean;
	private readonly theme: ThemeLike;

	constructor(
		sourceLines: readonly string[],
		tail: boolean,
		isError: boolean,
		theme: ThemeLike,
	) {
		super();
		this.sourceLines = sourceLines;
		this.tail = tail;
		this.isError = isError;
		this.theme = theme;
	}

	protected renderLines(width: number): string[] {
		const contentWidth = Math.max(1, width - UI_INDENT_WIDTH - PREVIEW_CONNECTOR_WIDTH);
		const style = this.isError
			? (line: string) => this.theme.fg("error", line)
			: (line: string) => this.theme.fg("text", line);

		const rows: string[] = [];
		for (const line of this.sourceLines) {
			// 空行不占窗口：抓取的正文开头常是「# 标题 / 空行 / 来源：… / 空行 / ## 小节」，
			// 4 行窗口里塞两个空行就等于只剩 2 行内容。窗口是"预览"，不是原文排版。
			if (line.trim() === "") continue;
			rows.push(...wrapTextWithAnsi(style(line), contentWidth));
			// 只要一个窗口的量：头部取前 N 行，尾部多留一屏余量（换行会改变行数）。
			if (!this.tail && rows.length >= SEARCH_WINDOW_LINES) break;
		}
		const window = this.tail ? rows.slice(-SEARCH_WINDOW_LINES) : rows.slice(0, SEARCH_WINDOW_LINES);
		// 第二行起没有 `⎿`：查询词已经用过一个，再套一个会出现两层连接符。
		return window.map((row) => `${UI_INDENT}${PREVIEW_CONNECTOR_REST}${row}`);
	}
}

/**
 * web_search：`图标 搜索 · ⏱ 1.2s · N 行` / `⎿ query` / 4 行结果窗口。
 *
 * 展开（点击 / ctrl+o）走和其它工具一样的 `⎿` 全量预览。
 */
function webToolPanel(
	spec: PanelHeaderSpec,
	config: {
		/** 从工具参数里取哪一项显示在第二行（web_search → query，web_fetch → url）。 */
		argField: "query" | "url";
		/** 没内容时的占位文案（搜索是"无结果"，抓取是"无内容"）。 */
		emptyLabel: string;
		/** 失败时的标题文案（搜索失败 / 抓取失败）。 */
		failureLabel: string;
	},
): ToolPanelRenderer {
	return {
		renderShell: "self" as const,

		renderCall(args: unknown, theme: Theme, context: ToolRenderContextLike) {
			const { state, getDuration } = usePanelClock(context);
			const raw = (args as Record<string, unknown> | undefined)?.[config.argField];
			const arg = typeof raw === "string" ? raw.trim() : "";
			// 已经有参数了就别再打“执行中...”：标题在扫光、时钟在走，下面还有内容。
			if (arg !== "") state.liveOutput = true;
			const header = panelHeader(spec, context, theme, getDuration, state);
			return arg === "" ? header : new EditCallView(header, new ArgLineView(arg, theme));
		},

		renderResult(
			result: ToolResultLike,
			options: RenderResultOptionsLike,
			theme: Theme,
			context: ToolRenderContextLike,
		) {
			const state = getTimerState(context) as PanelState;
			// 与其它面板一致：renderResult 不一定经过 renderCall 的 touchClock，这里兜底定格。
			if (!options.isPartial && state.startedAt !== undefined) state.endedAt ??= Date.now();

			const text = (options.isPartial ? liveOutputText(result) : resultOutput(result)).replace(/\n+$/u, "");
			state.resultLines = text === "" ? 0 : text.split("\n").length;

			if (text.trim() === "") {
				state.liveOutput = false;
				if (options.isPartial) return setText(context, "");
				const label = context.isError ? config.failureLabel : config.emptyLabel;
				return setText(
					context,
					`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${theme.fg(context.isError ? "error" : "muted", label)}`,
				);
			}

			state.liveOutput = true;
			const lines = text.split("\n");
			if (options.expanded) {
				return new IndentedPreviewView(lines, true, context.isError, theme, { keyHint: context.keyHint });
			}
			return new SearchWindowView(lines, options.isPartial, context.isError, theme);
		},
	};
}

/** 工具名 → 面板工厂（特殊面板优先，其余按 PANEL_SPECS 自动生成）。 */
const PANEL_FACTORIES: Record<string, () => ToolPanelRenderer> = Object.fromEntries(
	Object.entries(PANEL_SPECS).map(([toolName, spec]) => {
		const special = SPECIAL_PANELS[toolName];
		return [toolName, () => (special ? special(spec) : simplePanel(spec))];
	}),
);

/** 注册全部工具面板渲染器（纯查表，未命中的工具交还给 pi）。 */
export function registerToolRenderers(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		if (!Object.prototype.hasOwnProperty.call(PANEL_FACTORIES, toolName)) return next();
		return PANEL_FACTORIES[toolName]!();
	});
}

