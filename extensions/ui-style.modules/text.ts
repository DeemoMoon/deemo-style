/**
 * 文本层：耗时/用量格式化、ANSI 清洗、折叠预览算法、上下文占用缓存、动画节拍。
 *
 * 依赖 `theme.ts`（连接符、颜色）与 pi-tui 的宽度/换行工具。
 */

import {
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BOLD_OFF,
	BOLD_ON,
	ICON_CLOCK,
	PANEL_PREVIEW_LINES,
	RESET_FG,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	PREVIEW_CONNECTOR_WIDTH,
} from "./theme.ts";
import { shimmerText } from "./theme.ts";
import type { Rgb, ThemeLike } from "./theme.ts";


// ---- 三、共享工具（计时 / 上下文 / 文本 / 预览格式化 / 缓存基类） ------


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
	const key = `${manager.getSessionId()}\u0000${manager.getLeafId() ?? ""}\u0000${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
	if (contextUsageCache?.key === key) return contextUsageCache.value;
	const value = ctx.getContextUsage();
	contextUsageCache = { key, value };
	return value;
}

/**
 * 扩展状态文本缓存（`ctx.ui.setStatus()` 的内容）。
 *
 * 基线存的是**插入序**（每次 update 都拿新的一批和上一批逐项比），排序只作用于
 * 输出用的副本。早期实现把同一个数组存进基线再就地 `sort()`，于是下一帧拿
 * "插入序"跟"字母序"比永远不相等 → 每帧都重排序 + 跑两遍正则（20fps 空转）。
 */
export class ExtensionStatusText {
	private entries: Array<[string, string]> = [];
	private text = "";
	/** 真正重算的次数（测试用来确认缓存命中）。 */
	updates = 0;

	update(statuses: ReadonlyMap<string, string>): string {
		const previous = this.entries;
		let changed = previous.length !== statuses.size;
		let index = 0;
		for (const [key, value] of statuses) {
			const old = previous[index++];
			if (!changed && (old === undefined || old[0] !== key || old[1] !== value)) changed = true;
		}
		if (!changed) return this.text;

		// 确认变化后才建新数组/元组：没变时每帧零分配。
		const entries: Array<[string, string]> = [];
		for (const [key, value] of statuses) entries.push([key, value]);

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
/**
 * 压缩的触发原因（pi 的 `session_before_compact` / `session_compact` 都带 `reason`）。
 *
 * 三条路径共用同一套渲染，但文案要区分：手动 / 阈值自动 / 溢出恢复。
 * 这个状态由 `summary-blocks.ts` 在事件里写、`editor.ts` 的指示器补丁读
 * （Loader 补丁拿不到结构化 reason，只能读共享状态）。
 */
export type CompactionReason = "manual" | "threshold" | "overflow";

let activeCompactionReason: CompactionReason | undefined;

export function setActiveCompactionReason(reason: CompactionReason | undefined): void {
	activeCompactionReason = reason;
}

export function getActiveCompactionReason(): CompactionReason | undefined {
	return activeCompactionReason;
}

/** 压缩文案（进行中 / 完成）按原因区分；未提供原因按手动处理。 */
export function compactionLabel(reason: CompactionReason | undefined, phase: "running" | "done"): string {
	if (reason === "overflow") return phase === "running" ? "溢出恢复中" : "溢出恢复完成";
	if (reason === "threshold") return phase === "running" ? "自动压缩中" : "自动压缩完成";
	return phase === "running" ? "压缩上下文中" : "压缩完成";
}

export const ANIMATION_TICK_MS = 100;

type TickListener = (now: number) => void;

const tickListeners = new Map<string, TickListener>();
let tickTimer: ReturnType<typeof setInterval> | undefined;

function startTicker(): void {
	if (tickTimer) return;
	tickTimer = setInterval(() => {
		const now = Date.now();
		for (const listener of [...tickListeners.values()]) {
			try {
				listener(now);
			} catch {
				// 动画只是装饰：一个 listener 失败不能拖垮整个 tick，更不能变成
				// uncaught exception 把 pi 进程带走。
			}
		}
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
	// 先按一位小数舍入再判断 60s：59.96s 不能显示成 "60.0s"。
	const rounded = Math.round(seconds * 10) / 10;
	if (rounded < 60) return `${rounded.toFixed(1)}s`;

	const totalSeconds = Math.round(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes} m ${remainder} s`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} m ${remainder} s`;
}

/**
 * 绝对时间：`2026年11月19日 10时00分00秒`（本地时区）。
 *
 * 用于"会话创建时间"这类需要看**具体哪一刻**的场景（相对时长会用
 * `formatDuration`）。时间无效时返回 `--`，不显示 `Invalid Date`。
 */
export function formatDateTime(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "--";
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return "--";
	const pad = (value: number): string => String(value).padStart(2, "0");
	return (
		`${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ` +
		`${pad(date.getHours())}时${pad(date.getMinutes())}分${pad(date.getSeconds())}秒`
	);
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

/**
 * 「运行中的标题」：图标 + 文案 + 行尾 `⏱ 耗时`，**整行一起扫光**。
 *
 * 压缩块与它的输入框指示共用这一份，保证两处的配色与动画完全一致
 * （耗时也在扫光带里，不再是"贴在旁边的一截灰字"）。
 * 首帧（<16ms）先不拼耗时，避免闪一下 "0ms"。
 */
export function liveTitle(
	icon: string,
	label: string,
	accent: Rgb,
	startedAt: number | undefined,
	elapsedMs: number,
): string {
	// 首帧（<MIN_EXEC_CLOCK_MS）不拼耗时，与 liveClockText 同一阈值。
	const timer =
		elapsedMs < MIN_EXEC_CLOCK_MS ? "" : ` · ${ICON_CLOCK} ${formatPanelDuration(elapsedMs)}`;
	const prefix = icon === "" ? "" : `${icon} `;
	const plain = `${prefix}${label}${timer}`;
	return `${BOLD_ON}${shimmerText(plain, accent, startedAt)}${BOLD_OFF}${RESET_FG}`;
}

/**
 * 首帧阈值：块刚出现时（0~几 ms）不显示耗时，避免闪一下 "0ms"。
 *
 * 三个地方共用：`liveClockText`（子代理/面板）、`execClockText`（`!` 命令）、
 * `liveTitle`（压缩/摘要指示）。**只对"还没结束"的块生效**——结束后的 3ms 是真实
 * 耗时，应该显示。
 */
export function shouldHideEarlyMs(clock: BlockClock, ms: number): boolean {
	return clock.endedAt === undefined && ms < MIN_EXEC_CLOCK_MS;
}

/**
 * 「活着的块」的耗时文案：运行中首帧（0~几 ms）不显示。
 *
 * 计时口径是"块一出现就开始"，所以首帧 elapsed 必然是 0ms；直接显示会闪一下
 * "0ms" 再跳到真实值。子代理块与 `!` 命令框都走这一份，别各写一套。
 * 结束后照常显示（3ms 这种本机工具的真实耗时有意义）。
 */
export function liveClockText(clock: BlockClock, now = Date.now()): string | undefined {
	const ms = clockElapsedMs(clock, now);
	if (ms === undefined) return undefined;
	if (shouldHideEarlyMs(clock, ms)) return undefined;
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
	if (count < 1_000_000) {
		const k = Math.round(count / 1000);
		// 999,999 不能显示成 "1000k"。
		return k >= 1000 ? "1M" : `${k}k`;
	}
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
	let head = isArray ? (source as readonly string[]) : (source as PreviewSource).head;
	let total = isArray ? head.length : (source as PreviewSource).total;

	// 尾部空行不参与计数（也不进预览）。
	// 数组入参可以直接砍 total；PreviewSource 的 head 之外的行数本来就没记，
	// 所以只能边砍 total 边砍 head 里能看见的那部分——够用了（差值是尾部空行）。
	if (isArray) {
		while (total > 0 && !(head[total - 1] ?? "").trim()) total--;
	} else if (head.length >= total) {
		// 同上：head 没覆盖全文时，末尾空行属于文本中间，不能当"文末空行"裁掉
		({ head, total } = trimTrailingBlanks({ head: [...head], total }));
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
	// **但 head 被 maxLines 截断时不能裁**：那时 head 末尾的空行是"文本中间的空行"，
	// 裁掉会把 total 一起减少，导致「还有 N 行」少算甚至变成 0（实测 8 行文本
	// 第 5 行是空行时，remaining 会从 4 变成 0）。
	if (head.length < total) return { head, total };
	return trimTrailingBlanks({ head, total });
}

/**
 * 裁尾部空行：head 之外的行数不可见，只能扣 head 覆盖到的那部分
 * （collapsePreviewLines 与 headLinesOfTexts 共用这一段，别各写一遍）。
 */
function trimTrailingBlanks(source: PreviewSource): PreviewSource {
	const covered = Math.min(source.total, source.head.length);
	let visible = covered;
	while (visible > 0 && !(source.head[visible - 1] ?? "").trim()) visible--;
	const trimmed = covered - visible;
	if (trimmed === 0) return source;
	return { head: source.head.slice(0, visible), total: source.total - trimmed };
}

/** 换行归一（`\r\n` / `\r` → `\n`）。面板、diff 预览、子代理结论都走这一份。 */
export function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
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

/** resultOutput 的按对象缓存：key 用 content 数组（pi 每次 render 都会包一个
 * 新对象，但 content 数组引用在多次渲染间稳定），同一结果不重复清洗。 */
export const outputCache = new WeakMap<object, string>();

/** 工具结果的文本输出（合并 text 部分 + 清洗）。 */
export function resultOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	const cacheKey = result.content;
	const cached = outputCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const text = cleanText(
		result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	).trim();
	outputCache.set(cacheKey, text);
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

/**
 * 把一行精确对齐到 width：超宽截断（不带省略号）、不足补空格。
 *
 * 状态栏（`fitLine`）与信息面板（`padTo`）原本各有一份等价实现，合并到这里。
 */
export function fitToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	if (current === width) return line;
	const fitted = current > width ? truncateToWidth(line, width, "") : line;
	const fittedWidth = visibleWidth(fitted);
	return fittedWidth < width ? fitted + " ".repeat(width - fittedWidth) : fitted;
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
			`${resolveKeyHint(options.keyHint)("app.tools.expand", "to expand")}` +
			`${theme.fg("muted", ")")}`;
		for (const segment of wrapTextWithAnsi(hint, contentWidth)) {
			visibleLines.push(`${nextPrefix}${segment}`);
		}
	}

	return visibleLines;
}
