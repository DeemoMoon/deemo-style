/**
 * 共享层：功能开关、对齐系统与配色常量、块计时、文本/路径/预览格式化、
 * 折叠预览算法、上下文占用缓存、按宽度缓存的视图基类。
 *
 * 这一层不 import 其它分区模块；其它模块只从这里取共享件。
 */

import {
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	keyHint,
} from "@earendil-works/pi-coding-agent";
import {
	join,
} from "node:path";

// ---- 一、功能开关 ------------------------------------------------------------

/** 想临时停用某个功能块，把对应项改成 false（或注释掉）即可。 */
export const FEATURES = {
	/** 助手消息样式（\uE22C 缩进 / 去背景 / 思考块折叠预览）。 */
	assistantStyle: true,
	/** 用户消息样式（黄色加粗 + \uE370 图标 + 左移一列）。 */
	userMessage: true,
	/** 助手消息的三级及更深标题改写成 ▸ 前缀，绕开 pi 原样保留 "###" 的规则。 */
	headingRewrite: true,
	/** 圆角输入框与输入符号。 */
	roundedEditor: true,
	/** 输入框上方信息条。 */
	infoBar: true,
	/** 输入框下方状态栏。 */
	statusline: true,
	/** 启动页资源清单。 */
	startupHeader: true,
	/** 技能调用横幅样式。 */
	skillBanner: true,
	/** `!` 内联命令的绿色圆角边框。 */
	bashExecBox: true,
	/** bash/codemode/read/write/edit/grep/find/ls/powershell 工具面板。 */
	toolPanels: true,
	/** 整轮结束后把视口带回回复开头（长回复 + 原来在跟随时）。 */
	jumpToReplyStart: true,
	/** 运行中块的标题扫光（图标 + 工具名 / 思考中 / `!` 短命令）。 */
	shimmerTitle: true,
	/** 会话信息面板（`alt+i` / `/info`）：模型/token/费用/上下文/用时/目录。 */
	sessionInfoPanel: true,
} as const;

// ---- 二、共享常量（对齐系统 / 配色 / 图标 / 预览宽度） ----------------------

export type Rgb = readonly [number, number, number];

/** 24-bit 前景色转义前缀。 */
export const sgr = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
/** 用 24-bit 前景色渲染一段文字。 */
export const fg24 = (rgb: Rgb, text: string): string => `${sgr(rgb)}${text}\x1b[39m`;

// ---- 标题扫光（运行中的块） ------------------------------------------------
//
// 不新开定时器：相位是「时间戳 + 字符位置」的纯函数，在每次 render 时现算，
// 靠 pi 本来就有的帧（working spinner 80ms / 信息条 tick 200ms / `!` 的 loader
// 与输出推送）带动。这和耗时数字的跳动方式完全一致（见文件头的 BlockClock 说明）。

/** 扫光往返周期（毫秒）：左 → 右 → 左。 */
const SHIMMER_PERIOD_MS = 1400;
/** 高亮带宽度（字符数）：越大越柔和。 */
const SHIMMER_BAND = 2.5;
/** 高亮处向白色混合的最大比例（只提亮，不换色相）。 */
const SHIMMER_MIX = 0.78;
/** 高亮色：纯白。 */
const SHIMMER_HIGHLIGHT: Rgb = [255, 255, 255];
/**
 * 缓存键用的相位粒度（毫秒）。比 pi 的 80ms 帧细，动画不会因缓存漏帧，
 * 同时避免每帧都重算同一个键。
 */
const SHIMMER_FRAME_MS = 40;

/** 两个颜色按 t（0~1）线性混合。 */
export function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return [
		Math.round(from[0] + (to[0] - from[0]) * clamped),
		Math.round(from[1] + (to[1] - from[1]) * clamped),
		Math.round(from[2] + (to[2] - from[2]) * clamped),
	];
}

/** 相位（0~1）：三角波，0 = 高亮带在最左，1 = 在最右。 */
export function shimmerPosition(startedAt: number, now = Date.now()): number {
	const phase = ((now - startedAt) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
	// JS 的 % 对负数返回负数，先归一化回 [0,1)
	const wrapped = phase < 0 ? phase + 1 : phase;
	return wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;
}

/** 扫光缓存键（帧序号）：相位变了标题就得重画，否则动画会停在缓存里。 */
export function shimmerFrame(startedAt: number | undefined, now = Date.now()): number {
	if (startedAt === undefined) return 0;
	return Math.floor((now - startedAt) / SHIMMER_FRAME_MS);
}

/**
 * 文本扫光：每个字符按到高亮带中心的距离从 base 混向白色，带中心左右往返。
 *
 * SGR 是零宽转义，因此 visibleWidth 与原文本一致，后面的 truncateToWidth 不受影响；
 * `startedAt` 缺失（历史块 / 已结束）时退化成单色，不闪烁。
 */
export function shimmerText(
	text: string,
	base: Rgb,
	startedAt: number | undefined,
	now = Date.now(),
): string {
	if (!FEATURES.shimmerTitle || startedAt === undefined || text.length === 0) {
		return `${sgr(base)}${text}${RESET_FG}`;
	}

	const chars = Array.from(text);
	const center = shimmerPosition(startedAt, now) * Math.max(0, chars.length - 1);
	let out = "";
	for (let index = 0; index < chars.length; index++) {
		const distance = Math.abs(index - center);
		// 平滑衰减的高亮带：带中心最亮，带外回到原色。
		const weight = distance >= SHIMMER_BAND ? 0 : (1 - distance / SHIMMER_BAND) ** 2;
		out += `${sgr(mixRgb(base, SHIMMER_HIGHLIGHT, weight * SHIMMER_MIX))}${chars[index]}`;
	}
	return `${out}${RESET_FG}`;
}


// ---- 对齐系统（全文件唯一出处） -------------------------------------------
//
// 屏幕上只有两套左边缘，其余缩进/内边距全部由下面两个数字派生，改一处即全局一致：
//
//   消息族（用户消息 / 助手正文）：图标占第 0 列 + 1 个空格，正文悬挂缩进到
//     第 MESSAGE_ICON_WIDTH 列；
//   块族（思考块 / 工具面板 / 技能横幅 / `!` 命令框 / 信息条 / 状态栏 / 输入符号）：
//     统一从第 BLOCK_INDENT_WIDTH 列开始，正好落在消息族图标右侧一列。
//
// 两族唯一的纽带就是「块族首列 = 消息族图标右侧」这句话；下面的 GUTTER /
// UI_INDENT / CHROME_PAD / USER_PAD_SHIFT / PROMPT_WIDTH 都是派生值，不要单独改。

/** 消息族：图标 + 其后 1 个空格的宽度（用户 \uE370 与助手 \uE22C 共用）。 */
export const MESSAGE_ICON_WIDTH = 2;
/** 块族：统一左缩进列数（= 消息族图标右侧一列）。 */
export const BLOCK_INDENT_WIDTH = 1;

/** pi 的 Markdown / Text 默认左内边距（outputPad）：用户消息靠减掉它左移。 */
export const PI_OUTPUT_PAD = 1;

/** 助手正文 / 用户消息正文的悬挂缩进 = 图标 + 空格。 */
export const GUTTER = MESSAGE_ICON_WIDTH;
/** 块族缩进字符串。 */
export const UI_INDENT_WIDTH = BLOCK_INDENT_WIDTH;
export const UI_INDENT = " ".repeat(BLOCK_INDENT_WIDTH);

/** 信息条 / 状态栏缩进：与输入框内的输入符号同列，即块族首列。 */
export const CHROME_LEFT_PAD = BLOCK_INDENT_WIDTH;
export const CHROME_PAD = " ".repeat(BLOCK_INDENT_WIDTH);

export const BOLD_ON = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";
export const RESET_FG = "\x1b[39m";

/** 工具面板与各处状态色（24-bit）。 */
export const ACCENT_BLUE: Rgb = [95, 135, 215]; // bash / powershell / 技能横幅
export const ACCENT_CYAN: Rgb = [95, 215, 215]; // read
export const ACCENT_GREEN: Rgb = [95, 191, 127]; // write / ls / `!` 命令框
export const ACCENT_VIOLET: Rgb = [177, 142, 250]; // edit / grep / find
/** 状态档位色（ctx 色条 / diff / 错误 / 警告）。 */
export const OK_GREEN: Rgb = [63, 185, 80];
export const WARN_YELLOW: Rgb = [227, 179, 65];
export const BAD_RED: Rgb = [248, 81, 73];
/** 预览内容 / 分隔符的暗灰。 */
export const MUTED = "\x1b[38;2;128;128;128m";
/** 更暗一档的灰：未占用格子 / `!!` 边框。 */
export const DIM_GRAY = "\x1b[38;2;110;110;110m";
/** 天青（速度图标低档色 / 编辑器命令符号）；Rgb 原值单独导出，动画需要它。 */
export const SKY_BLUE_RGB: Rgb = [125, 211, 252];
export const SKY_BLUE = sgr(SKY_BLUE_RGB);
/** 思考块的淡黄色（扫光要 Rgb 原值，SGR 交给 sgr() 生成，别写成两份常量）。 */
export const THINKING_YELLOW_RGB: Rgb = [240, 216, 130];
export const THINKING_YELLOW = sgr(THINKING_YELLOW_RGB);
/** pi logo 的珊瑚色（输入符号 ❯）。 */
export const CORAL = "\x1b[38;2;228;138;122m";

/** Nerd Font 图标（宽度均为 1 列；图标 + 空格 = 2 列，与缩进计算配套）。 */
export const ICON_BASH = "\uF489";
export const ICON_READ = "\uDB80\uDE1E"; // Plane 15，代理对
export const ICON_WRITE = "\uEE3C";
export const ICON_EDIT = "\uDB83\uDDC9"; // Plane 15，代理对
export const ICON_SEARCH = "\uEBC4"; // grep/find/powershell/ls/`!` 命令
export const ICON_CLOCK = "\uE382"; // 各面板与思考块的耗时
export const ICON_THINKING = "\uEC59"; // 思考块
export const ICON_SKILL = "\uE947"; // 技能横幅

/** 工具面板折叠预览行数。 */
export const PANEL_PREVIEW_LINES = 2;
/** `!` 命令框折叠预览行数（与 pi 原行为一致）。 */
export const EXEC_PREVIEW_LINES = 20;
/** 技能横幅折叠预览行数。 */
export const SKILL_PREVIEW_LINES = 4;
/**
 * 折叠预览的 ⎿ 连接符（工具面板 / 思考块 / 技能横幅共用；ls 框无连接符）：
 * 块缩进之后空 2 列接 ⎿，⎿ 之后再空 2 列接正文，因此正文可用宽度 =
 * 区域宽度 - PREVIEW_CONNECTOR_WIDTH。
 */
export const PREVIEW_CONNECTOR_LEAD = "  ";
export const PREVIEW_CONNECTOR_GAP = "  ";
/** 连接符占用的总列数（前导空格 + ⎿ + 后置空格）。 */
export const PREVIEW_CONNECTOR_WIDTH = PREVIEW_CONNECTOR_LEAD.length + 1 + PREVIEW_CONNECTOR_GAP.length;
export const PREVIEW_CONNECTOR_FIRST = `${PREVIEW_CONNECTOR_LEAD}⎿${PREVIEW_CONNECTOR_GAP}`;
export const PREVIEW_CONNECTOR_REST = " ".repeat(PREVIEW_CONNECTOR_WIDTH);

// 路径显示工具单独成文件（path-text.ts），这里 re-export 保持既有 import 路径不变
export * from "./path-text.ts";

// ---- 三、共享工具（计时 / 上下文 / 文本 / 预览格式化 / 缓存基类） ------

export interface ThemeLike {
	fg(token: string, text: string): string;
}

/**
 * 所有“有生命周期”的块共用的计时状态：只存时间戳，耗时在渲染时现算。
 *
 * 思考块、工具面板、`!` 内联命令都用这一套：块一出现就开始计时、结束就地
 * 定格、块本身不持有任何定时器（帧由 pi 已有的渲染节拍提供，见文件头）。
 */
export interface BlockClock {
	startedAt?: number;
	endedAt?: number;
}

/** 面板计时状态（各面板的附加字段由子接口补上）。 */
export type TimerState = BlockClock;

export function getTimerState(context: { state: unknown }): TimerState {
	if (!context.state || typeof context.state !== "object") {
		context.state = {};
	}
	return context.state as TimerState;
}

// ---- 上下文占用（信息条 + 状态栏共用一份） --------------------------------

/** pi 的上下文占用快照。 */
export type ContextUsageLike = ReturnType<ExtensionContext["getContextUsage"]>;

/**
 * `ctx.getContextUsage()` 每次都会重建整个会话投影（O(会话规模)），而信息条和
 * 状态栏在同一个 message_end 上各要一次。这里按「会话 + 分支锚点 + 模型」缓存：
 * 条目追加、切分支、compaction、换模型都会改变 key，因此缓存不会过期。
 */
let contextUsageCache: { key: string; value: ContextUsageLike } | undefined;

export function contextUsageCached(ctx: ExtensionContext): ContextUsageLike {
	const manager = ctx.sessionManager;
	const key = `${manager.getSessionId()}\u0000${manager.getLeafId() ?? ""}\u0000${ctx.model?.id ?? ""}`;
	if (contextUsageCache?.key === key) return contextUsageCache.value;
	const value = ctx.getContextUsage();
	contextUsageCache = { key, value };
	return value;
}

/**
 * 扩展状态文本缓存（`ctx.ui.setStatus()` 的内容）。
 *
 * 关键点：缓存基线必须存**排好序**的结果。以前是把同一个数组存进去、再就地
 * `sort()`，于是下一帧拿"插入序"跟"字母序"比，永远不相等 → 每帧都重排序 +
 * 跑两遍正则。状态栏每帧都调它，所以这个 bug 会被放大成 20fps 的空转。
 */
export class ExtensionStatusText {
	private entries: Array<[string, string]> = [];
	private text = "";
	/** 真正重算的次数（测试用来确认缓存命中）。 */
	updates = 0;

	update(statuses: ReadonlyMap<string, string>): string {
		const previous = this.entries;
		let changed = previous.length !== statuses.size;
		const entries: Array<[string, string]> = [];
		let index = 0;
		for (const [key, value] of statuses) {
			entries.push([key, value]);
			const old = previous[index++];
			if (!changed && (old === undefined || old[0] !== key || old[1] !== value)) changed = true;
		}
		if (!changed) return this.text;

		// 缓存基线保持"插入序"（下一次就按插入序比对），排序只作用于输出用的副本。
		this.entries = entries;
		this.updates += 1;
		this.text = [...entries]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
			.join(" ");
		return this.text;
	}
}

/** 会话结束/切换时丢掉缓存（新会话的 leaf id 虽然不会撞，但没必要留着）。 */
export function resetContextUsageCache(): void {
	contextUsageCache = undefined;
}

// ---- 统一动画节拍（呼吸文案 / 信息条 / 沙漏包络共用） ---------------------
//
// 以前每块自己 setInterval（呼吸 60ms、信息条 120ms、spinner 180ms），
// 每次打点都是一次 requestRender → 整屏重渲染（pi 的 ScrollView 无视口裁剪）。
// 现在我们的三个消费方共用同一个 interval，pi 的 TUI 又会在 16ms 窗口内合并
// 重复请求，所以任务期间的帧率从“几个 timer 之和”降到“取最小间隔”（见 ANIMATION_TICK_MS）。

/**
 * 节拍间隔（毫秒）：取各消费方需要的最小值。
 *
 * 这个值直接等于"任务期间每秒一次的全 transcript 重渲染次数"（pi 的
 * MIN_RENDER_INTERVAL_MS=16 不会帮你合并，ScrollView 也没有视口裁剪），
 * 所以别轻易调小：100ms = 10fps 已经够扫光/呼吸看着顺，200ms 会明显卡顿。
 */
export const ANIMATION_TICK_MS = 100;

type TickListener = (now: number) => void;

const tickListeners = new Map<string, TickListener>();
let tickTimer: ReturnType<typeof setInterval> | undefined;

function startTicker(): void {
	if (tickTimer) return;
	tickTimer = setInterval(() => {
		const now = Date.now();
		for (const listener of [...tickListeners.values()]) listener(now);
	}, ANIMATION_TICK_MS);
	// 不阻止进程退出。
	(tickTimer as { unref?: () => void }).unref?.();
}

function stopTicker(): void {
	if (!tickTimer) return;
	clearInterval(tickTimer);
	tickTimer = undefined;
}

/**
 * 订阅动画节拍（幂等：同 id 会替换旧回调，方便 /reload）。
 *
 * 返回退订函数；最后一个订阅者退订时定时器自动停掉，空闲时不会有任何 timer。
 */
export function subscribeAnimationTick(id: string, listener: TickListener): () => void {
	tickListeners.set(id, listener);
	startTicker();
	return () => {
		if (tickListeners.get(id) === listener) tickListeners.delete(id);
		if (tickListeners.size === 0) stopTicker();
	};
}

/** pi 的单条消息 usage（input 不含缓存部分，缓存单独计）。 */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** 一条消息的 prompt 总量（含缓存读写）；信息条与状态栏共用同一口径。 */
export function promptTokens(usage: UsageLike | undefined): number {
	return usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
}

/** 消息内容里的一个 thinking 块（pi-ai 的形状，只取这里用到的字段）。 */
export interface ThinkingContentLike {
	type?: string;
	thinking?: string;
}

/** 信息条 / 状态栏读消息时的最小形状。 */
export interface InfoMessageLike {
	role?: string;
	usage?: UsageLike;
	content?: string | ThinkingContentLike[];
}

/**
 * 面板/信息条共用的耗时格式：1.5s、2 m 48 s、1 h 2 m 3 s。
 * 单位字母两侧留空格——宽字形的 m/h 紧贴数字会显得挤。
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes} m ${remainder} s`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} m ${remainder} s`;
}

/**
 * 块耗时的基础格式：不足 1 秒用毫秒（read/write/edit 这类本机工具通常
 * 只有几毫秒到几十毫秒，用一位小数秒会永远显示 0.0s），其余交给
 * formatDuration。信息条仍用 formatDuration，不受影响。
 */
export function formatPanelDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	return clamped < 1000 ? `${Math.round(clamped)}ms` : formatDuration(clamped);
}

/**
 * 活跃打点（幂等）：active 时记开始时间，不 active 时定格结束时间。
 * 反复调用不会推迟开始时间，也不会覆盖已定格的结束时间。
 */
export function touchClock(clock: BlockClock, active: boolean, now = Date.now()): void {
	if (active) {
		if (clock.startedAt === undefined) {
			clock.startedAt = now;
			clock.endedAt = undefined;
		}
		return;
	}
	if (clock.startedAt !== undefined) clock.endedAt ??= now;
}

/** 块耗时（毫秒）：活跃块现算，结束块定格；没有计时数据时返回 undefined。 */
export function clockElapsedMs(clock: BlockClock, now = Date.now()): number | undefined {
	if (clock.startedAt === undefined) return undefined;
	return (clock.endedAt ?? now) - clock.startedAt;
}

/** 块耗时文案（统一格式：17ms / 1.2s / 2 m 48 s）；没有数据时返回 undefined。 */
export function clockText(clock: BlockClock, now = Date.now()): string | undefined {
	const ms = clockElapsedMs(clock, now);
	return ms === undefined ? undefined : formatPanelDuration(ms);
}

/**
 * `!` 命令的耗时文案。
 *
 * 回放历史 `!` 命令时，pi 会「构造（status=running）→ appendOutput → setComplete」
 * 一口气跑完，时钟只跨一个事件循环（0~几 ms）。真实命令不可能一帧内跑完，
 * 所以低于一帧阈值就当作没有可信计时，不伪造 `0ms`（与历史工具块同一口径）。
 */
export const MIN_EXEC_CLOCK_MS = 16;
export function execClockText(clock: BlockClock | undefined): string | undefined {
	if (!clock) return undefined;
	const ms = clockElapsedMs(clock);
	if (ms === undefined) return undefined;
	if (clock.endedAt !== undefined && ms < MIN_EXEC_CLOCK_MS) return undefined;
	return formatPanelDuration(ms);
}

/** 去掉 "1.0M" 这种多余的 ".0"。 */
export function trimZero(text: string): string {
	return text.replace(/\.0([kM])$/, "$1");
}

/** token 数缩写：3.2k、45k、1.2M。 */
export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return trimZero(`${(count / 1000).toFixed(1)}k`);
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return trimZero(`${(count / 1_000_000).toFixed(1)}M`);
	return `${Math.round(count / 1_000_000)}M`;
}

/** ANSI CSI / OSC 序列。 */
/**
 * ANSI 转义序列的**正则源码片段**（不含标志位，可拼进更大的表达式）。
 * 全文件只此一份定义：stripAnsi 的全局匹配、行首前缀识别都从这里拼。
 */
export const OSC_CSI_SOURCE =
	"\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b\\[[0-9;?]*[ -/]*[@-~]";
/** 再加上单字符转义（ESC + 单字节），只用于 stripAnsi。 */
export const ANSI_SEQUENCE = new RegExp(`${OSC_CSI_SOURCE}|\\x1b[@-_]`, "g");
/** 行首的一串 OSC/CSI 序列（保留控制序列，只处理其后的空格）。 */
export const LEADING_ANSI_SOURCE = `(?:(?:${OSC_CSI_SOURCE})*)`;
/** 行首的 OSC/CSI 控制序列（模块级常量：map 回调里每行都会用到）。 */
export const LEADING_CONTROL = new RegExp(`^${LEADING_ANSI_SOURCE}`);
/** 行首连续空格的匹配。 */
export const LEADING_SPACES = /^ +/;
/** 除换行/制表符外的 C0 控制字符。 */
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}

export function cleanText(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(CONTROL_CHARS, "");
}

/** 去掉 ANSI 后是否还有可见字符（判断空行用）。 */
export function hasVisibleText(line: string): boolean {
	return /\S/.test(line.replace(ANSI_SEQUENCE, ""));
}

/** “还有 N 行”提示的英文名词（单复数）。 */
export function moreLinesNoun(remaining: number): string {
	return remaining === 1 ? "line" : "lines";
}

/**
 * 折叠预览的源：头部源行 + 源行总数。
 *
 * 长文本（思考链、技能说明）只需要前几行就能填满预览，全量 split/join 会把
 * 每帧成本拉成 O(文本长度)；这类调用方用 headLinesOfTexts() 先裁出头部。
 */
export interface PreviewSource {
	head: string[];
	/** 源行总数（含尾部空行；数组形式由 collapsePreviewLines 自己裁掉）。 */
	total: number;
}

/**
 * 折叠预览的核心算法（工具面板 / 思考块 / 技能横幅 / ls 框共用）：
 * 逐源行 wrap，收满 previewLines 行即停。
 *
 * 剩余数量按**源行数**计，不精确到视觉行：一旦收满就不再 wrap 后面的行，
 * 折叠态的成本从 O(全部源行)（旧实现全量 wrap 后再 slice）降到 O(前几行)。
 * 被截在中间的那条源行也算未显示；尾部空行不计数，避免“只多一个换行”
 * 也报 N more lines。
 */
export function collapsePreviewLines(
	source: readonly string[] | PreviewSource,
	previewLines: number,
	contentWidth: number,
	style: (line: string) => string,
): { lines: string[]; remaining: number } {
	const isArray = Array.isArray(source);
	const head = isArray ? (source as readonly string[]) : (source as PreviewSource).head;
	let total = isArray ? head.length : (source as PreviewSource).total;

	// 尾部空行不参与计数（也不进预览）。
	// 数组入参可以直接砍 total；PreviewSource 的 head 之外的行数本来就没记，
	// 所以只能边砍 total 边砍 head 里能看见的那部分——够用了（差值是尾部空行）。
	if (isArray) {
		while (total > 0 && !(head[total - 1] ?? "").trim()) total--;
	} else {
		// PreviewSource：head 之外的行数不可见，只能对 head 覆盖到的尾部空行做裁剪
		const covered = Math.min(total, head.length);
		let visible = covered;
		while (visible > 0 && !(head[visible - 1] ?? "").trim()) visible--;
		total -= covered - visible;
	}

	const lines: string[] = [];
	let remaining = 0;
	for (let i = 0; i < head.length && i < total && remaining === 0; i++) {
		for (const segment of wrapTextWithAnsi(style(head[i] ?? ""), contentWidth)) {
			if (lines.length < previewLines) {
				lines.push(segment);
				continue;
			}
			// 从这条源行起（含它未显示的剩余部分）都算未显示。
			remaining = total - i;
			break;
		}
	}
	return { lines, remaining };
}

/**
 * 取多段文本（段间用一个空行连接）的前 maxLines 条源行，并顺手数出总行数。
 *
 * 只对真正需要参与换行的头部行做 slice：思考链每帧都要出预览，全量 split
 * 再 join 是 O(文本长度) 的重复开销（旧实现每个 token 都把整段思考 join 一次）。
 */
export function headLinesOfTexts(texts: readonly string[], maxLines: number): PreviewSource {
	const head: string[] = [];
	let total = 0;
	const pushLine = (line: string): void => {
		total++;
		if (head.length < maxLines) head.push(line);
	};

	for (let index = 0; index < texts.length; index++) {
		if (index > 0) pushLine("");
		const text = texts[index] ?? "";
		let start = 0;
		while (true) {
			const newline = text.indexOf("\n", start);
			if (newline === -1) {
				// 文本以换行结尾时，末尾的空片段不算一行。
				if (start < text.length) pushLine(text.slice(start));
				break;
			}
			pushLine(text.slice(start, newline));
			start = newline + 1;
		}
	}
	// 尾部空行既不算预览行、也不该算进"还有多少行"。
	// （head 被 maxLines 截断时只能扣 head 里看得见的那部分。）
	const covered = Math.min(total, head.length);
	let visible = covered;
	while (visible > 0 && !(head[visible - 1] ?? "").trim()) visible--;
	const trimmed = covered - visible;
	if (trimmed > 0) {
		head.length = visible;
		total -= trimmed;
	}
	return { head, total };
}

export function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 去掉 UTF-8 BOM（readFile 不剥；JSON.parse 与 diff 都容不下 BOM）。 */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}





/**
 * 从左侧截断、保留末尾（文件名部分）。输入应为不含 ANSI 的纯文本；
 * 逐字符从尾部累加，避免每步重新拼接整段字符串的 O(n²)。
 */
export function shortenTail(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	// ASCII 快路径：宽度 = 字符数，直接切片，省掉逐字符 visibleWidth 调用
	// （shortenTail / formatCwd 在启动页与状态栏会走）。
	if (ASCII_ONLY.test(text)) return `…${text.slice(Math.max(0, text.length - (maxWidth - 1)))}`;

	const chars = Array.from(text);
	const kept: string[] = [];
	let keptWidth = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i] ?? "";
		const width = visibleWidth(ch);
		if (keptWidth + width > maxWidth - 1) break;
		kept.push(ch);
		keptWidth += width;
	}
	return `…${kept.reverse().join("")}`;
}

/** 纯可打印 ASCII（每个码位 1 列）。 */
export const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** 单行路径摘要：放得下原样返回；放不下保留末尾几段；再放不下从左侧截断保住文件名。 */
export function summarizePath(pathDisplay: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(pathDisplay) <= maxWidth) return pathDisplay;

	const separator = pathDisplay.includes("\\") ? "\\" : "/";
	const parts = pathDisplay.split(/[\\/]+/).filter((part) => part.length > 0);
	if (parts.length <= 1) return shortenTail(pathDisplay, maxWidth);

	let best = "";
	for (let take = 1; take <= parts.length; take++) {
		const tail = parts.slice(parts.length - take).join(separator);
		const candidate = `\u2026${separator}${tail}`;
		if (visibleWidth(candidate) > maxWidth) break;
		best = candidate;
	}
	if (best) return best;

	return shortenTail(pathDisplay, maxWidth);
}

/** resultOutput 的按对象缓存：同一 result（展开/收起、重复渲染）不重复清洗。 */
export const outputCache = new WeakMap<object, string>();

/** 工具结果的文本输出（合并 text 部分 + 清洗）。 */
export function resultOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	const cached = outputCache.get(result);
	if (cached !== undefined) return cached;
	const text = cleanText(
		result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	).trim();
	outputCache.set(result, text);
	return text;
}

export function getTextComponent(context: { lastComponent: unknown }): Text {
	return context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

export function setText(context: { lastComponent: unknown }, text: string): Text {
	const component = getTextComponent(context);
	component.setText(text);
	return component;
}

/** 执行中的第二行（各面板共用）。 */
export function runningLine(theme: ThemeLike): string {
	return `${theme.fg("dim", PREVIEW_CONNECTOR_FIRST)}${theme.fg("text", "执行中...")}`;
}

/** 工具渲染器上下文（pi ToolRenderContext 的本地形状，含我们用到的字段）。 */
export interface ToolRenderContextLike {
	args?: unknown;
	state: unknown;
	lastComponent: unknown;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	durationMs?: number;
	/**
	 * pi 的渲染上下文提供 keyHint()（会跟随用户的 keybindings.json）。
	 * 直接 import 包里的 keyHint 只在"扩展和 pi 用同一份模块实例"时等价，
	 * 所以这里优先用上下文给的。
	 */
	keyHint?(binding: string, description: string): string;
	invalidate(): void;
}

/** 工具结果（pi 工具结果的本地形状）。 */
export interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

/** renderResult 的选项（pi 的本地形状）。 */
export interface RenderResultOptionsLike {
	expanded: boolean;
	isPartial: boolean;
}

/** `⎿` 连接的折叠预览格式化（bash/read/write/edit/grep/find/powershell 共用）。 */
/** keyHint 的形态（pi 渲染上下文提供，等于一个纯格式化函数）。 */
export type KeyHintFn = (binding: string, description: string) => string;

/** 优先用调用方给的 keyHint（来自渲染上下文），否则退回包里的实现。 */
function resolveKeyHint(hint: KeyHintFn | undefined): KeyHintFn {
	return hint ?? keyHint;
}

export function formatIndentedPreview(
	sourceLines: string[],
	expanded: boolean,
	isError: boolean,
	theme: ThemeLike,
	width: number,
	options: {
		emptyLabel?: string;
		colorize?: (line: string) => string;
		keyHint?: KeyHintFn;
	} = {},
): string[] {
	const firstPrefix = PREVIEW_CONNECTOR_FIRST;
	const nextPrefix = PREVIEW_CONNECTOR_REST;
	const contentWidth = Math.max(1, width - PREVIEW_CONNECTOR_WIDTH);

	if (!sourceLines.some((line) => line.trim())) {
		const label = theme.fg(
			isError ? "error" : "muted",
			isError ? "执行失败" : (options.emptyLabel ?? "(无输出)"),
		);
		return wrapTextWithAnsi(label, contentWidth).map(
			(segment, index) => `${index === 0 ? firstPrefix : nextPrefix}${segment}`,
		);
	}

	const style = isError
		? (line: string) => theme.fg("error", line)
		: options.colorize
			? options.colorize
			: (line: string) => theme.fg("text", line);
	const withPrefix = (segments: readonly string[]): string[] =>
		segments.map((segment, index) => `${index === 0 ? firstPrefix : nextPrefix}${segment}`);

	if (expanded) {
		// 展开态：全部显示，不计数。
		const visualLines: string[] = [];
		for (const line of sourceLines) {
			visualLines.push(...wrapTextWithAnsi(style(line), contentWidth));
		}
		return withPrefix(visualLines);
	}

	// 折叠态：收满 PANEL_PREVIEW_LINES 行即停，剩余按源行数计（见 collapsePreviewLines）。
	const { lines, remaining } = collapsePreviewLines(
		sourceLines,
		PANEL_PREVIEW_LINES,
		contentWidth,
		style,
	);
	const visibleLines = withPrefix(lines);
	if (remaining > 0) {
		const hint =
			`${theme.fg("muted", `... (${remaining} more ${moreLinesNoun(remaining)}, `)}` +
			`${keyHint("app.tools.expand", "to expand")}` +
			`${theme.fg("muted", ")")}`;
		for (const segment of wrapTextWithAnsi(hint, contentWidth)) {
			visibleLines.push(`${nextPrefix}${segment}`);
		}
	}

	return visibleLines;
}

/**
 * 按「宽度 + 额外缓存键」缓存渲染结果的基类。
 *
 * pi 的 ScrollView 每次 requestRender 都会整屏重渲染（不只是可视区），所以每个
 * 自绘组件都必须缓存；以前每个类各自抄一遍 cachedWidth/cachedLines/invalidate，
 * 这里收成一处。子类只实现 renderLines()，不需要自己截断——基类统一按宽度硬切，
 * 保证极窄终端下也不会向 pi 输出超宽行（pi 遇到超宽行会直接报错停掉 TUI）。
 */
export abstract class CachedView implements Component {
	private cachedWidth?: number;
	private cachedKey?: string;
	private cachedLines?: string[];

	/**
	 * 除宽度之外会影响输出的状态；默认无。
	 * 注意：每次 render 都会调用它（包括命中缓存的那次），子类要保证它便宜；
	 * 需要“算一次给 renderLines 用”的值可以在这里记到字段上。
	 */
	protected cacheKey(): string {
		return "";
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const key = this.cacheKey();
		if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedKey === key) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedKey = key;
		this.cachedLines = this.renderLines(width).map((line) =>
			truncateToWidth(line, Math.max(1, width), "…"),
		);
		return this.cachedLines;
	}

	/** 子类实现：生成宽度内的行，不用自己截断。 */
	protected abstract renderLines(width: number): string[];
}

// ---- 运行中实时尾窗（tail -f）----------------------------------------------
//
// 运行中的块只显示"最新 N 行"的尾窗：固定高度 → transcript 不抖、不跳屏，
// 每帧成本只跟窗口大小有关（不随输出总量增长）。
// 没有打字机：终端 ~20fps 下"逐字"本来就看不见，反而会让末行闪烁/窗口频繁重排。
// 只保留行渐变（顶 dim → 底正常色）与末尾静态光标（▍）。

/**
 * 尾窗内容的快照状态（跨视图实例保存）。
 *
 * pi 每帧都会重建组件，所以快照不能放在视图实例上；按固定节拍取一次文本快照，
 * 小窗口就不会每一帧都往上顶（那是最明显的"抖"）。
 */
export interface WindowSnapshot {
	/** 上次取快照的时间槽（按 refreshMs 量化）。 */
	slot?: number;
	/** 快照文本。 */
	text?: string;
}

/** 新建一个空的窗口快照。 */
export function newWindowSnapshot(): WindowSnapshot {
	return {};
}

/**
 * 取文本最后 `maxLines` 行（反向扫描，O(窗口) 而不是 O(全文)）。
 * `more` = 前面还有没显示的内容（用来放"… 上面还有内容"提示）。
 */
export function tailLines(text: string, maxLines: number): { lines: string[]; more: boolean } {
	if (maxLines <= 0) return { lines: [], more: text.length > 0 };
	// 末尾的换行不算一行
	let end = text.length;
	while (end > 0) {
		const ch = text[end - 1];
		if (ch !== "\n" && ch !== "\r") break;
		end--;
	}
	if (end === 0) return { lines: [], more: false };

	const lines: string[] = [];
	let cursor = end;
	for (let i = 0; i < maxLines; i++) {
		const newline = text.lastIndexOf("\n", cursor - 1);
		const start = newline === -1 ? 0 : newline + 1;
		let line = text.slice(start, cursor);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		lines.push(line);
		cursor = newline === -1 ? 0 : newline;
		if (newline === -1) break;
	}
	lines.reverse();
	return { lines, more: cursor > 0 };
}

/** 反向取尾窗时最多回看的源行数（防止超长文本逐行回扫）。 */
const TAIL_MAX_SOURCE_LINES = 40;

/**
 * 取文本末尾的**可视行**窗口（按 width 换行后取最后 rows 行）。
 *
 * 为什么不能只按源行数取：思考链/日志经常是"一整段没有换行"，一条源行会被
 * 折成几十行——那样窗口高度会随内容增长而不断变大，屏幕就一直抖。
 * 这里按折行后的可视行数封顶，高度恒定。
 */
export function tailVisualRows(
	text: string,
	rows: number,
	width: number,
): { rows: string[]; more: boolean } {
	if (rows <= 0) return { rows: [], more: text.length > 0 };
	const contentWidth = Math.max(1, width);
	// 只保留够填满窗口的尾巴：窗口以外的前缀直接丢掉（并标记 more）
	const limit = contentWidth * 3 * rows;
	let body = text;
	let cut = false;
	if (body.length > limit) {
		body = body.slice(body.length - limit);
		cut = true;
	}

	let end = body.length;
	while (end > 0) {
		const ch = body[end - 1];
		if (ch !== "\n" && ch !== "\r") break;
		end--;
	}
	if (end === 0) return { rows: [], more: false };

	const segments: string[] = [];
	let cursor = end;
	for (let lineCount = 0; cursor > 0 && lineCount < TAIL_MAX_SOURCE_LINES; lineCount++) {
		const newline = body.lastIndexOf("\n", cursor - 1);
		const start = newline === -1 ? 0 : newline + 1;
		let line = body.slice(start, cursor);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const wrapped = wrapTextWithAnsi(line, contentWidth);
		segments.unshift(...wrapped);
		cursor = newline === -1 ? 0 : newline;
		if (segments.length >= rows) break;
	}
	let more = cut || cursor > 0;
	if (segments.length > rows) {
		segments.splice(0, segments.length - rows);
		more = true;
	}
	return { rows: segments, more };
}

/**
 * 取尾窗 + 顶部"上面还有内容"提示。
 *
 * 提示行**占用窗口额度**：窗口上限 N 行时，有省略就是「N-1 行内容 + 1 行提示」，
 * 内容变多也不会让块突然长高一行（这是之前"跳动"的另一半原因）。
 */
export function tailWindow(
	text: string,
	maxLines: number,
	width: number,
	/** 是否会在顶部渲染提示行（true 时提示行占用一行额度）。 */
	reserveHint = true,
): { rows: string[]; more: boolean } {
	let result = tailVisualRows(text, maxLines, width);
	if (reserveHint && result.more && maxLines > 1) result = tailVisualRows(text, maxLines - 1, width);
	return result;
}

/** 实时尾窗的数据源（各块自己实现）。 */

export interface LiveTailSource {
	/** 当前完整文本（会随流式增长）。 */
	text(): string;
	/** 块是否已结束（结束时立刻全显示）。 */
	finished(): boolean;
	/** 窗口内容快照（跨帧/跨组件实例保存）。 */
	window: WindowSnapshot;
}

/** 实时尾窗的渲染选项。 */
export interface LiveTailOptions {
	/** 窗口最多显示多少行。 */
	maxLines: number;
	/** 运行中在最后一行追一个静态光标（不闪）。 */
	cursor?: boolean;
	/** 顶部"上面还有内容"提示；给 undefined 表示不显示。 */
	moreHint?: string;
	/**
	 * 窗口内容的刷新节拍（毫秒）。
	 *
	 * 不按每一帧重算：高速流式时内容每帧都在变，小窗口会被"疯狂上顶"，
	 * 看起来就是抖。按 tick 量级（见 ANIMATION_TICK_MS）取一次快照，滚动变成稳定的步进。
	 */
	refreshMs?: number;
	/** 行着色（默认按"上暗下亮"渐变）。 */
	colorize?: (line: string, index: number, total: number) => string;
}

/**
 * 运行中的实时尾窗：`⎿ 最新一行 / 续行…`，高度上限 = maxLines。
 *
 * 视觉：上一行 dim、中间 muted、最后一行正常色（终端做不了纵向渐变，按行分档
 * 就能读出"内容在往上流"）；末行追一个静态 `▍` 表示还在输出。
 * 只做行渐变 + 末行静态光标；内容按节拍取快照（见 WindowSnapshot）。
 */
export class LiveTailView extends CachedView {
	private readonly source: LiveTailSource;
	private readonly options: LiveTailOptions;
	private readonly theme: ThemeLike;

	constructor(source: LiveTailSource, theme: ThemeLike, options: LiveTailOptions) {
		super();
		this.source = source;
		this.theme = theme;
		this.options = options;
	}

	/**
	 * 取"这一拍"应该显示的文本快照。
	 *
	 * 高速流式时文本每帧都在长；如果每帧都重排尾窗，窗口会一直在往上顶。
	 * 固定节拍取快照后，滚动变成 10Hz 左右的稳定步进。
	 *
	 * 快照存在 `source.window` 上（而不是视图实例）：pi 每次 updateDisplay 都会
	 * 新建组件，实例字段活不过一帧。
	 */
	private snapshot(text: string, finished: boolean): string {
		const state = this.source.window;
		// 面板的文本本来就按 partial 结果更新（~10Hz），不需要额外快照；
		// 传了 refreshMs > 0 才启用。
		const refreshMs = this.options.refreshMs ?? 0;
		if (refreshMs <= 0) return text;
		const slot = Math.floor(Date.now() / Math.max(16, refreshMs));
		if (finished || slot !== state.slot || state.text === undefined || state.text === "") {
			state.slot = slot;
			state.text = text;
		}
		return state.text;
	}

	/**
	 * 缓存键：快照文本的**内容指纹** + 是否结束。
	 *
	 * 只看长度是不够的：尾窗源（`LIVE_TAIL_CHARS` 切片）长度恒定内容却一直在变，
	 * 那样会命中旧帧、面板冻住。这里取首/中/尾各一小段字符当指纹——
	 * 对"窗口内容整体平移"最敏感，成本 O(1)，不必整串比对。
	 */
	protected override cacheKey(): string {
		const text = this.snapshot(this.source.text(), this.source.finished());
		const mid = text.length >> 1;
		return [
			text.length,
			this.source.finished() ? 1 : 0,
			text.slice(0, 24),
			text.slice(Math.max(0, mid - 12), mid + 12),
			text.slice(-24),
		].join("\u0000");
	}

	protected renderLines(width: number): string[] {
		const text = this.snapshot(this.source.text(), this.source.finished());
		const finished = this.source.finished();
		const contentWidth = Math.max(1, width - UI_INDENT_WIDTH - PREVIEW_CONNECTOR_WIDTH);
		const { rows, more } = tailWindow(
			text,
			this.options.maxLines,
			contentWidth,
			this.options.moreHint !== undefined,
		);
		if (rows.length === 0 && !more) return [];

		const out: string[] = [];
		// 第一行用 ⎿ 连接符，其余用等宽续行前缀
		let firstLine = true;
		const emit = (segments: string[]): void => {
			if (segments.length === 0) return;
			segments.forEach((segment, index) => {
				const prefix = firstLine && index === 0 ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
				out.push(UI_INDENT + prefix + segment);
			});
			firstLine = false;
		};

		if (more && this.options.moreHint !== undefined) {
			emit(wrapTextWithAnsi(this.theme.fg("dim", this.options.moreHint), contentWidth));
		}

		const total = rows.length;
		rows.forEach((row, index) => {
			const styled = this.options.colorize
				? this.options.colorize(row, index, total)
				: this.gradient(row, index, total);
			emit([styled]);
		});

		if (!finished && this.options.cursor !== false && out.length > 0) {
			const last = out.length - 1;
			out[last] = `${out[last]}${this.theme.fg("dim", "▍")}`;
		}
		return out;
	}

	/** 默认渐变：第一行 dim、中间 muted、最后一行正常色。 */
	private gradient(line: string, index: number, total: number): string {
		if (total <= 1) return this.theme.fg("text", line);
		if (index === total - 1) return this.theme.fg("text", line);
		if (index === 0) return this.theme.fg("dim", line);
		return this.theme.fg("muted", line);
	}
}

/** 结果区视图：按宽度缓存 + 统一 3 列缩进（各工具面板共用）。 */
export class IndentedPreviewView extends CachedView {
	private readonly sourceLines: string[];
	private readonly expanded: boolean;
	private readonly isError: boolean;
	private readonly theme: ThemeLike;
	private readonly options: {
		emptyLabel?: string;
		colorize?: (line: string) => string;
		keyHint?: KeyHintFn;
	};

	constructor(
		sourceLines: string[],
		expanded: boolean,
		isError: boolean,
		theme: ThemeLike,
		options: {
			emptyLabel?: string;
			colorize?: (line: string) => string;
			keyHint?: KeyHintFn;
		} = {},
	) {
		super();
		this.sourceLines = sourceLines;
		this.expanded = expanded;
		this.isError = isError;
		this.theme = theme;
		this.options = options;
	}

	protected renderLines(width: number): string[] {
		return formatIndentedPreview(
			this.sourceLines,
			this.expanded,
			this.isError,
			this.theme,
			width - UI_INDENT_WIDTH,
			this.options,
		).map((line) => UI_INDENT + line);
	}
}

