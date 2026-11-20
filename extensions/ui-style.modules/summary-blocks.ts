/**
 * 十六、压缩摘要 / 分支摘要块（原型补丁 + 压缩中指示）
 *
 * pi 这两个块的默认样式是「整块背景色 + `[compaction]` / `[branch]` 标签 + 折叠一行」，
 * 跟本扩展的「Nerd Font 图标 + 着色标题 + ⎿ 预览」不是一套。这里收进统一视觉：
 *
 *   \uF0CFF 压缩完成 · 压缩前 12.3k tokens · ⏱ 1.8s
 *     ⎿  摘要第一行…
 *         …（固定 5 行窗口）
 *         ... 还有 N 行（Ctrl+O 展开）
 *
 *   \uF4CA 分支摘要 · from a1b2c3d4
 *     ⎿  …
 *
 * 两条限制（pi 侧决定，不是我们省事）：
 *   1. 这两个块**只在完成后**才存在（组件由会话条目回放出现），所以块内没有"压缩中"。
 *   2. 压缩**进行中** pi 只显示一个 WorkingStatusIndicator（"Compacting context..."），
 *      既不暴露组件、也不暴露流式摘要文本（内部 `streamFn(...).result()` 一次拿完）。
 *      所以"压缩中"只能做同款标题的**指示行**（扫光 + 耗时），由
 *      `setupCompactionIndicator()` 用 `session_before_compact` / `session_compact`
 *      驱动；摘要正文要等完成。
 */

import {
	MouseRegion,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	estimateTokens,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	compactionLabel,
	formatPanelDuration,
	liveTitle,
	formatTokens,
	ICON_CLOCK,
	MUTED,
	normalizeNewlines,
	patchPrototypeSlots,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	RESET_FG,
	sgr,
	UI_INDENT,
	unpatchPrototypeSlots,
	WARN_YELLOW,
} from "./core.ts";
import { setActiveCompactionReason } from "./core.ts";
import type { BlockClock, CompactionReason, Rgb, ThemeLike } from "./core.ts";
import { conclusionHead } from "./subagent-data.ts";

/** 压缩块图标（Nerd Font U+F0CFF）。 */
export const ICON_COMPACTION = "\uDB83\uDCFF";
/** 分支摘要图标（Nerd Font U+F14CA）。 */
export const ICON_BRANCH = "\uDB85\uDCCA";

/** 摘要块折叠态窗口行数（固定高度，不随摘要长度变化）。 */
export const SUMMARY_WINDOW_LINES = 5;
/**
 * 压缩中"原文窗口"的滚动节拍（毫秒/行）。
 *
 * 原文是 `session_before_compact` 一次性给的，没有真流式；这里让窗口按时间
 * 自动下滚，形成"内容在往下流"的观感（与 `!` 命令框/tail 窗口同一套做法：
 * 纯函数算位置，帧由 pi 的 spinner 提供）。滚到底就停在尾部。
 */
export const SUMMARY_SCROLL_MS = 350;

/**
 * 标题色：压缩与分支统一用紫（`ACCENT_VIOLET` 同族），与工具面板/子代理的蓝色区分开
 * ——这两个块都是"上下文被改写"的元事件，用同一色相更能表达"同类"。
 */
const SUMMARY_ACCENT: Rgb = [177, 142, 250];
const COMPACTION_ACCENT = SUMMARY_ACCENT;
const BRANCH_ACCENT = SUMMARY_ACCENT;

/**
 * 摘要块的着色：只有"暗一档"的标记需要真颜色，正文用终端默认色。
 *
 * 原型补丁里拿不到当前 Theme 实例（pi 不导出模块级 theme），所以不装作有主题：
 * `text` 原样返回、`muted`/`dim` 用 core 里同一份 MUTED。
 */
const PLAIN_THEME: ThemeLike = {
	fg: (token: string, text: string): string =>
		token === "muted" || token === "dim" ? `${MUTED}${text}${RESET_FG}` : text,
};

interface SummaryMessageLike {
	summary?: string;
	tokensBefore?: number;
	fromId?: string | null;
	timestamp?: number;
}

/**
 * 一次压缩在本进程内测到的结果。
 *
 * pi 的 CompactionEntry 只存 `tokensBefore`，既没有耗时也没有压缩后大小
 * （`estimatedTokensAfter` 只在内部结果里，不落盘）。所以：
 *   - 新压缩：用 `session_before_compact` / `session_compact` 现场测，按 entry id 存；
 *   - 历史回放：没有可信数据，显示 `--`，绝不编造。
 */
interface CompactionRecord {
	elapsedMs: number;
	/** 触发原因：手动 / 阈值自动 / 溢出恢复。 */
	reason?: CompactionReason;
	/** 压缩后的上下文估算（pi 同一套 estimateTokens）。 */
	tokensAfter?: number;
}

/** entry id → 本地测到的压缩结果。 */
const compactionByEntryId = new Map<string, CompactionRecord>();
/** 没有 id 可用时的兜底（紧随其后的那个块）。 */
let lastCompaction: CompactionRecord | undefined;

/** 记一次压缩结果（供摘要块显示）。 */
export function recordCompactionResult(
	record: CompactionRecord,
	entryId?: string,
): void {
	lastCompaction = record;
	if (entryId !== undefined) compactionByEntryId.set(entryId, record);
}

/** 清掉（切换会话时）。 */
export function resetCompactionTiming(): void {
	lastCompaction = undefined;
	compactionByEntryId.clear();
}

/** 取这个块对应的本地记录（优先按 entry id，其次用最近一次）。 */
export function compactionRecord(entryId?: string): CompactionRecord | undefined {
	// 有 id 就必须按 id 命中：**不能**回退到"最近一次压缩"——否则重放历史会话时，
	// 老的 compaction 块会显示新一次压缩的耗时（与"历史回放显示 --，绝不编造"矛盾）。
	if (entryId !== undefined) return compactionByEntryId.get(entryId);
	return lastCompaction;
}

/**
 * 标题行文案（不含块缩进）。
 *
 * 时钟**始终显示**：测到了就显示真实耗时，没有（历史回放）就显示 `--`
 * ——宁可能看出"没有数据"，也不要让这一行的结构随数据变来变去。
 */
export function summaryTitle(options: {
	icon: string;
	label: string;
	accent: Rgb;
	meta?: string;
	elapsedMs?: number;
	/** 是否显示时钟耗时（分支摘要没有可信计时，改成显示摘要大小）。 */
	withTimer?: boolean;
}): string {
	const meta = options.meta === undefined ? "" : ` · ${options.meta}`;
	const timer =
		options.withTimer === false
			? ""
			: ` · ${ICON_CLOCK} ${options.elapsedMs === undefined ? "--" : formatPanelDuration(options.elapsedMs)}`;
	return (
		`${sgr(options.accent)}${BOLD_ON}${options.icon} ${options.label}${meta}${timer}` +
		`${BOLD_OFF}${RESET_FG}`
	);
}

/**
 * 摘要块视图：标题 + 固定 5 行窗口（折叠）/ 全文（展开）。
 *
 * 与其它块同一套纪律：本视图只管折行与缩进，超宽由 `CachedView` 统一硬切。
 */
export class SummaryBlockView extends CachedView {
	private readonly title: string;
	private readonly summary: string;
	private readonly expanded: boolean;
	private readonly theme: ThemeLike;

	constructor(title: string, summary: string, expanded: boolean, theme: ThemeLike = PLAIN_THEME) {
		super();
		this.title = title;
		this.summary = summary;
		this.expanded = expanded;
		this.theme = theme;
	}

	protected override cacheKey(): string {
		return `${this.expanded ? 1 : 0}\u0000${this.title}\u0000${this.summary.length}`;
	}

	protected renderLines(width: number): string[] {
		const theme = this.theme;
		const lines = [`${UI_INDENT}${this.title}`];
		const contentWidth = Math.max(1, width - UI_INDENT.length - PREVIEW_CONNECTOR_REST.length);
		const text = normalizeNewlines(this.summary).trim();
		if (!text) {
			lines.push(`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${theme.fg("muted", "(空摘要)")}`);
			return lines;
		}

		if (this.expanded) {
			let first = true;
			for (const line of text.split("\n")) {
				for (const segment of wrapTextWithAnsi(theme.fg("text", line), contentWidth)) {
					const prefix = first ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
					lines.push(`${UI_INDENT}${prefix}${segment}`);
					first = false;
				}
			}
			return lines;
		}

		// 折叠态：固定 5 行窗口（看头部）+ 「还有 N 行」提示。
		const head = conclusionHead(text, SUMMARY_WINDOW_LINES);
		let first = true;
		for (const line of head.lines) {
			for (const segment of wrapTextWithAnsi(theme.fg("text", line), contentWidth)) {
				const prefix = first ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
				lines.push(`${UI_INDENT}${prefix}${segment}`);
				first = false;
			}
		}
		if (head.remaining > 0) {
			lines.push(
				`${UI_INDENT}${PREVIEW_CONNECTOR_REST}${theme.fg("muted", `... 还有 ${head.remaining} 行（Ctrl+O 展开）`)}`,
			);
		}
		return lines;
	}
}

/** 打补丁所需的组件运行时形状（pi 里是 private 字段）。 */
interface SummaryPrototype {
	expanded: boolean;
	message?: unknown;
	/** pi 给每条会话条目分配的 id（用来对上本地测到的压缩结果）。 */
	messageId?: string;
	clear(): void;
	addChild(component: Component): void;
	setBgFn(bgFn?: (text: string) => string): void;
	setPaddingX(padding: number): void;
	setExpanded(expanded: boolean): void;
	updateDisplay(): void;
	[key: `ui-style:${string}`]: unknown;
}

/** 给「标题 + 5 行窗口」的组件打补丁（两个块共用）。 */
function patchSummaryComponent(
	proto: SummaryPrototype,
	prefix: string,
	buildTitle: (message: SummaryMessageLike, messageId: string | undefined) => string,
): void {
	const originalUpdateDisplay = proto.updateDisplay;
	const patched = function (this: SummaryPrototype): void {
		try {
			// 去掉 pi 的背景色与内边距：缩进由我们自己的 UI_INDENT 统一给。
			this.setPaddingX(0);
			this.setBgFn(undefined);
			const message = (this.message ?? {}) as SummaryMessageLike;
			const summary = typeof message.summary === "string" ? message.summary : "";
			this.clear();
			this.addChild(
				new MouseRegion(
					new SummaryBlockView(
						buildTitle(message, this.messageId),
						summary,
						this.expanded === true,
					) as unknown as Component,
					(event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.setExpanded(!this.expanded);
						return { handled: true };
					},
				),
			);
		} catch {
			// pi 内部结构变了：退回它自己的渲染，至少不会空白。
			originalUpdateDisplay.call(this);
		}
	};
	patchPrototypeSlots(proto, prefix, { updateDisplay: patched as unknown as () => void });
}

/**
 * 压缩块的标题。
 *
 * 有本地记录时显示「压缩前 → 压缩后（降幅）」，没有就只写压缩前大小
 * （`tokensBefore` 是 pi 落盘的，历史回放也有）。
 */
export function compactionTitle(
	message: SummaryMessageLike,
	record: CompactionRecord | undefined = lastCompaction,
): string {
	const before = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
	const after = record?.tokensAfter;
	let meta: string | undefined;
	if (before === undefined) {
		meta = undefined;
	} else if (after === undefined) {
		meta = `压缩前 ${formatTokens(before)} tokens`;
	} else {
		const saved = before - after;
		const percent = before > 0 ? Math.round((saved / before) * 100) : 0;
		meta = `${formatTokens(before)} → ${formatTokens(after)} tokens（-${percent}%）`;
	}
	return summaryTitle({
		icon: ICON_COMPACTION,
		label: compactionLabel(record?.reason, "done"),
		accent: COMPACTION_ACCENT,
		meta,
		elapsedMs: record?.elapsedMs,
	});
}

/**
 * 摘要的 token 数（带缓存）。
 *
 * 长摘要的 `estimateTokens` 是 O(文本长度)，而标题每次 "重建组件"都会算一遍；
 * 用「长度 + 首尾各 32 字」当指纹缓存，内容变了自然失效。
 * 注意：pi-ai 的 `estimateTokens` 对 assistant **只认 block 数组**的 content
 * （传字符串会得到 0），这里显式包成 text 块。
 */
const summaryTokensCache = new Map<string, number>();

export function summaryTokens(summary: string): number | undefined {
	const text = summary.trim();
	if (!text) return undefined;
	const key = `${text.length}:${text.slice(0, 32)}:${text.slice(-32)}`;
	const cached = summaryTokensCache.get(key);
	if (cached !== undefined) return cached;
	const value = estimateTokens({
		role: "assistant",
		content: [{ type: "text", text }],
	} as never);
	if (summaryTokensCache.size < 64) summaryTokensCache.set(key, value);
	return value;
}

/**
 * 分支摘要块的标题：`\uF4CA 分支摘要 · from 3c9c3f06 · 摘要 1.2k tokens`。
 *
 * 分支摘要**不显示时钟**：它没有可信计时（既没有本地事件可测，条目里也没有耗时），
 * 与其显示一个 `--`，不如显示更有用的信息——摘要本身多大。
 */
export function branchTitle(message: SummaryMessageLike): string {
	const from =
		typeof message.fromId === "string" && message.fromId.length > 0
			? message.fromId.slice(0, 8)
			: undefined;
	const summary = typeof message.summary === "string" ? message.summary : "";
	const tokens = summaryTokens(summary);
	const parts: string[] = [];
	if (from !== undefined) parts.push(`from ${from}`);
	if (tokens !== undefined) parts.push(`摘要 ${formatTokens(tokens)} tokens`);
	return summaryTitle({
		icon: ICON_BRANCH,
		label: "分支摘要",
		accent: BRANCH_ACCENT,
		meta: parts.length > 0 ? parts.join(" · ") : undefined,
		withTimer: false,
	});
}

/** 给两个摘要块打补丁（幂等；/reload 会先恢复再重打）。 */
export function patchSummaryBlocks(): void {
	patchSummaryComponent(
		CompactionSummaryMessageComponent.prototype as unknown as SummaryPrototype,
		"ui-style:compaction-summary",
		(message, messageId) => compactionTitle(message, compactionRecord(messageId)),
	);
	patchSummaryComponent(
		BranchSummaryMessageComponent.prototype as unknown as SummaryPrototype,
		"ui-style:branch-summary",
		(message) => branchTitle(message),
	);
}

/** 恢复 pi 原来的两个摘要块。 */
export function unpatchSummaryBlocks(): void {
	unpatchPrototypeSlots(
		CompactionSummaryMessageComponent.prototype as unknown as SummaryPrototype,
		"ui-style:compaction-summary",
		["updateDisplay"],
	);
	unpatchPrototypeSlots(
		BranchSummaryMessageComponent.prototype as unknown as SummaryPrototype,
		"ui-style:branch-summary",
		["updateDisplay"],
	);
}

// ---- 压缩中：同款标题 + 5 行窗口（显示"正在被压缩的原文"） ------------------

const INDICATOR_WIDGET_KEY = "ui-style-compaction-indicator";

/** 从待压缩消息里抽纯文本（给"原文窗口"用）。 */
export function textsFromPreparation(preparation: unknown): string {
	const prep = preparation as
		| { messagesToSummarize?: unknown[]; turnPrefixMessages?: unknown[] }
		| undefined;
	const messages = [
		...(Array.isArray(prep?.messagesToSummarize) ? prep.messagesToSummarize : []),
		...(Array.isArray(prep?.turnPrefixMessages) ? prep.turnPrefixMessages : []),
	];
	const parts: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const part = block as { type?: string; text?: string };
			if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

/**
 * 压缩中指示视图：标题（扫光 + 耗时）+ **固定 5 行窗口**显示被压缩的原文尾部。
 *
 * pi 不暴露压缩过程生成的摘要流，但 `session_before_compact` 会给出
 * `preparation.messagesToSummarize`——那正是"正在被压缩的原文"，用它填窗口，
 * 用户至少能看见"哪些内容正在被压缩"。
 */
export class CompactionIndicatorView extends CachedView {
	private readonly clock: BlockClock;
	private readonly source: string;
	private readonly reason: CompactionReason | undefined;

	constructor(clock: BlockClock, source = "", reason: CompactionReason | undefined = undefined) {
		super();
		this.clock = clock;
		this.source = source;
		this.reason = reason;
	}

	protected override cacheKey(): string {
		// 扫光与耗时按 100ms 粒度变化；压缩期间 pi 的 spinner 会持续给帧。
		return `${this.clock.startedAt ?? 0}:${Math.floor(Date.now() / 100)}:${this.source.length}:${this.reason ?? ""}`;
	}

	protected renderLines(width: number): string[] {
		const elapsedMs = this.clock.startedAt === undefined ? 0 : Date.now() - this.clock.startedAt;
		// 标题（含行尾时钟与耗时）整行走同一个构建器：与输入框指示完全同色同动画。
		const title = liveTitle(
			ICON_COMPACTION,
			compactionLabel(this.reason, "running"),
			COMPACTION_ACCENT,
			this.clock.startedAt,
			elapsedMs,
		);
		const lines = [`${UI_INDENT}${title}`];

		const contentWidth = Math.max(1, width - UI_INDENT.length - PREVIEW_CONNECTOR_REST.length);
		const text = normalizeNewlines(this.source).trim();
		if (!text) {
			lines.push(`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${WARN_YELLOW}正在生成摘要…${RESET_FG}`);
			return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
		}

		// 原文是静态的（一次给全），但窗口按时间**自动下滚**：观感上像流式输出。
		const sourceLines = text.split("\n");
		const maxOffset = Math.max(0, sourceLines.length - SUMMARY_WINDOW_LINES);
		const elapsed = this.clock.startedAt === undefined ? 0 : Date.now() - this.clock.startedAt;
		const offset = Math.min(maxOffset, Math.floor(Math.max(0, elapsed) / SUMMARY_SCROLL_MS));
		const windowLines = sourceLines.slice(offset, offset + SUMMARY_WINDOW_LINES);

		let first = true;
		const above = offset;
		if (above > 0) {
			lines.push(`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${MUTED}… 上面还有 ${above} 行${RESET_FG}`);
			first = false;
		}
		for (const row of windowLines) {
			const prefix = first ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
			lines.push(`${UI_INDENT}${prefix}${row}`);
			first = false;
		}
		const below = maxOffset - offset;
		if (below > 0) {
			lines.push(`${UI_INDENT}${PREVIEW_CONNECTOR_REST}${MUTED}… 下面还有 ${below} 行${RESET_FG}`);
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}
}

/**
 * 压缩中指示：`session_before_compact` 起表（并记下待压缩原文），
 * `session_compact` / `session_compact_failed` 收表。
 *
 * 收表时顺带记下**耗时**与**压缩后大小**（用 pi 的 `estimateTokens` 对压缩后的
 * 会话投影求和，口径与 pi 内部一致），供紧随其后的摘要块显示。
 */
export function setupCompactionIndicator(pi: ExtensionAPI): void {
	const clock: BlockClock = {};
	let source = "";
	let reason: CompactionReason | undefined;

	pi.on("session_before_compact", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		clock.startedAt = Date.now();
		clock.endedAt = undefined;
		reason = (event as { reason?: CompactionReason }).reason;
		// 共享给 editor.ts 的 Loader 补丁（它拿不到结构化 reason）。
		setActiveCompactionReason(reason);
		source = textsFromPreparation((event as { preparation?: unknown }).preparation);
		ctx.ui.setWidget(
			INDICATOR_WIDGET_KEY,
			() => new CompactionIndicatorView(clock, source, reason),
			{ placement: "aboveEditor" },
		);
	});

	const finish = (
		event: { compactionEntry?: { id?: string } },
		ctx: {
			ui: { setWidget(key: string, view: undefined): void };
			sessionManager?: { buildSessionProjection(): { messages: unknown[] } };
		},
		failed: boolean,
	): void => {
		const startedAt = clock.startedAt;
		if (startedAt !== undefined && clock.endedAt === undefined) {
			clock.endedAt = Date.now();
			if (!failed) {
				// 压缩后的上下文大小：与 pi 内部同一套估算（estimateTokens 逐条求和）。
				let tokensAfter: number | undefined;
				try {
					const projection = ctx.sessionManager?.buildSessionProjection();
					if (projection !== undefined) {
						tokensAfter = projection.messages.reduce(
							(sum, message) => sum + estimateTokens(message as never),
							0,
						);
					}
				} catch {
					// 拿不到就不显示"压缩后"，只显示压缩前。
				}
				recordCompactionResult(
					{ elapsedMs: clock.endedAt - startedAt, tokensAfter, reason },
					event.compactionEntry?.id,
				);
			}
		}
		setActiveCompactionReason(undefined);
		// 整段待压缩原文可能有几百 KB，压缩结束就释放，别常驻到下一次压缩。
		source = "";
		ctx.ui.setWidget(INDICATOR_WIDGET_KEY, undefined);
	};

	pi.on("session_compact", (event, ctx) => finish(event as never, ctx as never, false));
	pi.on("session_compact_failed", (event, ctx) => finish(event as never, ctx as never, true));
	pi.on("session_shutdown", (_event, ctx) => {
		finish({}, ctx as never, true);
		resetCompactionTiming();
	});
}
