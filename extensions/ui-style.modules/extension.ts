/**
 * ui-style —— pi 界面样式自定义（合并版入口）
 *
 * 一个扩展收纳整套 UI 定制，按分区放在 ./ui-style.modules/ 下；顶部 core.ts 的
 * FEATURES 开关可单独启停每个功能块（比 settings.json 按文件排除更细）：
 *
 *   ┌ assistant.ts    助手消息：\uE22C 悬挂缩进 + 去背景 + 思考块折叠预览（原型补丁）
 *   ├ user-message.ts 用户消息：黄色加粗 + \uE370 图标（theme token 覆盖 + markdown 变换）
 *   │                 + 整体左移一列（USER_PAD_SHIFT）；h3~h6 标题改写也在这里
 *   ├ editor.ts       圆角输入框 + ❯/⌘/» 输入符号 + 工作中呼吸动画
 *   ├ infobar.ts      输入框上方信息条：tokens/速度/首字延迟/耗时
 *   ├ statusline.ts   输入框下方状态栏：模型(供应商)/缓存/费用/▣□ 上下文色条
 *   ├ info-panel.ts  会话信息面板（`alt+i`）：模型/思考/会话名可改 + 时长/目录 + 已加载技能/扩展/MCP
 *   ├ session-stats.ts 会话统计口径（状态栏与信息面板共用）
 *   ├ startup.ts      启动页：logo + 上下文/技能/扩展资源清单（异步扫描）
 *   ├ skill-banner.ts 技能调用横幅：无背景 + 预览样式（原型补丁）
 *   ├ bash-exec.ts    `!` 内联命令：绿色圆角边框整块包裹（原型补丁）
 *   └ panels.ts       工具面板：bash/codemode/read/write/edit/grep/find/ls/powershell
 *
 * 各面板统一视觉：Nerd Font 图标 + 着色工具名 + ⎿ 连接的折叠预览（ctrl+o 展开）、
 * 无状态背景色、块左边缘与助手图标同列（0）。仅显示层，不影响会话内容。
 *
 * 块计时（重要，勿改回定时器方案）：思考块、工具面板、`!` 内联命令共用
 * 一套 BlockClock——只存 startedAt/endedAt，耗时在每次 render 时现算，块本身
 * 不持有任何 setInterval。驱动它的是 pi 本来就在跑的帧：agent 运行期间
 * working spinner（80ms）、统一节拍 tick（ANIMATION_TICK_MS）、bash 有输出时 pi 推送的
 * partial result、`!` 命令自带 loader 的动画帧。早期版本用 100ms 定时器调
 * invalidate() 刷数字，代价是每次都要 updateDisplay() 重建组件树 +
 * requestRender 全量重渲染整个 transcript（pi 的 ScrollView 无视口裁剪），
 * 长会话下明显卡顿；且 pi 在 agent_start / agent_end / renderCurrentSessionState
 * 处只清 pendingTools、不再回调 renderResult，定时器永远等不到 stopTimer，
 * 越用越卡。
 *
 * 计时口径（各块一致）：从块出现算到结束。工具块从参数开始流式就计时——
 * read/write/edit 的真实执行只有几毫秒到几十毫秒（实测 2~60ms），远小于一帧
 * （pi 渲染节流 16ms），若只在执行阶段计时，根本来不及上屏，只会在结束时
 * 突然蹦出一个 "17ms"。代价是 write/edit 大文件时耗时会包含模型生成参数的
 * 时间。历史块没有本地时间戳（思考块用 unknown、工具块用持久化的
 * toolResult.durationMs），仍然显示或干脆不显示，不会伪造 0.0s；<1s 的
 * 耗时用毫秒（一位小数会把 17ms 显示成 0.0s）。
 *
 * 安装：<agent-dir>/extensions/ui-style.ts（真正的实现在同目录的
 * ui-style.modules/ 下，那个目录没有 index.ts/package.json，pi 不会把它当成
 * 第二个扩展加载），然后 /reload 或重启 pi。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FEATURES } from "./core.ts";
import {
	patchAssistantMessageStyle,
	resetThinkingTimings,
	unpatchAssistantMessageStyle,
} from "./assistant.ts";
import { registerToolRenderers } from "./panels.ts";
import { patchSkillBanner, unpatchSkillBanner } from "./skill-banner.ts";
import { patchBashExec, unpatchBashExec } from "./bash-exec.ts";
import {
	patchUserMessagePad,
	setupMarkdownTransforms,
	unpatchUserMessagePad,
} from "./user-message.ts";
import { setupRoundedEditor } from "./editor.ts";
import { setupInfoBar } from "./infobar.ts";
import { setupStatusline } from "./statusline.ts";
import { setupStartupHeader } from "./startup.ts";
import { setupJumpToReplyStart } from "./reading.ts";
import { setupSessionInfoPanel } from "./info-panel.ts";

/**
 * 原型补丁的注册套路（助手消息 / 技能横幅 / `!` 命令 / 用户消息共用）：
 *
 * 加载时先打一次补丁；`session_shutdown`（new / resume / fork / reload 都会触发）
 * 恢复原型——否则旧模块的闭包会一直被原型引用，既改不动行为也无法回收；
 * 每次 `session_start` 再重打一次（补丁内部幂等：先恢复再打）。
 */
function withPrototypePatch(
	pi: ExtensionAPI,
	patch: () => void,
	unpatch: () => void,
	onShutdown?: () => void,
): void {
	// 工厂期就要上补丁（助手消息补丁必须最先，保证后续渲染走新逻辑）。
	patch();
	pi.on("session_start", () => {
		patch();
	});
	pi.on("session_shutdown", () => {
		unpatch();
		onShutdown?.();
	});
}

export default function (pi: ExtensionAPI): void {
	if (FEATURES.assistantStyle) {
		withPrototypePatch(
			pi,
			patchAssistantMessageStyle,
			unpatchAssistantMessageStyle,
			resetThinkingTimings,
		);
	}
	if (FEATURES.skillBanner) withPrototypePatch(pi, patchSkillBanner, unpatchSkillBanner);
	if (FEATURES.bashExecBox) withPrototypePatch(pi, patchBashExec, unpatchBashExec);

	if (FEATURES.toolPanels) registerToolRenderers(pi);
	if (FEATURES.userMessage) {
		withPrototypePatch(pi, patchUserMessagePad, unpatchUserMessagePad);
	}
	if (FEATURES.userMessage || FEATURES.headingRewrite) setupMarkdownTransforms(pi);
	if (FEATURES.roundedEditor) setupRoundedEditor(pi);
	if (FEATURES.infoBar) setupInfoBar(pi);
	if (FEATURES.statusline) setupStatusline(pi);
	if (FEATURES.startupHeader) setupStartupHeader(pi);
	if (FEATURES.jumpToReplyStart) setupJumpToReplyStart(pi);
	if (FEATURES.sessionInfoPanel) setupSessionInfoPanel(pi);
}
