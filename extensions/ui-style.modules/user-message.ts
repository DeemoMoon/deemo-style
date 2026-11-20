/**
 * 八、用户消息样式（黄色加粗 + \uE370 图标 + 左移一列）
 *
 * 三件事：把主题 token（userMessageText/userMessageBg）改成黄字无背景、
 * 用 markdown 变换给每行加粗并在首行插图标、render 后删掉 Markdown 的
 * 左内边距与末尾空行（顺带保留 OSC133 标记）。三级标题改写也在这一节
 * （一个扩展只能注册一个 markdown transformer，必须合并在同一回调里）。
 */

import {
	foregroundAnsi,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	BOLD_OFF,
	BOLD_ON,
	FEATURES,
	hasVisibleText,
	LEADING_CONTROL,
	LEADING_SPACES,
	patchPrototypeSlots,
	PI_OUTPUT_PAD,
	prototypeOriginal,
	unpatchPrototypeSlots,
} from "./core.ts";

/** 深色背景用亮黄，浅色背景用深金，避免黄字在白底上看不清。 */
const USER_YELLOW_ON_DARK = { kind: "rgb", r: 245, g: 197, b: 66 } as const;
const USER_YELLOW_ON_LIGHT = { kind: "rgb", r: 154, g: 107, b: 0 } as const;
/** 用户消息无背景（pi 默认会给 userMessageBg 上色）。 */
const NO_BACKGROUND = "\x1b[49m";

/**
 * 用户消息整体左移的列数。pi 的 UserMessageComponent 内部 Markdown 用
 * outputPad（= PI_OUTPUT_PAD）作为 paddingX，每行开头有 1 个空格。这里在
 * render 后把这些空格去掉，末尾补回同样多保持总宽不变——只动左边，右边距和
 * 行宽都不变。删完之后图标落到第 0 列、正文落到 GUTTER 列，与助手消息一致
 * （正文之所以对齐，是因为 transformUserMarkdown 会加上「图标 + 1 个空格」）。
 * 用户消息背景已被扩展设为无背景，删空格不会破坏背景行。
 */
const USER_PAD_SHIFT = PI_OUTPUT_PAD;

interface UserMessageRuntime {
	render(width: number): string[];
	invalidate?(): void;
	/** UserMessageComponent 的运行时字段。 */
	text?: string;
	outputPad?: number;
	[key: `ui-style:${string}`]: unknown;
}

interface UserPadCacheEntry {
	width: number;
	text: string | undefined;
	outputPad: number | undefined;
	lines: string[];
}

/**
 * 按实例缓存变换结果。用模块级 WeakMap 而不是实例字段：unpatch 时可以直接换一张
 * 新表丢掉旧行（旧行里含旧主题的 ANSI），实例字段在原型恢复后没人清得掉。
 */
let userPadCache = new WeakMap<object, UserPadCacheEntry>();

/**
 * 用户消息渲染补丁：整体左移一列，并删掉 Markdown paddingY 留在末尾的空行。
 *
 * 与其他原型补丁一样支持 /reload：先恢复原方法再重新打补丁，否则旧模块的
 * 闭包会一直被原型引用（既改不动行为，也无法回收）。FEATURES.userMessage
 * 关闭时由调用方走 unpatch。
 */
export function patchUserMessagePad(): void {
	const proto = UserMessageComponent.prototype as unknown as UserMessageRuntime;
	// 从 original 槽位取 pi 的实现（避免 /reload 时把旧补丁当成 original）。
	const originalRender = prototypeOriginal(proto, "ui-style:user-pad", "render");
	const originalInvalidate = prototypeOriginal(proto, "ui-style:user-pad", "invalidate");

	const patchedRender = function (this: UserMessageRuntime, width: number): string[] {
		// pi 的 ScrollView 每帧会重渲染整个 transcript；Markdown 自己按宽度缓存，
		// 但这里对每一行再去 ANSI/空格/尾行处理仍是 O(总行数)。缓存按
		// (宽度, 文本, padding) 命中；invalidate() 时清空，主题切换不会拿旧颜色。
		const cached = userPadCache.get(this);
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.text === this.text &&
			cached.outputPad === this.outputPad
		) {
			return cached.lines;
		}

		const lines = originalRender.call(this, width);
		if (USER_PAD_SHIFT <= 0) return lines;
		// 行首可能有 OSC 133 标记、背景重置/颜色等 CSI 序列（例如 \x1b[49m），
		// 全部原样保留，只在其后的前导空格里删掉 1 个，再在行尾补回保持总宽。
		const shifted = lines.map((line) => {
			const prefix = LEADING_CONTROL.exec(line)?.[0] ?? "";
			const rest = line.slice(prefix.length);
			const spaces = LEADING_SPACES.exec(rest)?.[0];
			if (!spaces) return line;
			const removed = Math.min(USER_PAD_SHIFT, spaces.length);
			return prefix + rest.slice(removed) + " ".repeat(removed);
		});

		// Markdown 用 paddingY=1 在末尾留一条背景色空行。用户消息背景已被本扩展
		// 去掉后，这条空行会变成可见空白，和下一条助手消息自己的顶部 Spacer 叠成
		// 两行。这里删掉末尾的空行，垂直间距统一交给下一条消息的 Spacer。
		//
		// pi 把 OSC 133 zone 结束标记挂在最后一行行首；删除前把它们搬到新的末行
		// 行尾，既保留 shell 集成标记，也不会让标记提前结束 zone。最后至少保留
		// 一行，避免纯空消息把整个组件渲染成 0 行。
		let end = shifted.length;
		let trailingMarkers = "";
		while (end > 1 && !hasVisibleText(shifted[end - 1] ?? "")) {
			trailingMarkers =
				(LEADING_CONTROL.exec(shifted[end - 1] ?? "")?.[0] ?? "") + trailingMarkers;
			end--;
		}
		let result = shifted;
		if (end !== shifted.length) {
			result = shifted.slice(0, end);
			if (trailingMarkers !== "") {
				result[end - 1] = (result[end - 1] ?? "") + trailingMarkers;
			}
		}
		userPadCache.set(this, {
			width,
			text: this.text,
			outputPad: this.outputPad,
			lines: result,
		});
		return result;
	};
	const impls: Record<string, (...args: never[]) => unknown> = {
		render: patchedRender as (...args: never[]) => unknown,
	};
	if (typeof originalInvalidate === "function") {
		const patchedInvalidate = function (this: UserMessageRuntime): void {
			userPadCache.delete(this);
			originalInvalidate.call(this);
		};
		impls.invalidate = patchedInvalidate as (...args: never[]) => unknown;
	}
	patchPrototypeSlots(proto, "ui-style:user-pad", impls);
}

/** 恢复 pi 原来的用户消息渲染方法。 */
export function unpatchUserMessagePad(): void {
	const proto = UserMessageComponent.prototype as unknown as UserMessageRuntime;
	unpatchPrototypeSlots(proto, "ui-style:user-pad", ["render", "invalidate"]);
	// 缓存里藏着旧代码的行结果；换一张新表，旧实例的行随旧表一起被回收。
	userPadCache = new WeakMap();
}
/** Theme 的 fg/bg 使用构造时缓存的 ANSI Map，这里只改用户消息用到的两个 token。 */
interface ThemeInternals {
	fgAnsi?: Map<string, string>;
	bgAnsi?: Map<string, string>;
	getColorMode?: () => "truecolor" | "256color";
	appearance?: "dark" | "light";
}

function applyUserMessageTheme(ui: ExtensionContext["ui"]): void {
	try {
		const theme = ui.theme as unknown as ThemeInternals;
		const mode = theme.getColorMode?.() ?? "truecolor";
		const yellow = theme.appearance === "light" ? USER_YELLOW_ON_LIGHT : USER_YELLOW_ON_DARK;
		theme.fgAnsi?.set("userMessageText", foregroundAnsi(yellow, mode));
		theme.bgAnsi?.set("userMessageBg", NO_BACKGROUND);
	} catch {
		// 主题尚未初始化，或 pi 内部结构变化：只保留加粗和图标。
	}
}

// CommonMark 规则：缩进超过 3 个空格的 ``` 属于缩进代码块而不是 fence。
// 用户消息加粗与助手标题改写共用（两边都要跳过代码块内部）。
const FENCE_LINE = /^ {0,3}(?:```|~~~)/;
const USER_TABLE_ROW = /^\s*\|/;
// 只有“形如标签”的行（< 或 </ 后跟字母）才按 HTML 处理。
const USER_HTML_LINE = /^\s*<\/?[A-Za-z]/;
const USER_HR = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
/** 行首的块级标记：缩进、引用、标题、列表。ANSI 放在标记之后不破坏 Markdown。 */
const USER_LEADING_PREFIX = /^(\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d{1,9}[.)])\s+)?)/;

function userLeadingPrefix(line: string): string {
	return line.match(USER_LEADING_PREFIX)?.[1] ?? "";
}

/**
 * 给用户消息的每一行加粗，并在第一个非空内容行前加 \uE370 图标；代码块/表格/HTML/分隔线保持原样。
 *
 * 图标插在块级前缀（引用 >、标题 #、列表 -）**之前**，永远落在第 0 列，
 * 与助手消息图标同列；插在前缀之后会被算进引用块/标题/列表项内容，
 * 悬挂缩进就会和「正文落到 GUTTER 列」的设计错位。
 */
function transformUserMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let sparkleAdded = false;

	for (const line of lines) {
		if (FENCE_LINE.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence || !line.trim() || USER_TABLE_ROW.test(line) || USER_HTML_LINE.test(line) || USER_HR.test(line)) {
			out.push(line);
			continue;
		}

		const prefix = userLeadingPrefix(line);
		const content = line.slice(prefix.length);
		if (!content.trim()) {
			out.push(line);
			continue;
		}

		// 图标落在块级前缀（引用/标题/列表标记）**之前**：永远在第 0 列，
		// 与助手消息图标同列；插进前缀之后会被算进引用块/标题内容，
		// 悬挂缩进就错位了。加粗只包内容，不动前缀（前缀是结构标记）。
		const icon = sparkleAdded ? "" : `\uE370 `;
		sparkleAdded = true;
		out.push(`${icon}${prefix}${BOLD_ON}${content}${BOLD_OFF}`);
	}

	// 消息以代码块/表格开头时，图标单独占一行。
	return sparkleAdded ? out.join("\n") : `\uE370\n\n${markdown}`;
}

// CommonMark ATX 标题：最多 3 列缩进、可跟在任意层引用标记后，内容允许收尾的 "#"。
const DEEP_HEADING = /^( {0,3}(?:> ?)*)(#{3,6})([ \t]+)(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** h3~h6 统一只用一个标记，层级由标题样式颜色区分。 */
const DEEP_HEADING_MARKER = "\u25b8";

/**
 * 把 h3~h6 改写成 "▸ 标题" 的加粗行。
 *
 * pi 的渲染器只对 h1/h2 吞掉 "#" 前缀，h3 及更深会原样输出 "### "
 * （pi-tui/dist/components/markdown.js 里 `headingLevel >= 3` 那一支），
 * 主题只能改颜色，改不了前缀。这里在渲染前把标题换成段落，颜色用主题的
 * `mdHeading` token——和 h1/h2 同一个颜色，自动跟随主题切换；
 * 只影响显示，会话里存的仍是原始 markdown。
 */
function rewriteDeepHeadings(markdown: string, theme: ExtensionContext["ui"]["theme"]): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			// fence 内部的 "###"（Python 注释、shell 注释等）一律不动。
			if (FENCE_LINE.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;

			const match = DEEP_HEADING.exec(line);
			if (!match) return line;

			const [, quote, hashes, , text] = match;
			// 流式中 "### " 刚打出来、标题还没内容：先按原样放着，避免闪一个空 ▸。
			if (!text.trim()) return line;

			const marker = DEEP_HEADING_MARKER;
			// 颜色用主题的 mdHeading，和 h1/h2 完全一致；加粗由 BOLD_OFF 收尾。
			return `${quote}${BOLD_ON}${theme.fg("mdHeading", `${marker} ${text}`)}${BOLD_OFF}`;
		})
		.join("\n");
}

export function setupMarkdownTransforms(pi: ExtensionAPI): void {
	let ui: ExtensionContext["ui"] | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		if (FEATURES.userMessage) applyUserMessageTheme(ui);
	});

	pi.on("session_shutdown", () => {
		// 不留旧会话的 ui 引用：下次 session_start 会重新赋值。
		ui = undefined;
	});

	// 一个扩展只有一个 markdown transformer（再次 register 会顶掉前一个），
	// 所以用户消息上色和标题改写必须合并在同一个回调里。
	pi.registerMarkdownTransformer((markdown, context) => {
		// 仅在 TUI 中生效；print/json 等模式保持原样。
		if (!ui) return markdown;
		if (context.messageType === "assistant") {
			return FEATURES.headingRewrite ? rewriteDeepHeadings(markdown, ui.theme) : markdown;
		}
		if (context.messageType !== "user" || !FEATURES.userMessage) return markdown;
		// 重新套用一次：pi 切换主题后 Theme 实例会变，这里保证仍是黄字无背景。
		applyUserMessageTheme(ui);
		return transformUserMarkdown(markdown);
	});
}

