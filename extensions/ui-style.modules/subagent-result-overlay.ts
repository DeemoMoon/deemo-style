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
class ChildResultOverlay implements Component {
	private top = 0;
	/** 折行后的正文（宽度变化时重算）。 */
	private wrappedFor?: number;
	private wrapped: string[] = [];

	// 注意：不用 TS 的"参数属性"写法（`private readonly x` 直接写在参数里）——
	// 那是**不可擦除语法**，pi 用 jiti / node --test 的 type-stripping 跑不了。
	private readonly payload: OverlayPayload;
	private readonly theme: Theme;
	private readonly rows: number;
	private readonly done: () => void;

	constructor(payload: OverlayPayload, theme: Theme, rows: number, done: () => void) {
		this.payload = payload;
		this.theme = theme;
		this.rows = rows;
		this.done = done;
	}

	invalidate(): void {
		this.wrappedFor = undefined;
		this.wrapped = [];
	}

	/** 正文行（按内容宽度折行；已缓存）。 */
	private bodyLines(width: number): string[] {
		if (this.wrappedFor === width) return this.wrapped;
		const contentWidth = Math.max(1, width - 4); // 两侧边框 + 各 1 空格
		const out: string[] = [];
		for (const line of this.payload.body.split("\n")) {
			if (line === "") {
				out.push("");
				continue;
			}
			out.push(...wrapTextWithAnsi(this.theme.fg("text", line), contentWidth));
		}
		this.wrappedFor = width;
		this.wrapped = out;
		return out;
	}

	/** 可见正文行数（扣掉顶/底边框与提示行）。 */
	private viewport(): number {
		return Math.max(1, Math.min(this.rows - 4, 40));
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
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
		const body = this.bodyLines(width);
		const viewport = this.viewport();
		const maxTop = Math.max(0, body.length - viewport);
		this.top = Math.max(0, Math.min(this.top, maxTop));

		const total = Math.max(8, width);
		const inner = total - 4;
		const border = DIM_GRAY;

		const titleText = truncateToWidth(this.payload.title, Math.max(0, total - 6), "…");
		// "╭─ " = 3 列、标题后还有一个空格、末尾 "╮" = 1 列 → 填充 = total - 5 - 标题宽
		const topFill = Math.max(0, total - 5 - visibleWidth(titleText));
		const lines = [
			`${border}╭─ ${titleText}${border} ${"─".repeat(topFill)}╮${RESET_FG}`,
		];

		const slice = body.slice(this.top, this.top + viewport);
		for (const line of slice) {
			lines.push(`${border}│${RESET_FG} ${padRight(line, inner)} ${border}│${RESET_FG}`);
		}
		// 内容不足时补空行，保证弹窗高度稳定（不随结论长短跳）。
		for (let i = slice.length; i < viewport; i++) {
			lines.push(`${border}│${RESET_FG} ${" ".repeat(inner)} ${border}│${RESET_FG}`);
		}

		const position =
			body.length > viewport ? `  ${this.top + 1}-${Math.min(body.length, this.top + viewport)}/${body.length}` : "";
		const hint = truncateToWidth(
			`${theme.fg("muted", `↑↓ 滚动 · Esc 关闭${position}`)}`,
			Math.max(0, total - 5),
			"…",
		);
		const bottomFill = Math.max(0, total - 5 - visibleWidth(hint));
		lines.push(
			`${border}╰─ ${hint}${border} ${"─".repeat(bottomFill)}╯${RESET_FG}`,
		);
		return lines;
	}
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
	await ui.custom(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) =>
			new ChildResultOverlay(
				payload,
				theme,
				(tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24,
				() => done(),
			),
		{
			overlay: true,
			overlayOptions: () => ({
				width: "72%",
				maxHeight: "80%",
				anchor: "center",
				margin: 1,
			}),
		},
	);
}
