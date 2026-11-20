/**
 * 十七、子代理结果弹窗（点击已完成的子代理块 → 只显示"返回给主 agent 的结论"）
 *
 * 为什么单独做：
 *   - 折叠态的块只显示结论头 4 行，长结论要展开（Ctrl+O）连带过程一起看，
 *     对"我只想看它到底回了什么"这件事太重；
 *   - 运行中的块本身在不断重建（每帧），点击留给 pi 的"展开/收起"；
 *     **完成后**点击某个子代理，弹一个只含结论的只读窗口更直接。
 *
 * 拦截方式：pi 的 `MouseRegion.handleMouse` 会**先把事件转发给子组件**
 * （`dispatchMouseEvent(child, event)`），子组件返回结果就用子组件的。所以视图实现
 * `handleMouse` 即可在 pi 的"点击展开"之前拿到点击；返回 `{ handled: true }` 阻止冒泡。
 *
 * `ctx.ui` 只能在事件里拿到，所以 `captureOverlayUi()` 在 session_start 时存一份。
 */

import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { BOLD_OFF, BOLD_ON, DIM_GRAY, ICON_CLOCK, MUTED, RESET_FG } from "./core.ts";
import {
	ICON_SUBAGENT,
	childFinalOutput,
	statusMark,
	statusMarkText,
} from "./subagent-data.ts";
import type { SubagentChildLike } from "./subagent-data.ts";

/** 内容区最小/最大宽度（字符列）。 */
const MIN_CONTENT_WIDTH = 28;
const MAX_CONTENT_WIDTH = 100;

/** 弹窗内容：标题 + 只读结论。 */
interface OverlayPayload {
	/** 标题行（图标 + 名称 + 状态 + 耗时）。 */
	title: string;
	/** 结论正文（已归一化换行）。 */
	body: string;
}

/** `ctx.ui`（`ui.custom` 只能在扩展事件里拿）。 */
let overlayUi: ExtensionContext["ui"] | undefined;

/** 在 session_start 里调用，保存 ui 引用（session_shutdown 清掉）。 */
export function captureOverlayUi(pi: ExtensionAPI): void {
	// on() 在老版本 pi / 单测桩里可能不存在：没有 ui 引用时点击只是不弹窗。
	pi.on?.("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		overlayUi = ctx.ui;
	});
	pi.on?.("session_shutdown", () => {
		overlayUi = undefined;
	});
}

/** 供测试注入/检查（生产由 captureOverlayUi 在 session_start 设置）。 */
export function setOverlayUiForTest(ui: ExtensionContext["ui"] | undefined): void {
	overlayUi = ui;
}

/**
 * 弹窗里显示的结论 = **最后一条 assistant 消息里的最后一个 text 块**。
 *
 * 与 `childFinalOutput()` 的差别要留意：那个函数为了跟 pi 的 `getFinalOutput()`
 * 对齐，取的是"最后一个 text 块之前的第一个 text"。一条消息里往往是
 * 「先说明一下 → 调工具 → 结论」，取第一个就会把过程当前言显示出来。
 * 弹窗的用途就是"只看结果"，所以这里取最后一段，没有就继续往前找。
 */
export function childResultText(child: SubagentChildLike): string {
	for (let i = child.messages.length - 1; i >= 0; i--) {
		const message = child.messages[i];
		if (message?.role !== "assistant") continue;
		const content = message.content ?? [];
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				return part.text.trim();
			}
		}
	}
	return childFinalOutput(child.messages).trim() || "(无输出)";
}

/** 标题行：`\uF4BE 名称 · ⏱ 耗时 · ✓`（状态标记复用块标题那一套，颜色一致）。 */
export function childResultTitle(child: SubagentChildLike, elapsed?: string): string {
	const timer = elapsed === undefined ? "" : `${MUTED} · ${ICON_CLOCK} ${elapsed}${RESET_FG}`;
	return (
		`${ICON_SUBAGENT} ${BOLD_ON}${child.agent}${BOLD_OFF}${timer}` +
		statusMarkText(statusMark([child], false))
	);
}

/**
 * 只读结果弹窗。
 *
 * 视觉与其它 overlay 保持一致（圆角边框、标题、底部提示），内容按宽度折行，
 * 支持 ↑↓ / PgUp PgDn / j k / g G 滚动，Esc / q 关闭。
 */
export class ChildResultOverlay implements Component {
	private top = 0;
	/** 折行后的正文（宽度变化时重算）。 */
	private wrappedFor?: number;
	private wrapped: string[] = [];
	/** 内容宽度（不含边框/内边距），由最长行决定并夹在 [MIN_CONTENT, maxContent]。 */
	private readonly contentWidth: number;
	private readonly cols: number;
	private readonly rows: number;

	// 注意：不用 TS 的"参数属性"写法（`private readonly x` 直接写在参数里）——
	// 那是**不可擦除语法**，pi 用 jiti / node --test 的 type-stripping 跑不了。
	private readonly payload: OverlayPayload;
	private readonly theme: Theme;
	private readonly done: () => void;

	constructor(options: {
		payload: OverlayPayload;
		theme: Theme;
		done: () => void;
		cols: number;
		rows: number;
	}) {
		this.payload = options.payload;
		this.theme = options.theme;
		this.done = options.done;
		this.cols = options.cols;
		this.rows = options.rows;
		// 自动宽度：最长一行的可见宽度 + 边框与左右内边距（4 列）。
		const natural = this.payload.body
			.split("\n")
			.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		const maxContent = Math.max(MIN_CONTENT_WIDTH, Math.min(this.cols - 6, MAX_CONTENT_WIDTH));
		this.contentWidth = Math.max(MIN_CONTENT_WIDTH, Math.min(natural, maxContent));
	}

	/** 弹窗宽度（含边框与内边距）。 */
	preferredWidth(): number {
		return this.contentWidth + 4;
	}

	/** 弹窗高度（含上下边框）：内容有多少行就多高，最多到终端高度 - 2。 */
	preferredHeight(): number {
		const body = this.bodyLines(this.contentWidth + 4).length;
		return Math.min(this.rows - 2, Math.max(1, body) + 4);
	}

	invalidate(): void {
		this.wrappedFor = undefined;
		this.wrapped = [];
	}

	/** 正文行（按内容宽度折行；已缓存）。 */
	private bodyLines(width: number): string[] {
		const contentWidth = Math.max(1, Math.min(this.contentWidth, width - 4));
		if (this.wrappedFor === contentWidth) return this.wrapped;
		const out: string[] = [];
		for (const line of this.payload.body.split("\n")) {
			if (line === "") {
				out.push("");
				continue;
			}
			out.push(...wrapTextWithAnsi(this.theme.fg("text", line), contentWidth));
		}
		this.wrappedFor = contentWidth;
		this.wrapped = out;
		return out;
	}

	/** 可见正文行数：内容有多少显示多少，超过终端高度才滚动。 */
	private viewport(): number {
		return Math.max(1, this.rows - 4);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (isCloseKey(data)) {
			this.done();
			return;
		}
		const page = Math.max(1, this.viewport() - 1);
		if (matchesKey(data, "up") || data === "k") this.top = Math.max(0, this.top - 1);
		else if (matchesKey(data, "down") || data === "j") this.top += 1;
		else if (matchesKey(data, "pageup")) this.top = Math.max(0, this.top - page);
		else if (matchesKey(data, "pagedown")) this.top += page;
		else if (data === "g") this.top = 0;
		else if (data === "G") this.top = Number.MAX_SAFE_INTEGER;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const total = Math.max(8, Math.min(width, this.preferredWidth()));
		const inner = total - 4;
		const border = DIM_GRAY;
		const body = this.bodyLines(total);
		// 高度自适应：内容多少就多高（上限 rows-2，超出则滚动）。
		const viewport = Math.min(Math.max(1, body.length), this.viewport());
		const maxTop = Math.max(0, body.length - viewport);
		this.top = Math.max(0, Math.min(this.top, maxTop));

		const titleText = truncateToWidth(this.payload.title, Math.max(0, total - 6), "…");
		// "╭─ " = 3 列、标题后还有一个空格、末尾 "╮" = 1 列 → 填充 = total - 5 - 标题宽
		const topFill = Math.max(0, total - 5 - visibleWidth(titleText));
		const lines = [`${border}╭─ ${titleText}${border} ${"─".repeat(topFill)}╮${RESET_FG}`];

		for (const line of body.slice(this.top, this.top + viewport)) {
			lines.push(`${border}│${RESET_FG} ${padRight(line, inner)} ${border}│${RESET_FG}`);
		}

		const position =
			body.length > viewport
				? `  ${this.top + 1}-${Math.min(body.length, this.top + viewport)}/${body.length}`
				: "";
		const hint = truncateToWidth(
			`${theme.fg("muted", `↑↓ 滚动 · Esc 关闭${position}`)}`,
			Math.max(0, total - 5),
			"…",
		);
		const bottomFill = Math.max(0, total - 5 - visibleWidth(hint));
		lines.push(`${border}╰─ ${hint}${border} ${"─".repeat(bottomFill)}╯${RESET_FG}`);
		return lines;
	}
}

/** 终端鼠标序列（SGR：`ESC [ < b ; x ; y M/m`）——必须放行给 pi 的鼠标分发。 */
function isMouseSequence(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[Mm]/.test(data);
}

/** 关闭键：Esc（含 CSI 变体）/ q / Q。 */
function isCloseKey(data: string): boolean {
	return matchesKey(data, "escape") || data === "q" || data === "Q";
}

/** 把一行补到指定宽度（弹窗正文已由 wrapTextWithAnsi 保证不超宽）。 */
function padRight(line: string, width: number): string {
	const current = visibleWidth(line);
	return current >= width ? truncateToWidth(line, width, "") : line + " ".repeat(width - current);
}

/** 打开某个子代理的结果弹窗（没有 ui 引用时静默忽略）。 */
export async function showChildResultOverlay(
	child: SubagentChildLike,
	elapsed?: string,
): Promise<void> {
	const ui = overlayUi;
	if (!ui) return;
	const payload: OverlayPayload = {
		title: childResultTitle(child, elapsed),
		body: childResultText(child),
	};

	let overlay: ChildResultOverlay | undefined;
	await ui.custom(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) => {
			const terminal = (tui as unknown as { terminal?: { columns?: number; rows?: number } })
				.terminal;
			const cols = terminal?.columns ?? 80;
			const rows = terminal?.rows ?? 24;

			// 让弹窗成为**最上层且独占键盘**。
			//
			// 只依赖组件自身的 handleInput 是不够的：overlay 的焦点会被鼠标事件抢走，
			// 于是"鼠标不在窗口上时按 Esc 没反应"。这里挂一个**扩展级终端输入监听**
			// （`ui.onTerminalInput`，在焦点分发之前跑），行为：
			//   - 鼠标序列原样放行（否则 pi 收不到点击/滚轮）；
			//   - Esc / q → 关闭并消费；
			//   - 滚动键 → 交给弹窗滚动并消费；
			//   - 其余按键 → 直接消费（模态：不要漏进输入框）。
			let unsubscribe: (() => void) | undefined;
			let closed = false;
			let component: ChildResultOverlay | undefined;
			const close = (): void => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				unsubscribe = undefined;
				done();
			};
			const handle = (data: string): unknown => {
				if (closed) return undefined;
				if (isMouseSequence(data)) return undefined;
				// Ctrl+C 永远放行：就算弹窗开着，用户也要能中断正在跑的 agent。
				if (data === "\x03") return undefined;
				if (isKeyRelease(data)) return { consume: true };
				if (isCloseKey(data)) {
					close();
					return { consume: true };
				}
				component?.handleInput(data);
				return { consume: true };
			};
			const uiWithInput = ui as unknown as {
				onTerminalInput?: (handler: (data: string) => unknown) => () => void;
			};
			unsubscribe =
				uiWithInput.onTerminalInput?.(handle) ??
				(
					tui as unknown as {
						addInputListener?: (handler: (data: string) => unknown) => () => void;
					}
				).addInputListener?.(handle);

			component = new ChildResultOverlay({ payload, theme, done: close, cols, rows });
			overlay = component;
			return component;
		},
		{
			overlay: true,
			// 尺寸按内容自动算：宽度取最长一行（夹在 28~100 列），高度按内容行数。
			overlayOptions: () => ({
				width: overlay?.preferredWidth() ?? MIN_CONTENT_WIDTH + 4,
				maxHeight: overlay?.preferredHeight() ?? 24,
				anchor: "center",
				margin: 1,
			}),
		},
	);
}
