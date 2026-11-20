/**
 * 视图缓存与实时尾窗：`CachedView`（按宽度缓存 + 统一截宽）、`LiveTailView`
 *（运行中的 tail -f 窗口）、`IndentedPreviewView`（⎿ 缩进结果区）。
 *
 * 依赖 `theme.ts`（缩进/连接符/颜色）与 `text.ts`（折叠预览格式化）。
 */

import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
	PREVIEW_CONNECTOR_FIRST,
	PREVIEW_CONNECTOR_REST,
	PREVIEW_CONNECTOR_WIDTH,
	UI_INDENT,
	UI_INDENT_WIDTH,
} from "./theme.ts";
import type { ThemeLike } from "./theme.ts";
import { formatIndentedPreview } from "./text.ts";
import type { KeyHintFn } from "./text.ts";


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
		let start = body.length - limit;
		// 不要从代理对的低位开始切，否则会留下孤立 surrogate。
		const code = body.charCodeAt(start);
		if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
		body = body.slice(start);
		cut = true;
	}

	let end = body.length;
	while (end > 0) {
		const ch = body[end - 1];
		if (ch !== "\n" && ch !== "\r") break;
		end--;
	}
	if (end === 0) return { rows: [], more: false };

	// 反向收集可视行，最后一次 reverse 归位（比每行 unshift 少搬数据）。
	const segments: string[] = [];
	let cursor = end;
	for (let lineCount = 0; cursor > 0 && lineCount < TAIL_MAX_SOURCE_LINES; lineCount++) {
		const newline = body.lastIndexOf("\n", cursor - 1);
		const start = newline === -1 ? 0 : newline + 1;
		let line = body.slice(start, cursor);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const wrapped = wrapTextWithAnsi(line, contentWidth);
		for (let i = wrapped.length - 1; i >= 0; i--) segments.push(wrapped[i]!);
		cursor = newline === -1 ? 0 : newline;
		if (segments.length >= rows) break;
	}
	let more = cut || cursor > 0;
	if (segments.length > rows) {
		segments.splice(0, segments.length - rows);
		more = true;
	}
	segments.reverse();
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
	/**
	 * 额外的左缩进（默认空串）。嵌在别的块里时用它整体再缩进一级，
	 * 与调用方自己画的行保持同一列。
	 */
	indent?: string;
	/**
	 * 第一行是否用 `⎿` 连接符（默认 true）。
	 *
	 * 外面已经用 `⎿` 挂了别的东西（例如子代理块的任务行）时传 false，
	 * 窗口内容全部走等宽续行前缀，避免一层里出现两个 `⎿`。
	 */
	firstConnector?: boolean;
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
		if (finished || slot !== state.slot || !state.text) {
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
		const indent = this.options.indent ?? "";
		// 光标要占 1 列：不预留的话，满宽的最后一行会被 CachedView 截成 "…"，
		// 正好把最新的一个字和光标一起吃掉。
		const reserveCursor = !finished && this.options.cursor !== false ? 1 : 0;
		const contentWidth = Math.max(
			1,
			width - UI_INDENT_WIDTH - indent.length - PREVIEW_CONNECTOR_WIDTH - reserveCursor,
		);
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
				const connector = firstLine && index === 0 && this.options.firstConnector !== false;
				const prefix = connector ? PREVIEW_CONNECTOR_FIRST : PREVIEW_CONNECTOR_REST;
				out.push(UI_INDENT + indent + prefix + segment);
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


