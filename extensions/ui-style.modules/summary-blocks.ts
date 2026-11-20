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
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	formatTokens,
	ICON_CLOCK,
	MUTED,
	normalizeNewlines,
	patchPrototypeSlots,
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	RESET_FG,
	shimmerText,
	sgr,
	UI_INDENT,
	unpatchPrototypeSlots,
	WARN_YELLOW,
} from "./core.ts";
import type { BlockClock, Rgb, ThemeLike } from "./core.ts";
import { conclusionHead } from "./subagent-data.ts";

/** 压缩块图标（Nerd Font U+F0CFF）。 */
export const ICON_COMPACTION = "\uDB83\uDCFF";
/** 分支摘要图标（Nerd Font U+F14CA）。 */
export const ICON_BRANCH = "\uDB85\uDCCA";

/** 摘要块折叠态窗口行数（固定高度，不随摘要长度变化）。 */
export const SUMMARY_WINDOW_LINES = 5;

/** 标题色：压缩用蓝、分支用紫（与其它块同族，又能区分）。 */
const COMPACTION_ACCENT: Rgb = [95, 135, 215];
const BRANCH_ACCENT: Rgb = [177, 142, 250];

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

/** 最近一次压缩的本地耗时（事件里测，紧随其后的块里显示）。 */
let lastCompaction: { endedAt: number; elapsedMs: number } | undefined;

/** 记一次压缩耗时（供紧随其后的摘要块显示）。 */
export function recordCompactionTiming(elapsedMs: number, now = Date.now()): void {
	lastCompaction = { endedAt: now, elapsedMs };
}

/** 清掉（切换会话时）。 */
export function resetCompactionTiming(): void {
	lastCompaction = undefined;
}

/** 标题行文案（不含块缩进）。 */
export function summaryTitle(options: {
	icon: string;
	label: string;
	accent: Rgb;
	meta?: string;
	elapsedMs?: number;
}): string {
	const meta = options.meta === undefined ? "" : ` · ${options.meta}`;
	const timer =
		options.elapsedMs === undefined
			? ""
			: ` · ${ICON_CLOCK} ${(options.elapsedMs / 1000).toFixed(1)}s`;
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
	buildTitle: (message: SummaryMessageLike) => string,
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
						buildTitle(message),
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

/** 压缩块的标题（含"压缩前 N tokens"与本机测到的耗时）。 */
export function compactionTitle(message: SummaryMessageLike, now = Date.now()): string {
	const tokens = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
	// 只有"刚刚压缩完"才显示本地耗时；历史回放没有可信计时，不伪造。
	const elapsedMs =
		lastCompaction !== undefined && now - lastCompaction.endedAt < 5_000
			? lastCompaction.elapsedMs
			: undefined;
	return summaryTitle({
		icon: ICON_COMPACTION,
		label: "压缩完成",
		accent: COMPACTION_ACCENT,
		meta: tokens === undefined ? undefined : `压缩前 ${formatTokens(tokens)} tokens`,
		elapsedMs,
	});
}

/** 分支摘要块的标题（带来源条目的短 id）。 */
export function branchTitle(message: SummaryMessageLike): string {
	const from =
		typeof message.fromId === "string" && message.fromId.length > 0
			? message.fromId.slice(0, 8)
			: undefined;
	return summaryTitle({
		icon: ICON_BRANCH,
		label: "分支摘要",
		accent: BRANCH_ACCENT,
		meta: from === undefined ? undefined : `from ${from}`,
	});
}

/** 给两个摘要块打补丁（幂等；/reload 会先恢复再重打）。 */
export function patchSummaryBlocks(): void {
	patchSummaryComponent(
		CompactionSummaryMessageComponent.prototype as unknown as SummaryPrototype,
		"ui-style:compaction-summary",
		(message) => compactionTitle(message),
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

// ---- 压缩中：同款标题的指示（widget，不占 transcript） ----------------------

const INDICATOR_WIDGET_KEY = "ui-style-compaction-indicator";

/** 压缩中指示视图：标题（扫光 + 耗时）+ 一行提示。 */
export class CompactionIndicatorView extends CachedView {
	private readonly clock: BlockClock;

	constructor(clock: BlockClock) {
		super();
		this.clock = clock;
	}

	protected override cacheKey(): string {
		// 扫光与耗时按 100ms 粒度变化；压缩期间 pi 的 spinner 会持续给帧。
		return `${this.clock.startedAt ?? 0}:${Math.floor(Date.now() / 100)}`;
	}

	protected renderLines(width: number): string[] {
		const plain = `${ICON_COMPACTION} 压缩中`;
		const title = `${BOLD_ON}${shimmerText(plain, COMPACTION_ACCENT, this.clock.startedAt)}${BOLD_OFF}${RESET_FG}`;
		const lines = [
			`${UI_INDENT}${title}`,
			`${UI_INDENT}${PREVIEW_CONNECTOR_FIRST}${WARN_YELLOW}正在生成摘要…${RESET_FG}`,
		];
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}
}

/**
 * 压缩中指示：`session_before_compact` 起表、`session_compact` /
 * `session_compact_failed` 收表；指示挂在输入框上方（widget，不进 transcript）。
 */
export function setupCompactionIndicator(pi: ExtensionAPI): void {
	const clock: BlockClock = {};

	pi.on("session_before_compact", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		clock.startedAt = Date.now();
		clock.endedAt = undefined;
		const view = new CompactionIndicatorView(clock);
		ctx.ui.setWidget(INDICATOR_WIDGET_KEY, () => view, { placement: "aboveEditor" });
	});

	const finish = (ctx: { ui: { setWidget(key: string, view: undefined): void } }, failed: boolean): void => {
		if (clock.startedAt !== undefined && clock.endedAt === undefined) {
			clock.endedAt = Date.now();
			if (!failed) recordCompactionTiming(clock.endedAt - clock.startedAt);
		}
		ctx.ui.setWidget(INDICATOR_WIDGET_KEY, undefined);
	};

	pi.on("session_compact", (_event, ctx) => finish(ctx, false));
	pi.on("session_compact_failed", (_event, ctx) => finish(ctx, true));
	pi.on("session_shutdown", (_event, ctx) => {
		finish(ctx, true);
		resetCompactionTiming();
	});
}
