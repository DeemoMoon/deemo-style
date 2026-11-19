/**
 * 十三、阅读辅助：整轮结束后把视口带回回复开头
 *
 * 问题：高速模型两秒就能刷满几屏。pi 的 alt-screen 默认"跟随底部"
 * （`isFollowingOutput`），所以生成完你就停在末尾，得手动翻回去从头读。
 *
 * 做法（只在整轮结束 `agent_settled` 时动一次）：
 *   1. 只在"仍在跟随底部"时动手——用户自己在翻历史就不打扰；
 *   2. 只在回复超过视口约 70% 时动手——短回复停在末尾就行；
 *   3. 用 pi 自己的 `scrollToPrompt(-1)`（按 OSC133;A 行首标记找落点）跳到
 *      这条回复的第一行。目标行在底部之上 → pi 的 `followingEnd` 自动变 false，
 *      不会立刻把视口拉回末尾；想回到末尾按 `Ctrl+End` 即可。
 *
 * 只在 fullscreen 模式有效（regular 模式没有 scroll view，自动跳过）。
 * 关掉：`FEATURES.jumpToReplyStart = false`。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { FEATURES } from "./core.ts";
import { lastAssistantRenderLines } from "./assistant.ts";

/** 我们占用一个 widget key，只为了拿到 TUI 引用。 */
const WIDGET_KEY = "ui-style-scroll-bridge";

/** 0 行的组件：不占屏幕，只当"拿 TUI 引用"的钩子。 */
const EMPTY_VIEW: Component = {
	render: () => [],
	invalidate: () => {},
};

/** pi 的 alt-screen 上我们用到的那几个成员（部分在 TS 里是 private，运行时可用）。 */
interface ScrollBridge {
	isFollowingOutput?: boolean;
	scrollToPrompt?: (direction: number) => void;
	getPrimaryScrollView?: () => { readonly viewportHeight?: number } | undefined;
}

let sharedTui: TUI | undefined;

/**
 * 要不要"跳回回复开头"（纯函数，方便测试）。
 *
 * - 用户不在跟随底部（自己在翻历史）→ 不动；
 * - 回复不到视口 70% → 不动（否则会白跳一两次）；
 * - 取不到视口高度时用固定阈值 20 行兜底。
 */
export function shouldJumpToReplyStart(input: {
	following: boolean;
	viewportHeight: number;
	renderedLines: number;
}): boolean {
	if (!input.following) return false;
	if (input.renderedLines <= 0) return false;
	const need =
		input.viewportHeight > 0 ? Math.max(8, Math.floor(input.viewportHeight * 0.7)) : 20;
	return input.renderedLines >= need;
}

/** 视口高度（取不到就返回 0，由 shouldJumpToReplyStart 走兜底阈值）。 */
function viewportHeightOf(bridge: ScrollBridge): number {
	try {
		const height = bridge.getPrimaryScrollView?.()?.viewportHeight;
		return typeof height === "number" && Number.isFinite(height) ? height : 0;
	} catch {
		return 0;
	}
}

export function setupJumpToReplyStart(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// 防御顺序变化：若 pi 改成先 start 后 shutdown（旧会话的 shutdown
		// 在新会话 start 之后才跑），shutdown 里清 sharedTui 会把新会话刚
		// 写入的引用清掉。所以重置放在 start 开头无条件做，shutdown 只管 widget。
		sharedTui = undefined;
		// 借一个 0 行的 widget 拿到 TUI 引用（不占任何屏幕高度）
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			sharedTui = tui;
			return EMPTY_VIEW;
		});
	});

	pi.on("agent_settled", () => {
		if (!FEATURES.jumpToReplyStart) return;
		const tui = sharedTui;
		if (!tui) return;
		const bridge = tui as unknown as ScrollBridge;
		// regular 模式没有 scroll view：没有 isFollowingOutput 就直接跳过
		if (typeof bridge.isFollowingOutput !== "boolean") return;
		if (typeof bridge.scrollToPrompt !== "function") return;
		if (
			!shouldJumpToReplyStart({
				following: bridge.isFollowingOutput,
				viewportHeight: viewportHeightOf(bridge),
				renderedLines: lastAssistantRenderLines(),
			})
		) {
			return;
		}
		try {
			// -1 = 往上找最近的 OSC133;A（就是这条回复的第一行）
			bridge.scrollToPrompt(-1);
		} catch {
			// pi 内部结构变了就静默放弃，不影响会话
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// 只清 widget，不清 sharedTui：见 session_start 里的顺序防御注释，
		// 避免旧会话的 shutdown 晚于新会话的 start 时误清新会话的 TUI 引用。
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
