/**
 * 五、助手消息样式（原型补丁：\uE22C 悬挂缩进 / 去背景 / 思考块折叠预览）
 *
 * 补丁打在 AssistantMessageComponent.prototype 上：render 做行级变换（去掉
 * pi 的 outputPad、剥背景色、删代码块围栏行、加图标缩进），updateContent 里
 * 把折叠态 thinking 标签换成带计时的预览，handleMouse 把显示坐标换算回原始
 * 坐标（正文右移 + 围栏行被删都会让命中点偏移）。
 */

import {
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	join,
} from "node:path";
import {
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	clockText,
	DIM_GRAY,
	GUTTER,
	hasVisibleText,
	ICON_CLOCK,
	ICON_THINKING,
	LEADING_ANSI_SOURCE,
	LEADING_CONTROL,
	MUTED,
	PI_OUTPUT_PAD,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	PREVIEW_CONNECTOR_WIDTH,
	RESET_FG,
	SKY_BLUE,
	shimmerFrame,
	shimmerText,
	tailWindow,
	stripAnsi,
	THINKING_YELLOW,
	THINKING_YELLOW_RGB,
	touchClock,
	UI_INDENT,
	UI_INDENT_WIDTH,
} from "./core.ts";
import type {
	BlockClock,
	ThinkingContentLike,
} from "./core.ts";

/**
 * 每条助手消息的行数（键 = 消息时间戳），用于"整轮结束后跳回回复开头"的判断。
 *
 * 这里必须按消息区分，不能只记"最近一次渲染"：pi 的 ScrollView 每帧会重渲染
 * 整个 transcript，最后一次渲染的可能是历史消息（`/tree` 切分支、滚回旧消息、
 * 多窗口复用组件实例时都会发生），拿它的行数去决定要不要跳，会误跳。
 */
const renderedLinesByMessage = new Map<number, number>();

function recordRenderedLines(timestamp: number, lines: number): void {
	if (!Number.isFinite(timestamp)) return;
	renderedLinesByMessage.set(timestamp, lines);
	// 只留最近的若干条：会话很长时不至于无限增长
	if (renderedLinesByMessage.size > 200) {
		const oldest = Math.min(...renderedLinesByMessage.keys());
		renderedLinesByMessage.delete(oldest);
	}
}

/** 最新那条助手消息的行数（= 刚生成完的回复；没有记录时为 0）。 */
export function lastAssistantRenderLines(): number {
	let newest = 0;
	let lines = 0;
	for (const [timestamp, count] of renderedLinesByMessage) {
		if (timestamp >= newest) {
			newest = timestamp;
			lines = count;
		}
	}
	return lines;
}

/** 清空记录（切换会话时调用，避免跨会话串味）。 */
export function resetRenderedLines(): void {
	renderedLinesByMessage.clear();
}

/**
 * 助手正文首行前缀：亮蓝色（\uE22C）。悬挂缩进宽度由对齐系统的 GUTTER 决定。

 *
 * 注意：**图标后面那个空格也在染色范围内**。这个字形是 PUA（Unicode 宽度属性
 * 是 Ambiguous），不少终端在 CJK 环境下按 2 列渲染，而 pi-tui 只算 1 列；
 * 如果紧接着字形就 RESET_FG，第 2 个“填充格”会留在默认前景色（看上去白），
 * 屏幕上是“左蓝右白”的半截图标。把空格包进颜色里就能盖住（宽度不变）。
 */
const ASSISTANT_PREFIX = `${SKY_BLUE}\uE22C ${RESET_FG}`;

/** 行首可能先出现 OSC（例如 pi 的 OSC 133 标记），随后才是左内边距空格。 */
const LEADING_OSC_AND_SPACES = new RegExp(`^(${LEADING_ANSI_SOURCE})( +)`);

interface MouseEventLike {
	x: number;
	y: number;
	width: number;
	height: number;
	[key: string]: unknown;
}

interface RuntimeChild {
	render(width: number): string[];
	/** MouseRegion 包装的 thinking 块带有 child。 */
	child?: RuntimeChild;
	/** Markdown / Text 的文本内容。 */
	text?: string;
}

interface AssistantMessageLike {
	content?: ThinkingContentLike[];
	timestamp?: number;
}

interface RuntimePrototype {
	render(width: number): string[];
	handleMouse?: (event: MouseEventLike) => unknown;
	updateContent?: (message: unknown, isStreaming?: boolean) => void;
	setHideThinkingBlock?: (hide: boolean) => void;
	/** AssistantMessageComponent 的运行时字段（TS 里是 private）。 */
	hideThinkingBlock?: boolean;
	/** 用户显式切换过全局 thinking 可见性（快捷键 / 设置）：之后不再强制折叠。 */
	__piAssistantHideThinkingUserSet?: boolean;
	/** 用户点击后写入的展开/折叠覆盖，键为 thinking runIndex。 */
	thinkingVisibilityOverrides?: Map<number, boolean>;
	outputPad?: number;
	isStreaming?: boolean;
	contentContainer?: {
		children?: RuntimeChild[];
		mouseLayout?: {
			width: number;
			children?: Array<{ component: RuntimeChild; height: number }>;
		};
		removeChild?: (component: RuntimeChild) => void;
	};
	/** 渲染缓存失效计数：pi 里所有内容/流式状态变化都经过 updateContent，每次 +1。 */
	__piAssistantStyleVersion?: number;
	/** 变换结果缓存：pi 的 ScrollView 每帧全量重渲染，没缓存时逐行正则会反复执行。 */
	__piAssistantStyleCache?: AssistantRenderCache;
	__piAssistantGutterPatched?: boolean;
	__piAssistantGutterUpdatePatched?: boolean;
	__piAssistantGutterOriginalRender?: (width: number) => string[];
	__piAssistantGutterOriginalHandleMouse?: (event: MouseEventLike) => unknown;
	__piAssistantGutterOriginalUpdateContent?: (message: unknown, isStreaming?: boolean) => void;
	__piAssistantGutterOriginalSetHideThinkingBlock?: (hide: boolean) => void;
	/** 我们打上去的函数本身（所有权校验用） */
	__piAssistantGutterPatchedRender?: (width: number) => string[];
	__piAssistantGutterPatchedHandleMouse?: (event: MouseEventLike) => unknown;
	__piAssistantGutterPatchedUpdateContent?: (message: unknown, isStreaming?: boolean) => void;
	__piAssistantGutterPatchedSetHideThinkingBlock?: (hide: boolean) => void;
}

/**
 * 渲染补丁的缓存：除了输出行，还记录每一行在“未打补丁的原始行数组”里的
 * 下标与水平位移。鼠标事件（点击展开 thinking、点链接）要按原始坐标重新
 * 定位，否则正文右移 + 围栏行被删都会让命中点偏移。
 */
/**
 * 缓存结构版本：/reload 后组件实例上会残留旧代码写入的缓存对象，结构对不上必须作废。
 * 修改 AssistantRenderCache 的字段时记得把它 +1（不改也不会崩，isAssistantCacheValid
 * 还有形状自检兜底，但会白跑一次失效判断）。
 */
const ASSISTANT_CACHE_SCHEMA = 2;

/**
 * 流式期间缓存的时间粒度（毫秒）。
 *
 * 思考块的"耗时/扫光/尾窗"是时间驱动的：如果整条助手消息一直命中我们的行缓存，
 * 子组件根本不会被 render，动画就永远停住。所以流式期间让缓存按这个粒度失效
 * （50ms ≈ 20fps，和动画节拍一致）；非流式仍然是纯 (宽度, 版本) 缓存。
 */
const ASSISTANT_STREAM_FRAME_MS = 50;

interface AssistantRenderCache {
	/** 结构版本见 ASSISTANT_CACHE_SCHEMA。 */
	schema: number;
	/** 组件的渲染宽度（display width）；鼠标事件的 event.width 要对上它才可信。 */
	width: number;
	version: number;
	/** 流式帧号（非流式固定 0），让时间驱动的子动画有机会重画。 */
	frame: number;
	lines: string[];
	/** 第 k 条输出行对应的原始行下标。 */
	rawLineOf: number[];
	/** 第 k 条输出行相对原始内容的水平位移（前缀宽度 - 被删掉的左内边距）。 */
	lineShift: number[];
	/** 原始行总数（去掉围栏行的空行映射后，鼠标 y 的合法上界）。 */
	rawHeight: number;
}

/**
 * 缓存能否直接复用：结构版本 + 渲染宽度 + 内容版本三者都要对上。
 *
 * 结构版本是给 /reload 兜底的：pi 不会重建已有的消息组件，实例上会残留旧
 * 代码写入的缓存对象（例如只有 width/version/lines 的旧形状），只比 width
 * 和 version 会误判为命中，接着读到不存在的字段就崩（rawLineOf[undefined]）。
 */
function isAssistantCacheValid(
	cache: AssistantRenderCache | undefined,
	width: number,
	version: number,
	/** 传了就一起比对帧号；鼠标换算不传——它要的正是"上一帧显示的那份布局"。 */
	frame?: number,
): cache is AssistantRenderCache {
	if (cache === undefined) return false;
	if (cache.schema !== ASSISTANT_CACHE_SCHEMA) return false;
	// 形状自检：即使将来忘了 bump schema（比如换字段却没改版本号），也不会
	// 因为读到不存在的字段而抛异常——直接当作未命中重算。
	if (!Array.isArray(cache.lines)) return false;
	if (!Array.isArray(cache.rawLineOf)) return false;
	if (!Array.isArray(cache.lineShift)) return false;
	if (cache.width !== width || cache.version !== version) return false;
	return frame === undefined || cache.frame === frame;
}

/**
 * 一次“思考片段”的计时。unknown 表示进程内没有观测到它的流式过程
 * （历史重放），此时没有可信耗时，只显示“思考”不显示时间。
 */
interface ThinkingTiming extends BlockClock {
	unknown?: boolean;
	/**
	 * 折叠态预览视图：跨 updateContent 复用。
	 *
	 * pi 每次 updateContent 都把 children 整个重建，`child.child` 是新的 Text；
	 * 如果这里也新建视图，快照/渲染缓存全部每帧清零——
	 * 表现就是末行一直闪烁、小窗口一直被重排（视觉上"抖"）。
	 */
	view?: ThinkingPreviewView;
}

/** 键为 `<message.timestamp>:<runIndex>`，只在当前进程内有效。 */
const thinkingTimings = new Map<string, ThinkingTiming>();
const MAX_THINKING_TIMINGS = 500;

/** 会话结束时清空计时记录（键是 message.timestamp，只在当前进程内有效）。 */
export function resetThinkingTimings(): void {
	thinkingTimings.clear();
	resetRenderedLines();
}

/**
 * 去掉助手正文原有的左内边距。Markdown/Text 会先加 outputPad 个空格，
 * 这里把它换成统一的图标缩进。行首的 OSC/CSI 标记（如 OSC 133）原样保留。
 * 同时返回实际删掉的空格数：鼠标坐标要靠它反推水平位移。
 */
function stripLeftPadding(
	line: string,
	padding: number,
): { text: string; removed: number } {
	if (padding <= 0) return { text: line, removed: 0 };
	const match = LEADING_OSC_AND_SPACES.exec(line);
	if (!match) return { text: line, removed: 0 };
	const prefix = match[1] ?? "";
	const spaces = match[2] ?? "";
	const removed = Math.min(padding, spaces.length);
	return {
		text: prefix + spaces.slice(removed) + line.slice(prefix.length + spaces.length),
		removed,
	};
}

/** 代码块围栏边框行：去掉 ANSI 后整行只剩 ```lang 或 ```（代码内容行带缩进，不会误匹配）。 */
const FENCE_BORDER = /^```[A-Za-z0-9_+.-]*$/;
function isFenceBorderLine(line: string): boolean {
	return FENCE_BORDER.test(stripAnsi(line).replace(/\s+$/, ""));
}

/** SGR 序列（ESC [ 数字/分号参数 m）。 */
const SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;

/**
 * 去掉整行里所有背景色参数（40-47、100-107、48;5;n、48;2;r;g;b），
 * 其余参数（49 重置、前景色、加粗等）原样保留；背景参数与前景参数
 * 混在同一条 SGR 里时也能正确剥离。整条序列只剩背景参数时整条删除。
 */
/**
 * 背景色"可能存在于这一行"的廉价判据。
 *
 * 助手消息里基本没有背景色，而 `SGR_SEQUENCE.replace(回调)` 要逐段解析参数，
 * 500 行带彩码的代码实测 ~6.7ms/帧。先用一条正则扫一遍：命中才进回调。
 * （误命中只是"多解析一行"，代价可忽略。）
 */
const BACKGROUND_HINT = /[\x1b\[;](?:4[0-7]|10[0-7]|48|49)(?![0-9])/;

export function stripBackgroundSgr(line: string): string {
	// 没有背景候选就直接返回，省掉整行解析
	if (!BACKGROUND_HINT.test(line)) return line;
	return line.replace(SGR_SEQUENCE, (sequence: string, params: string): string => {
		if (params === "") return sequence; // ESC[m 等价于重置，保留
		const parts = params.split(";");
		const kept: string[] = [];
		let changed = false;
		for (let i = 0; i < parts.length; ) {
			const part = parts[i] ?? "";
			const code = part === "" ? Number.NaN : Number(part);
			if (code === 38 || code === 48) {
				// 扩展颜色：38;5;n / 38;2;r;g;b（48 同理），参数必须整组消费。
				// mode 缺失/未知时无法判断后续参数归谁，保守起见把剩余参数原样保留、
				// 不再继续解释（否则后续的 41 之类会被误当成新的背景参数删掉）。
				const mode = parts[i + 1];
				if (mode !== "5" && mode !== "2") {
					// 未知 mode：无法判断后续参数归谁，整段原样保留（38/48 都一样）。
					// 以前 48 会直接丢弃尾部，连带把后面的前景参数也丢了。
					kept.push(...parts.slice(i));
					break;
				}
				const take = mode === "5" ? 3 : 5;
				const consumed = parts.slice(i, i + take);
				if (code === 48) changed = true;
				else kept.push(...consumed);
				i += consumed.length;
				continue;
			}
			if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				changed = true;
				i++;
				continue;
			}
			kept.push(part);
			i++;
		}
		if (!changed) return sequence;
		return kept.length === 0 ? "" : `\x1b[${kept.join(";")}m`;
	});
}

/**
 * 一次遍历同时得到两样东西（旧实现是两个函数各自走一遍 mouseLayout）：
 *
 * - `mask`：行级 thinking 掩码。contentContainer 里被 MouseRegion 包裹的子组件都是
 *   thinking 块（折叠预览或展开正文），它们的行不加 GUTTER，让块左边缘与助手
 *   图标、工具面板同列；
 * - `textLine`：第一条“正文”行的行号。正文是第一个未被 MouseRegion 包裹的
 *   Markdown/Text。`-1` 表示没有正文（不显示图标），`undefined` 表示读不到内部结构。
 *
 * Container.render 会把每个子组件的高度记录在 mouseLayout 里，直接复用，避免
 * streaming 时把 thinking 内容重复渲染一遍。
 */
interface AssistantContentLayout {
	mask: boolean[];
	textLine: number | undefined;
}

function analyzeContentLayout(instance: RuntimePrototype, width: number): AssistantContentLayout {
	const container = instance.contentContainer;
	if (!container) return { mask: [], textLine: undefined };

	const layout = container.mouseLayout;
	const children =
		layout?.width === width && Array.isArray(layout.children)
			? layout.children
			: container.children?.map((child) => ({
					component: child,
					height: child.render(width).length,
				}));
	if (!children) return { mask: [], textLine: undefined };

	const mask: boolean[] = [];
	let textLine: number | undefined = -1;
	let offset = 0;
	for (const { component, height } of children) {
		const isThinking = component.child !== undefined;
		if (
			textLine === -1 &&
			!isThinking &&
			typeof component.text === "string" &&
			component.text.trim()
		) {
			textLine = offset;
		}
		// 此刻的 offset 就是该块的起始行。
		for (let i = 0; i < height; i++) mask.push(isThinking);
		offset += height;
	}
	return { mask, textLine };
}

/**
 * 按 pi 的分组方式收集思考片段：连续的 thinking 块合并为一段，
 * 空白片段会被剔除（与 AssistantMessageComponent 的行为一致）。
 * end 是这段在 content 里的结束下标，texts 是合并后的各段思考内容。
 *
 * 这里**不做 join**：预览只需要前几行，拼接整段文本会让每个 token 的重建
 * 变成 O(文本长度)，拼接结果交给 ThinkingPreviewView 惰性裁头部行。
 */
function collectThinkingRuns(
	message: AssistantMessageLike | undefined,
): Array<{ end: number; texts: string[] }> {
	const content = message?.content;
	if (!Array.isArray(content)) return [];

	const runs: Array<{ end: number; texts: string[] }> = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		let j = i;
		const texts: string[] = [];
		for (; j < content.length; j++) {
			const block = content[j];
			if (block?.type !== "thinking") break;
			const text = (block.thinking ?? "").trim();
			if (text) texts.push(text);
		}
		if (texts.length > 0) runs.push({ end: j - 1, texts });
		i = j - 1;
	}
	return runs;
}

function updateThinkingTiming(key: string, active: boolean, now: number): ThinkingTiming {
	let record = thinkingTimings.get(key);
	if (!record) {
		record = {};
		thinkingTimings.set(key, record);
		if (thinkingTimings.size > MAX_THINKING_TIMINGS) {
			// 只淘汰已经结束的片段：删掉正在计时的会把它从 0 重新计时。
			for (const [oldKey, oldRecord] of thinkingTimings) {
				if (oldRecord.endedAt === undefined && !oldRecord.unknown) continue;
				thinkingTimings.delete(oldKey);
				break;
			}
		}
	}

	// 进程内从未观测到它活跃（历史重放）：没有可信耗时。
	if (!active && record.startedAt === undefined) {
		record.unknown = true;
		return record;
	}
	record.unknown = false;
	touchClock(record, active, now);
	return record;
}

/**
 * 折叠态的思考预览组件：第一行标题（图标 + 思考中 + 耗时），
 * 随后用与工具面板相同的 `⎿` 连接线显示思考链的前几行。
 * 替换 pi 折叠态的单行标签组件使用；外层 MouseRegion 的点击展开逻辑不受影响。
 */
/** 思考块的内容高度（行）：运行中看过程、完成后看尾部，都不超过这个数。 */
const THINKING_TAIL_LINES = 12;
/**
 * 思考块窗口内容的刷新节拍（毫秒）。
 *
 * 高速流式时文本每帧都在长；每帧都重排尾窗会让 6 行的小窗口一直在"往上顶"，
 * 看起来就是抖。按 ~7Hz 取快照，滚动变成稳定的步进。
 */
const THINKING_REFRESH_MS = 150;
/** 尾窗只看最后两段思考、每段最多取这么多字符（避免每帧处理整条链）。 */
const THINKING_TAIL_TEXTS = 2;
const THINKING_TAIL_CHARS = 8 * 1024;

/** 取 text 的末尾 limit 个字符，并对齐到行首（丢掉半截的第一行）。 */
function tailSlice(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const slice = text.slice(text.length - limit);
	const newline = slice.indexOf("\n");
	return newline === -1 ? slice : slice.slice(newline + 1);
}

class ThinkingPreviewView extends CachedView {
	private texts: readonly string[];
	/** 计时记录（与工具面板共用 BlockClock）：标题里的耗时与扫光相位都由它算。 */
	private record: ThinkingTiming;
	/** 窗口内容快照（按 THINKING_REFRESH_MS 节拍更新）。 */
	private bodySlot = -1;
	private bodyText = "";

	/** 取"这一拍"的文本快照（完成后立即对齐最新内容）。 */
	private snapshot(text: string, finished: boolean): string {
		const slot = Math.floor(Date.now() / THINKING_REFRESH_MS);
		if (finished || slot !== this.bodySlot || this.bodyText === "") {
			this.bodySlot = slot;
			this.bodyText = text;
		}
		return this.bodyText;
	}

	constructor(texts: readonly string[], record: ThinkingTiming) {
		super();
		this.texts = texts;
		this.record = record;
	}

	/**
	 * 就地更新内容：流式期间每个 token 都会重建内容，复用同一个实例可以
	 * 避免每次新建对象。
	 */
	update(texts: readonly string[], record: ThinkingTiming): void {
		if (this.record === record && sameStrings(this.texts, texts)) return;
		this.texts = texts;
		this.record = record;
		this.invalidate();
	}

	/** 思考是否已经结束（结束态只留标题一行，点它展开全文）。 */
	private get finished(): boolean {
		return this.record.unknown === true || this.record.endedAt !== undefined;
	}

	/**
	 * 缓存键：finished 状态 + 快照末段长度（+ 运行中的扫光相位）。
	 *
	 * 流式中标题的耗时/扫光和内容都在变，每帧都要重画；结束后标题定型、
	 * 只留一行，缓存重新生效。
	 */
	protected override cacheKey(): string {
		const last = this.texts[this.texts.length - 1] ?? "";
		const finished = this.finished;
		// 窗口内容按节拍取快照（避免每帧重排小窗口）
		const snapshotLast = this.snapshot(last, finished);
		if (finished) return `${snapshotLast.length}:done`;
		return `${snapshotLast.length}:${shimmerFrame(this.record.startedAt)}`;
	}

	/**
	 * 尾窗（6 行）：运行中与完成后都定格在同一位置；只显示最新内容，
	 * 顶部一行 dim、其余 muted（终端做不了纵向渐变，按行分档就能读出"在往上流"）。
	 */
	protected renderLines(width: number): string[] {
		const header = thinkingHeader(this.record);
		if (width < 6) return [truncateToWidth(header, Math.max(0, width), "…")];

		const lines: string[] = [truncateToWidth(header, width, "…")];
		const finished = this.finished;

		const contentWidth = Math.max(1, width - PREVIEW_CONNECTOR_WIDTH);
		// 只取最后两段、每段再截尾部，避免每帧 join/wrap 整条思考链。
		const parts = this.texts
			.slice(-THINKING_TAIL_TEXTS)
			.map((text) => tailSlice(text, THINKING_TAIL_CHARS));
		// 按**可视行**取窗口：思考链常常是一整段没有换行，按源行取窗口会被折成
		// 几十行 → 高度一直变（那就是抖动）。内容按节拍取快照（见 snapshot()）。
		const joined = this.snapshot(parts.join("\n\n"), finished);
		const { rows, more } = tailWindow(joined, THINKING_TAIL_LINES, contentWidth);
		if (rows.length === 0 && !more) return lines;

		let firstLine = true;
		const emit = (segments: string[]): void => {
			if (segments.length === 0) return;
			segments.forEach((segment, index) => {
				const prefix = firstLine && index === 0 ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
				lines.push(`${prefix}${segment}`);
			});
			firstLine = false;
		};

		if (more) emit(wrapTextWithAnsi(`${MUTED}… 上面还有内容${RESET_FG}`, contentWidth));
		const total = rows.length;
		rows.forEach((row, index) => {
			// 顶部一行最暗，越往下越亮
			const styled = index === 0 && total > 1 ? `${DIM_GRAY}${row}${RESET_FG}` : `${MUTED}${row}${RESET_FG}`;
			emit([styled]);
		});
		// 静态光标（不闪）表示还在输出；完成后定格，不再有光标
		if (!finished) {
			const last = lines.length - 1;
			lines[last] = `${lines[last]}${DIM_GRAY}▍${RESET_FG}`;
		}
		return lines;
	}
}

/**
 * 折叠时的整行标题：思考中... · 0.7s（结束后标签变为"思考"）。
 */
/** 斜体复位（思考标签前面带上，抵消 pi 对 thinking 文本的斜体设置）。 */
const ITALIC_OFF = "\x1b[23m";

function thinkingHeader(record: ThinkingTiming): string {
	const finished = record.unknown || record.endedAt !== undefined;
	const elapsed = record.unknown ? undefined : clockText(record);
	// 标题行：图标 + 「思考/思考中...」+ 时钟 + 耗时。
	// 思考中时**整行一起扫光**（与工具面板一致：亮带从图标一路扫到耗时），
	// 结束后恢复平色。
	const plain = `${ICON_THINKING} ${finished ? "思考" : "思考中..."}${
		elapsed === undefined ? "" : ` · ${ICON_CLOCK} ${elapsed}`
	}`;
	const body = finished
		? `${THINKING_YELLOW}${BOLD_ON}${plain}${BOLD_OFF}`
		: `${BOLD_ON}${shimmerText(plain, THINKING_YELLOW_RGB, record.startedAt)}${BOLD_OFF}`;
	return `${ITALIC_OFF}${body}${RESET_FG}`;
}

/** 字符串数组逐项相等（思考链预览的复用判定，不拼字符串、不 join）。 */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * 重建内容后：把折叠态的 thinking 标签换成带计时的自定义标题 + ⎿ 思考链预览。
 * children 里被 MouseRegion 包裹的才是 thinking；展开态（用户点击或全局设为显示）
 * 保留 pi 自己的 Markdown。
 */
function applyThinkingHeaders(
	instance: RuntimePrototype,
	message: AssistantMessageLike | undefined,
	isStreaming: boolean | undefined,
): void {
	const children = instance.contentContainer?.children;
	if (!children) return;

	const runs = collectThinkingRuns(message);
	if (runs.length === 0) return;

	// pi 在两种情况下会"少建一个 thinking child"：hidden 且标签为空、
	// 或该 run 的 thinking 文本全是空白。此时 children 与 runs 不再一一对应，
	// 继续按顺序改写会把计时/预览串到别的块上——宁可什么都不做。
	const thinkingChildren = children.filter((child) => child.child).length;
	if (thinkingChildren !== runs.length) return;

	const contentLength = message?.content?.length ?? 0;
	const timestamp = typeof message?.timestamp === "number" ? message.timestamp : 0;
	const overrides = instance.thinkingVisibilityOverrides;

	let runIndex = 0;
	for (const child of children) {
		// children 里被 MouseRegion 包裹的才是 thinking 块。
		if (!child.child) continue;
		const run = runs[runIndex];
		if (!run) continue;

		const active = Boolean(isStreaming) && run.end === contentLength - 1;
		const record = updateThinkingTiming(`${timestamp}:${runIndex}`, active, Date.now());
		// 与 pi 的判定完全一致：点击过的片段用覆盖值，其余跟随全局 hideThinkingBlock。
		// （本扩展只在用户未显式切换过时默认折叠，见 updateContent 补丁。）
		const hidden = overrides?.get(runIndex) ?? Boolean(instance.hideThinkingBlock);
		runIndex++;

		if (hidden) {
			// 把 pi 的单行标签 Text 换成工具面板风格的预览组件；
			// 外层 MouseRegion 的点击展开行为（pi 自己的 onMouse）保持不变。
			// 视图实例存在计时记录上复用：pi 每帧重建 children，实例重建会丢
			// 快照/渲染缓存（见 ThinkingTiming.view 的注释）。
			if (record.view === undefined) record.view = new ThinkingPreviewView(run.texts, record);
			else record.view.update(run.texts, record);
			child.child = record.view as unknown as RuntimeChild;
		}
	}
}

export function patchAssistantMessageStyle(): void {
	const proto = AssistantMessageComponent.prototype as unknown as RuntimePrototype;
	// 同一个进程里 /reload 或切换会话时，先恢复原方法，确保最新代码生效。
	if (proto.__piAssistantGutterPatched || proto.__piAssistantGutterUpdatePatched) {
		unpatchAssistantMessageStyle();
	}

	const originalRender = proto.render;
	const originalHandleMouse = proto.handleMouse;
	proto.__piAssistantGutterOriginalRender = originalRender;
	proto.__piAssistantGutterOriginalHandleMouse = originalHandleMouse;

	const patchedRender = function (this: RuntimePrototype, width: number): string[] {
		// 终端极窄时不做缩进，避免行宽溢出。
		if (!Number.isFinite(width) || width <= GUTTER + 2) {
			return originalRender.call(this, width);
		}

		try {
			return renderStyled.call(this, width);
		} catch {
			// pi 改了内部结构（contentContainer / mouseLayout / outputPad …）时，
			// 宁可退回原生渲染，也不要因为一层样式把整条消息打没。
			this.__piAssistantStyleCache = undefined;
			return originalRender.call(this, width);
		}
	};
	proto.render = patchedRender as RuntimePrototype["render"];

	/** 实际的行级变换（缓存、去内边距、删围栏行、加图标）。 */
	function renderStyled(this: RuntimePrototype, width: number): string[] {
		// pi 的 ScrollView 每次 requestRender 都会重渲染整个 transcript（不只是
		// 可视区），这里若不缓存，逐行去内边距/背景色的正则会在每个动画帧上
		// 对所有助手消息重复执行。缓存键：宽度 + 内容版本（updateContent 递增）。
		const version = this.__piAssistantStyleVersion ?? 0;
		// 流式中按时间分帧，让思考块的扫光/耗时有机会在帧之间推进。
		const frame = this.isStreaming === true ? Math.floor(Date.now() / ASSISTANT_STREAM_FRAME_MS) : 0;
		const cache = this.__piAssistantStyleCache;
		if (isAssistantCacheValid(cache, width, version, frame)) {
			recordRenderedLines(this.timestamp ?? 0, cache.lines.length);
			return cache.lines;
		}

		const contentWidth = Math.max(1, width - GUTTER);
		const lines = originalRender.call(this, contentWidth);
		if (lines.length === 0) {
			this.__piAssistantStyleCache = {
				schema: ASSISTANT_CACHE_SCHEMA,
				width,
				version,
				frame,
				lines,
				rawLineOf: [],
				lineShift: [],
				rawHeight: 0,
			};
			return lines;
		}

		const rawPadding =
			typeof this.outputPad === "number" ? this.outputPad : PI_OUTPUT_PAD;
		// 与 Markdown/Text 的 paddingX 上限保持一致，窄屏时不会误删正文缩进。
		const padding = Math.max(0, Math.min(rawPadding, Math.floor((contentWidth - 1) / 2)));

		// thinking 块（折叠预览/展开正文）的行不加 GUTTER：块左边缘与助手图标、
		// 工具面板同列。掩码与行数组同步过滤，保证下标不错位。
		const { mask: thinkMask, textLine } = analyzeContentLayout(this, contentWidth);

		const bodies: string[] = [];
		const lineThinking: boolean[] = [];
		const rawLineOf: number[] = [];
		const lineShift: number[] = [];
		// 被丢掉的围栏行上可能挂着 pi 的 OSC/CSI 标记（OSC133 zone 开始/结束就挂在
		// 首/末行行首）。标记不能跟着行一起没，先攒着，挂到下一条保留行行首；
		// 没有下一条就归到上一条末尾（与用户消息那边删末尾空行的处理同思路）。
		let pendingMarkers = "";
		for (let i = 0; i < lines.length; i++) {
			const thinking = thinkMask[i] === true;
			const stripped = stripLeftPadding(lines[i] ?? "", padding);
			const body = stripBackgroundSgr(stripped.text);
			// 去掉代码块的围栏边框行（```lang / ```）。渲染器把它们作为独立行输出，
			// 这里过滤掉，只保留缩进 + 语法高亮的代码内容。
			// 只对助手正文生效：thinking 预览/展开正文里的 ``` 是真实内容，删掉会丢字。
			if (!thinking && isFenceBorderLine(body)) {
				pendingMarkers += LEADING_CONTROL.exec(body)?.[0] ?? "";
				continue;
			}
			// 思考块用 UI_INDENT（1 列），正文用图标/悬挂缩进（GUTTER 列）。
			const prefixWidth = thinking ? UI_INDENT_WIDTH : GUTTER;
			bodies.push(pendingMarkers === "" ? body : `${pendingMarkers}${body}`);
			pendingMarkers = "";
			lineThinking.push(thinking);
			rawLineOf.push(i);
			lineShift.push(prefixWidth - stripped.removed);
		}
		if (pendingMarkers !== "" && bodies.length > 0) {
			const last = bodies.length - 1;
			bodies[last] = `${bodies[last] ?? ""}${pendingMarkers}`;
		}

		// 图标放在第一条“正文”行上；thinking 行只缩进，不显示图标。
		//
		// textLine === -1 表示整条消息没有正文（只有 thinking / toolCall）。此时
		// 如果继续用 `raw >= textLine` 找下标，-1 会命中下标 0——而 0 是 pi 加在
		// 第一个可见块前面的 Spacer(1)（不是 thinking），结果图标被贴到 spacer 上，
		// 屏幕上就是思考块上方多出一行只有图标的空行。这里对 -1 直接返回 -1
		// （不放图标），并给候选行加上“非 thinking + 有可见文字”的兜底，避免
		// 任何空行/换行 spacer 抢到图标。
		const ghostLine =
			textLine === undefined
				? bodies.findIndex((body, index) => !lineThinking[index] && hasVisibleText(body))
				: textLine < 0
					? -1
					: rawLineOf.findIndex(
							(raw, index) =>
								raw >= textLine &&
								!lineThinking[index] &&
								hasVisibleText(bodies[index] ?? ""),
						);
		const result = bodies.map((body, index) => {
			// 行首的 OSC/CSI 标记（如 OSC 133 zone start/end）必须留在**第 0 列**：
			// pi 的 alt-screen「跳到上一条/下一条消息」是找“行首的 \x1b]133;A”
			// （`TuiAltScreen.scrollToPrompt` 用的是 /^\x1b\]133;A/），如果先加缩进
			// 就会把助手消息从落点里排除。标记是零宽序列，放到缩进前不影响宽度、
			// 也不影响鼠标坐标换算（lineShift 只算可见列）。
			const markers = LEADING_CONTROL.exec(body)?.[0] ?? "";
			const content = markers ? body.slice(markers.length) : body;
			// 思考块与工具面板共用 UI_INDENT，保证两者左边缘始终对齐。
			if (lineThinking[index]) return `${markers}${UI_INDENT}${content}`;
			const prefix = index === ghostLine ? ASSISTANT_PREFIX : " ".repeat(GUTTER);
			return `${markers}${prefix}${content}`;
		});
		recordRenderedLines(this.timestamp ?? 0, result.length);
		this.__piAssistantStyleCache = {
			schema: ASSISTANT_CACHE_SCHEMA,
			width,
			version,
			frame,
			lines: result,
			rawLineOf,
			lineShift,
			rawHeight: lines.length,
		};
		return result;
	};

	// 三个"我们打上去的函数"先声明，方便统一记录所有权标记（unpatch 时校验）。
	let patchedHandleMouse: RuntimePrototype["handleMouse"];
	let patchedUpdateContent: RuntimePrototype["updateContent"];
	let patchedSetHideThinkingBlock: RuntimePrototype["setHideThinkingBlock"];

	// 正文右移 GUTTER、思考块右移 UI_INDENT、围栏边框行被删：鼠标事件的坐标
	// 都要反向换算回“未打补丁时”的位置，否则点击展开/链接会整体偏移。
	if (originalHandleMouse) {
		patchedHandleMouse = function (this: RuntimePrototype, event: MouseEventLike): unknown {
			// 子组件布局宽度是 contentWidth，按它换算才能命中 Container 的 mouseLayout 缓存。
			const innerWidth = event.width - GUTTER;
			if (innerWidth <= 0) return originalHandleMouse.call(this, event);

			// 布局信息必须与显示宽度、内容版本、结构版本全部对上才能用来换算。
			const cache = this.__piAssistantStyleCache;
			// 事件坐标可能小于缩进宽度（点在图标左侧）：钳到 0，否则会把负坐标传给子组件。
			const approxX = Math.max(0, event.x - GUTTER);
			if (!isAssistantCacheValid(cache, event.width, this.__piAssistantStyleVersion ?? 0)) {
				// 没有可用的布局信息：按正文的位移近似（最常见的情况）。
				return originalHandleMouse.call(this, {
					...event,
					x: approxX,
					width: innerWidth,
				});
			}

			const rawY = cache.rawLineOf[event.y];
			if (rawY === undefined) {
				return originalHandleMouse.call(this, {
					...event,
					x: approxX,
					width: innerWidth,
				});
			}
			return originalHandleMouse.call(this, {
				...event,
				x: Math.max(0, event.x - (cache.lineShift[event.y] ?? GUTTER)),
				y: rawY,
				width: innerWidth,
				height: cache.rawHeight,
			});
		};
		proto.handleMouse = patchedHandleMouse;
	}

	// 重建内容时：用户没显式切换过就默认折叠（尊重设置里的 hideThinkingBlock），
	// 并把折叠态标签换成带计时的自定义标题。
	const originalUpdateContent = proto.updateContent;
	if (typeof originalUpdateContent === "function") {
		proto.__piAssistantGutterOriginalUpdateContent = originalUpdateContent;
		patchedUpdateContent = function (
			this: RuntimePrototype,
			message?: unknown,
			isStreaming?: boolean,
		): void {
			// 只在用户尚未显式切换过时默认折叠：pi 的 toggleThinkingBlockVisibility /
			// 设置面板会调 setHideThinkingBlock，那里会打上“用户已选择”标记，
			// 之后这里不再覆盖，否则全局“显示思考”永远失效。
			if (!this.__piAssistantHideThinkingUserSet) this.hideThinkingBlock = true;
			// 渲染缓存失效信号：内容重建（包括 thinking 展开/收起、换预览）都经过这里。
			this.__piAssistantStyleVersion = (this.__piAssistantStyleVersion ?? 0) + 1;
			originalUpdateContent.call(this, message, isStreaming);
			// pi 的 invalidate() 只带 message 调用（isStreaming 为 undefined），
			// 这里兜底取组件自身的流式状态，避免流式中的思考计时被误标为已结束。
			try {
				applyThinkingHeaders(
					this,
					message as AssistantMessageLike | undefined,
					isStreaming ?? this.isStreaming,
				);
			} catch {
				// 标题/预览只是装饰：失败就保留 pi 自己的标签，不能影响消息本体。
			}
		};
		proto.updateContent = patchedUpdateContent;
		proto.__piAssistantGutterUpdatePatched = true;
	}

	// 用户显式切换全局 thinking 可见性时打标记（内部会自己调 updateContent）。
	const originalSetHideThinkingBlock = proto.setHideThinkingBlock;
	if (typeof originalSetHideThinkingBlock === "function") {
		proto.__piAssistantGutterOriginalSetHideThinkingBlock = originalSetHideThinkingBlock;
		patchedSetHideThinkingBlock = function (this: RuntimePrototype, hide: boolean): void {
			this.__piAssistantHideThinkingUserSet = true;
			originalSetHideThinkingBlock.call(this, hide);
		};
		proto.setHideThinkingBlock = patchedSetHideThinkingBlock;
	}

	proto.__piAssistantGutterPatchedRender = patchedRender;
	proto.__piAssistantGutterPatchedHandleMouse = patchedHandleMouse;
	proto.__piAssistantGutterPatchedUpdateContent = patchedUpdateContent;
	proto.__piAssistantGutterPatchedSetHideThinkingBlock = patchedSetHideThinkingBlock;
	proto.__piAssistantGutterPatched = true;
}

/** 恢复 pi 原来的渲染方法；删除扩展或重启时使用。 */
/**
 * 恢复 pi 原来的方法；删除扩展/重启时使用。
 *
 * 只恢复"当前仍是我们打上去的那个函数"的槽位：`/reload` 时新实例会先打补丁，
 * 旧实例的 shutdown 可能在之后才跑——那时它已经没有所有权了，什么都不该动。
 */
export function unpatchAssistantMessageStyle(): void {
	const proto = AssistantMessageComponent.prototype as unknown as RuntimePrototype;
	const ownsRender = proto.__piAssistantGutterPatchedRender === proto.render;
	const ownsUpdate = proto.__piAssistantGutterPatchedUpdateContent === proto.updateContent;
	const ownsMouse = proto.__piAssistantGutterPatchedHandleMouse === proto.handleMouse;
	const ownsHide = proto.__piAssistantGutterPatchedSetHideThinkingBlock === proto.setHideThinkingBlock;
	if (!ownsRender && !ownsUpdate && !ownsMouse && !ownsHide) return;

	if (ownsRender && proto.__piAssistantGutterOriginalRender) {
		proto.render = proto.__piAssistantGutterOriginalRender;
	}
	if (ownsMouse) {
		if (proto.__piAssistantGutterOriginalHandleMouse) {
			proto.handleMouse = proto.__piAssistantGutterOriginalHandleMouse;
		} else {
			delete proto.handleMouse;
		}
	}
	if (ownsUpdate && proto.__piAssistantGutterOriginalUpdateContent) {
		proto.updateContent = proto.__piAssistantGutterOriginalUpdateContent;
	}
	if (ownsHide && proto.__piAssistantGutterOriginalSetHideThinkingBlock) {
		proto.setHideThinkingBlock = proto.__piAssistantGutterOriginalSetHideThinkingBlock;
	}

	if (ownsRender) {
		delete proto.__piAssistantGutterOriginalRender;
		delete proto.__piAssistantGutterPatchedRender;
		delete proto.__piAssistantGutterPatched;
	}
	if (ownsMouse) {
		delete proto.__piAssistantGutterOriginalHandleMouse;
		delete proto.__piAssistantGutterPatchedHandleMouse;
	}
	if (ownsUpdate) {
		delete proto.__piAssistantGutterOriginalUpdateContent;
		delete proto.__piAssistantGutterPatchedUpdateContent;
		delete proto.__piAssistantGutterUpdatePatched;
	}
	if (ownsHide) {
		delete proto.__piAssistantGutterOriginalSetHideThinkingBlock;
		delete proto.__piAssistantGutterPatchedSetHideThinkingBlock;
	}
}

