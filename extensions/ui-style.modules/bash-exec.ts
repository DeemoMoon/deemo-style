/**
 * 七、`!` 内联命令面板（原型补丁：整块绿色圆角边框，含渲染缓存）
 *
 * 计时与思考块 / 工具面板共用 BlockClock：running 开始、结束就地定格，
 * 不持有定时器；回放时（构造即 complete）不显示假耗时。
 */

import {
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import {
	BashExecutionComponent,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import {
	ACCENT_GREEN,
	BAD_RED,
	BOLD_OFF,
	BOLD_ON,
	DIM_GRAY,
	execClockText,
	liveClockText,
	EXEC_PREVIEW_LINES,
	FEATURES,
	fg24,
	ICON_CLOCK,
	ICON_SEARCH,
	MUTED,
	RESET_FG,
	sgr,
	shimmerText,
	touchClock,
	patchPrototypeSlots,
	unpatchPrototypeSlots,
	UI_INDENT,
	UI_INDENT_WIDTH,
	WARN_YELLOW,
} from "./core.ts";
import type {
	BlockClock,
} from "./core.ts";

/** 展开态最多显示的行数上限（防止海量输出撑爆屏幕）。 */
const MAX_EXEC_DISPLAY_LINES = 1000;
/**
 * 显示用的字节上限，与 pi 送给模型的默认上限（DEFAULT_MAX_BYTES = 50KB）对齐。
 * 不设的话，超长行的输出在展开态会显示得比"模型实际看到的内容"还多。
 */
const MAX_EXEC_DISPLAY_BYTES = 50 * 1024;
/** 折叠态最多显示的“可视行”数（源行换行后可能远多于源行数）。 */
const MAX_EXEC_COLLAPSED_ROWS = EXEC_PREVIEW_LINES * 2;

interface BashExecLike {
	command: string;
	outputLines: string[];
	status: string;
	exitCode?: number | null;
	expanded: boolean;
	loader: { render(width: number): string[] };
	truncationResult?: { truncated?: boolean } | undefined;
	fullOutputPath?: string;
	colorKey: string;
	/** 计时（与思考块/工具面板共用 BlockClock）：存在组件实例上跨 updateDisplay 复用。 */
	__piExecClock?: BlockClock;
	/** 复用的框视图：appendOutput 可能每块数据都调一次 updateDisplay。 */
	__piExecView?: ExecBoxView;
	clear(): void;
	addChild(component: Component): void;
}

interface BashExecPrototype extends BashExecLike {
	updateDisplay(): void;
	[key: `ui-style:${string}`]: unknown;
}

/**
 * 把计时后缀追加到一行末尾；宽度不够时先截断正文，保证计时完整可见。
 * （`!` 命令结束态把计时放在命令行行尾。）
 */
function appendClockSuffix(text: string, clock: string, inner: number): string {
	const suffix = `${MUTED} · ${ICON_CLOCK} ${clock}${RESET_FG}`;
	const room = Math.max(0, inner - visibleWidth(suffix));
	return `${truncateToWidth(text, room, "…")}${suffix}`;
}

/**
 * 运行中的 loader 行：左边是 pi 的转圈文案，计时右对齐到框内右边缘。
 * 放不下时优先保住计时，截断左侧文案。
 */
function composeLoaderLine(line: string, clock: string, inner: number): string {
	const right = `${MUTED}${ICON_CLOCK} ${clock}${RESET_FG}`;
	const rightWidth = visibleWidth(right);
	const left = truncateToWidth(line, Math.max(0, inner - rightWidth - 1), "…");
	const gap = Math.max(0, inner - visibleWidth(left) - rightWidth);
	return `${left}${" ".repeat(gap)}${right}`;
}

/**
 * 框视图：圆角绿色边框 + 命令行 + 输出 + 状态。
 * 渲染缓存：结束态整框按内容签名缓存；运行态缓存静态部分（边框 + 命令 +
 * 输出），只有 loader 转圈行每帧重算——pi 的 loader 动画会持续触发整屏重绘。
 */
class ExecBoxView {
	private readonly inst: BashExecLike;
	private cacheKey?: string;
	private cachedFull?: string[];
	private cachedHead?: string[];

	constructor(inst: BashExecLike) {
		this.inst = inst;
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cachedFull = undefined;
		this.cachedHead = undefined;
	}

	/** 内容签名：任何一个字段变化都应重建整框。 */
	private signature(width: number): string {
		const inst = this.inst;
		// 最后一行长度也要进签名：pi 的 appendOutput 会把新数据追加到最后一个
		// 元素里（行数不变），只有长度能反映这种变化。
		const lastLine = inst.outputLines[inst.outputLines.length - 1] ?? "";
		return [
			width,
			inst.outputLines.length,
			lastLine.length,
			inst.status,
			inst.exitCode ?? "",
			inst.expanded ? 1 : 0,
			inst.colorKey,
			inst.truncationResult?.truncated ? 1 : 0,
			inst.fullOutputPath ?? "",
		].join("|");
	}

	render(width: number): string[] {
		const key = this.signature(width);
		const inner = Math.max(1, Math.max(6, width - UI_INDENT_WIDTH) - 2);
		if (this.inst.status !== "running") {
			if (this.cachedFull !== undefined && this.cacheKey === key) {
				return this.cachedFull;
			}
			this.cachedFull = this.assemble(width, inner, this.contentLines(inner, true));
			this.cacheKey = key;
			return this.cachedFull;
		}

		// 只有“真在扫光”时才把命令行放到每帧路径；否则把它一起缓起来。
		// 长命令（挤不进一行）本来就不扫光，却每帧重新 wrap 一次 2KB 文本是浪费
		// （实测 ~350µs/帧）。
		const animate = this.shimmers(inner);
		if (this.cachedHead === undefined || this.cacheKey !== key) {
			const borderColor = this.borderColor();
			const top = this.frameLine(borderColor, inner, "╭", "╮");
			const body = animate
				? this.outputSegments(inner)
				: this.contentLines(inner, false);
			this.cachedHead = [top, ...this.borderize(borderColor, inner, body)].map((line) =>
				truncateToWidth(line, width, "…"),
			);
			this.cacheKey = key;
		}

		// loader 转圈行每帧新算，拼在静态部分与底边框之间；计时右对齐跟着每帧跳。
		const borderColor = this.borderColor();
		const commandLines = animate
			? this.borderize(borderColor, inner, this.commandSegments(inner, false))
			: [];
		// 运行中用 liveClockText：首帧（0~几 ms）不显示，避免闪一下 "0ms"。
		const clock = liveClockText(this.inst.__piExecClock);
		const loaderContent = this.inst.loader.render(inner);
		const loaderWithClock =
			clock === undefined || loaderContent.length === 0
				? loaderContent
				: loaderContent.map((line, index) =>
						index === loaderContent.length - 1
							? composeLoaderLine(line, clock, inner)
							: line,
					);
		const loaderLines = this.borderize(borderColor, inner, loaderWithClock);
		const bottom = this.frameLine(borderColor, inner, "╰", "╯");
		// cachedHead 里的行在生成时已经 truncate 过、borderize 也会补到精确宽度；
		// 每帧只需要处理这一帧新生成的那几行（loader / 命令行 / 底边框）。
		const fit = (line: string) => truncateToWidth(line, width, "…");
		return [
			...(this.cachedHead[0] !== undefined ? [this.cachedHead[0]] : []),
			...commandLines.map(fit),
			...this.cachedHead.slice(1),
			...loaderLines.map(fit),
			fit(bottom),
		];
	}

	/** `!` 命令绿色边框；`!!`（输出不进模型上下文）灰色边框。 */
	private borderColor(): string {
		return this.inst.colorKey === "dim" ? DIM_GRAY : sgr(ACCENT_GREEN);
	}

	private frameLine(borderColor: string, inner: number, left: string, right: string): string {
		return UI_INDENT + `${borderColor}${left}${"─".repeat(inner)}${right}${RESET_FG}`;
	}

	private borderize(borderColor: string, inner: number, lines: string[]): string[] {
		return lines.map((line) => {
			const padding = " ".repeat(Math.max(0, inner - visibleWidth(line)));
			return UI_INDENT + `${borderColor}│${RESET_FG}${line}${padding}${borderColor}│${RESET_FG}`;
		});
	}

	/** 组装整框（结束态）。 */
	private assemble(width: number, inner: number, content: string[]): string[] {
		const borderColor = this.borderColor();
		const lines = [
			this.frameLine(borderColor, inner, "╭", "╮"),
			...this.borderize(borderColor, inner, content),
			this.frameLine(borderColor, inner, "╰", "╯"),
		];
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	/** 框内内容：命令行 + 输出（+ 结束态的状态区）。结束态整框一起缓存。 */
	private contentLines(inner: number, includeStatus: boolean): string[] {
		// displayLines 有行/字节扫描，同一帧只算一次给 output/status 共用。
		const display = this.displayLines();
		return [
			...this.commandSegments(inner, includeStatus),
			...this.outputSegments(inner, display),
			...(includeStatus && this.inst.status !== "running"
				? this.statusSegments(inner, display)
				: []),
		];
	}

	/**
	 * 命令行是否会扫光：运行中 + 开了扫光 + 命令能挤进一行。
	 * 长命令扫光会飞快掠过、观感差，而且每帧重 wrap 很贵，所以直接不扫。
	 */
	private shimmers(inner: number): boolean {
		if (this.inst.status !== "running" || !FEATURES.shimmerTitle) return false;
		return visibleWidth(`${ICON_SEARCH} ${this.inst.command}`) + 2 <= inner;
	}

	/**
	 * 框内第一行：图标 + 指令（边框色加粗）；结束态在行尾接上总耗时。
	 *
	 * 运行中且命令能挤进一行时套标题扫光（与工具面板同一种效果）。
	 */
	private commandSegments(inner: number, includeStatus: boolean): string[] {
		const borderColor = this.borderColor();
		const text = `${ICON_SEARCH} ${this.inst.command}`;
		const styled = this.shimmers(inner)
			? `${BOLD_ON}${shimmerText(text, ACCENT_GREEN, this.inst.__piExecClock?.startedAt)}${BOLD_OFF}`
			: `${borderColor}${BOLD_ON}${text}${BOLD_OFF}${RESET_FG}`;

		const segments = wrapTextWithAnsi(styled, inner);
		const elapsed = includeStatus
			? this.inst.status === "running"
				? liveClockText(this.inst.__piExecClock)
				: execClockText(this.inst.__piExecClock)
			: undefined;
		if (elapsed !== undefined && segments.length > 0) {
			const lastIndex = segments.length - 1;
			segments[lastIndex] = appendClockSuffix(segments[lastIndex] ?? "", elapsed, inner);
		}
		return segments;
	}

	/** 真正参与显示的行（先按总量封顶，再按折叠/展开取窗口）。 */
	private displayLines(): string[] {
		const all = this.inst.outputLines;
		let capped = all.length > MAX_EXEC_DISPLAY_LINES ? all.slice(-MAX_EXEC_DISPLAY_LINES) : all;

		// 再按字节从尾部往前收（至少留一行）。
		// 注意：不能因为“当前是最后一行”就跳过检查——单行 500KB 的输出
		// 会原样留下来，随后被 wrap 成几千条可视行。
		let bytes = 0;
		let start = capped.length;
		while (start > 0) {
			const line = capped[start - 1] ?? "";
			const next = bytes + line.length + 1;
			if (next > MAX_EXEC_DISPLAY_BYTES) {
				if (start === capped.length) {
					// 全文只有这一行（或它是唯一保留的行）：只保留尾部字节。
					capped = [line.slice(Math.max(0, line.length - MAX_EXEC_DISPLAY_BYTES))];
					start = 0;
				}
				break;
			}
			bytes = next;
			start -= 1;
		}
		if (start > 0) capped = capped.slice(start);

		return this.inst.expanded ? capped : capped.slice(-EXEC_PREVIEW_LINES);
	}

	/**
	 * 输出：折叠显示末尾 EXEC_PREVIEW_LINES 行，展开显示全部（有上限）。
	 *
	 * 除了源行数/字节数，还要限制**换行后的可视行数**：一条没有换行的
	 * 长行在 80 列下能变成几十上百行，仅靠源行数封顶挡不住。
	 */
	private outputSegments(inner: number, display = this.displayLines()): string[] {
		// 展开态已经按 50KB 封顶，不再把单行硬切到 256 字符（minified JSON / base64
		// 会只剩开头一小段且没有任何提示）。折叠态仍用短上限控制每帧成本。
		const lineLimit = this.inst.expanded ? MAX_EXEC_DISPLAY_BYTES : Math.max(256, inner * 4);
		const segments: string[] = [];
		for (const line of display) {
			const safeLine =
				line.length > lineLimit ? `${line.slice(0, lineLimit)}…` : line;
			for (const wrapped of wrapTextWithAnsi(safeLine ? `${MUTED}${safeLine}${RESET_FG}` : "", inner)) {
				segments.push(wrapped);
			}
		}
		const rowCap = this.inst.expanded ? MAX_EXEC_DISPLAY_LINES : MAX_EXEC_COLLAPSED_ROWS;
		return segments.length > rowCap ? segments.slice(-rowCap) : segments;
	}

	/** 结束态的状态区：折叠提示 / 取消 / 退出码 / 截断提示。 */
	private statusSegments(inner: number, display = this.displayLines()): string[] {
		const all = this.inst.outputLines;
		const statusParts: string[] = [];
		const hiddenCount = all.length - display.length;
		if (hiddenCount > 0) {
			// 展开态已经按 1000 行 / 50KB 封顶，再按 Ctrl+O 只会收起，不会出现更多；
			// 这里明确说是输出上限，而不是继续骗用户“to expand”。
			if (this.inst.expanded) {
				statusParts.push(`${MUTED}... ${hiddenCount} lines hidden (output limit)${RESET_FG}`);
			} else {
				const hint = keyHint("app.tools.expand", "to expand");
				statusParts.push(`${MUTED}... ${hiddenCount} more lines (${hint})${RESET_FG}`);
			}
		}
		if (this.inst.status === "cancelled") {
			statusParts.push(fg24(WARN_YELLOW, "(cancelled)"));
		} else if (this.inst.status === "error") {
			statusParts.push(fg24(BAD_RED, `(exit ${this.inst.exitCode ?? "?"})`));
		}
		const wasTruncated = this.inst.truncationResult?.truncated;
		if (wasTruncated && this.inst.fullOutputPath) {
			statusParts.push(
				fg24(WARN_YELLOW, `Output truncated. Full output: ${this.inst.fullOutputPath}`),
			);
		}

		const segments: string[] = [];
		for (const part of statusParts) {
			for (const wrapped of wrapTextWithAnsi(part, inner)) segments.push(wrapped);
		}
		return segments;
	}
}

function rebuildExecDisplay(instance: BashExecLike): void {
	// 复用同一个视图：pi 的 appendOutput 会为每块输出调一次 updateDisplay，
	// 每块都 clear() + 新建组件会丢掉框的全部缓存。
	// 用 instanceof 而不是版本号：/reload 后旧模块的视图类已经不同，必须重建。
	if (instance.__piExecView instanceof ExecBoxView) {
		instance.__piExecView.invalidate();
		return;
	}
	instance.clear();
	instance.addChild(new Spacer(1));
	const view = new ExecBoxView(instance);
	instance.__piExecView = view;
	instance.addChild(view as unknown as Component);
}

export function patchBashExec(): void {
	const proto = BashExecutionComponent.prototype as unknown as BashExecPrototype;

	const patchedUpdateDisplay = function (this: BashExecPrototype): void {
		// `!` 命令也是有生命周期的块：running 开始计时，结束就地定格
		// （与工具面板、思考块共用同一套 BlockClock）。
		const clock = (this.__piExecClock ??= {});
		touchClock(clock, this.status === "running");
		try {
			rebuildExecDisplay(this);
		} catch {
			// 重建失败时不能只调原生 updateDisplay：它写的是 contentContainer，
			// 而 contentContainer 已经被 clear() 从 children 里摘掉。这里给一个
			// 最小的只读回退块，至少命令行和最近的输出还在。
			this.__piExecView = undefined;
			this.clear();
			this.addChild(new Spacer(1));
			const tail = this.outputLines.slice(-EXEC_PREVIEW_LINES).join("\n");
			this.addChild(new Text(`${this.command}${tail ? `\n${tail}` : ""}`, 0, 0));
		}
	};
	patchPrototypeSlots(proto, "ui-style:bash-exec", { updateDisplay: patchedUpdateDisplay });
}

/** 恢复 pi 原来的渲染方法；删除扩展或重启时使用。 */
export function unpatchBashExec(): void {
	const proto = BashExecutionComponent.prototype as unknown as BashExecPrototype;
	unpatchPrototypeSlots(proto, "ui-style:bash-exec", ["updateDisplay"]);
}

