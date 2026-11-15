/**
 * 纯函数单测（不依赖 pi 的运行时状态，只需要 core.ts 的导出）。
 *
 * 运行：bash tests/run.sh
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// keyHint() 会读全局主题（pi 进程里本来就已经初始化），测试里补一下。
initTheme("dark");
import {
	cleanText,
	clockElapsedMs,
	collapsePreviewLines,
	execClockText,
	formatDuration,
	formatIndentedPreview,
	formatPanelDuration,
	formatTokens,
	hasVisibleText,
	headLinesOfTexts,
	moreLinesNoun,
	mixRgb,
	promptTokens,
	shimmerFrame,
	shimmerPosition,
	shimmerText,
	shortenTail,
	shortenHome,
	stripAnsi,
	stripBom,
	tailLines,
	tailVisualRows,
	summarizePath,
	touchClock,
	trimZero,
	formatCwd,
	shortenPathLine,
	ExtensionStatusText,
} from "../core.ts";
import {
	buildSessionInfoRows,
	cursorAtColumn,
	framePanel,
	modelLabel,
	panelInnerWidth,
	clampScroll,
	exactTokens,
	panelViewport,
	tokenCell,
} from "../info-panel.ts";
import { computeSessionStats } from "../session-stats.ts";
import { renderContextBar, levelOf } from "../context-bar.ts";
import { supportedThinkingLevels } from "../levels.ts";
import { stripBackgroundSgr } from "../assistant.ts";

/** 只做“不改变文本”的 theme 替身，方便断言纯文本行为。 */
const plainTheme = {
	fg: (_token: string, text: string): string => text,
};

test("formatDuration：秒/分/时三档", () => {
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(0), "0.0s");
	assert.equal(formatDuration(60_000), "1 m 0 s");
	assert.equal(formatDuration(168_000), "2 m 48 s");
	assert.equal(formatDuration(3_723_000), "1 h 2 m 3 s");
});

test("formatPanelDuration：不足 1 秒用毫秒（17ms 不能显示成 0.0s）", () => {
	assert.equal(formatPanelDuration(17), "17ms");
	assert.equal(formatPanelDuration(999), "999ms");
	assert.equal(formatPanelDuration(1000), "1.0s");
	assert.equal(formatPanelDuration(-5), "0ms");
});

test("trimZero / formatTokens 缩写", () => {
	assert.equal(trimZero("1.0M"), "1M");
	assert.equal(trimZero("2.5k"), "2.5k");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(12_345), "12k");
	assert.equal(formatTokens(1_234_567), "1.2M");
	assert.equal(formatTokens(10_000_000), "10M");
});

test("stripAnsi / cleanText / hasVisibleText", () => {
	assert.equal(stripAnsi("\x1b[38;2;1;2;3mred\x1b[39m"), "red");
	assert.equal(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07"), "link");
	assert.equal(cleanText("a\r\nb\tc\u0007"), "a\nb    c");
	assert.equal(hasVisibleText("   "), false);
	assert.equal(hasVisibleText("\x1b[31m  \x1b[39m"), false);
	assert.equal(hasVisibleText("\x1b[31mx\x1b[39m"), true);
});

test("stripBom", () => {
	assert.equal(stripBom("\uFEFF{}"), "{}");
	assert.equal(stripBom("{}"), "{}");
	assert.equal(stripBom(""), "");
});

test("shortenHome：home 边界不能被误缩写", () => {
	const home = homedir();
	if (!home) return;
	assert.equal(shortenHome(home), "~");
	assert.equal(shortenHome(`${home}/a/b`), "~/a/b");
	// home 前缀但下一字符不是分隔符：保持原样
	assert.equal(shortenHome(`${home}2x`), `${home}2x`);
});

test("shortenTail：ASCII 快路径与宽字符都收在宽度内", () => {
	assert.equal(shortenTail("abcdefghij", 5), "…ghij");
	assert.equal(shortenTail("abc", 5), "abc");
	assert.equal(shortenTail("abc", 0), "");
	const cjk = shortenTail("这是一个很长的中文路径", 6);
	assert.ok(cjk.startsWith("…"));
	assert.ok(visibleWidth(cjk) <= 6);
	assert.ok(cjk.endsWith("路径"));
});

test("summarizePath：放不下时保留末尾几段", () => {
	const long = "/home/user/projects/app/src/components/video.tsx";
	const out = summarizePath(long, 20);
	assert.ok(out.length <= 20);
	assert.ok(out.endsWith("video.tsx"));
	assert.ok(summarizePath("/a/b.ts", 40) === "/a/b.ts");
});

test("headLinesOfTexts：只留头部行但总数算全", () => {
	const source = headLinesOfTexts(["a\nb", "c"], 2);
	assert.deepEqual(source.head, ["a", "b"]);
	assert.equal(source.total, 4); // a / b / 分隔空行 / c
});

test("collapsePreviewLines：折叠态按源行数计剩余", () => {
	const array = collapsePreviewLines(["1", "2", "3", "4"], 2, 40, (line) => line);
	assert.deepEqual(array.lines, ["1", "2"]);
	assert.equal(array.remaining, 2);

	// 尾部空行不计数
	const trailing = collapsePreviewLines(["1", "2", "", "  "], 2, 40, (line) => line);
	assert.deepEqual(trailing.lines, ["1", "2"]);
	assert.equal(trailing.remaining, 0);

	// 单行被换行拆开时，这一行也算未显示
	const wrapped = collapsePreviewLines(["x".repeat(30)], 2, 10, (line) => line);
	assert.equal(wrapped.lines.length, 2);
	assert.equal(wrapped.remaining, 1);

	// 全部放得下
	assert.deepEqual(collapsePreviewLines(["1"], 2, 40, (line) => line), {
		lines: ["1"],
		remaining: 0,
	});
});

test("moreLinesNoun 单复数", () => {
	assert.equal(moreLinesNoun(1), "line");
	assert.equal(moreLinesNoun(2), "lines");
});

test("formatIndentedPreview：空/错误/展开/折叠四种形态", () => {
	const empty = formatIndentedPreview([""], false, false, plainTheme, 40);
	assert.deepEqual(empty, ["  ⎿  (无输出)"]);

	const failed = formatIndentedPreview(["  "], false, true, plainTheme, 40);
	assert.deepEqual(failed, ["  ⎿  执行失败"]);

	const expanded = formatIndentedPreview(["a", "b", "c"], true, false, plainTheme, 40);
	assert.deepEqual(expanded, ["  ⎿  a", "     b", "     c"]);

	const folded = formatIndentedPreview(["a", "b", "c"], false, false, plainTheme, 60);
	assert.equal(folded[0], "  ⎿  a");
	assert.equal(folded[1], "     b");
	assert.match(folded[2] ?? "", /\.\.\. \(1 more line, .*to expand.*\)/);
});

test("BlockClock：开始幂等、结束定格", () => {
	const clock = {};
	touchClock(clock, true, 1000);
	touchClock(clock, true, 1500);
	assert.equal(clockElapsedMs(clock, 2000), 1000);
	touchClock(clock, false, 3000);
	touchClock(clock, false, 4000);
	assert.equal(clockElapsedMs(clock, 5000), 2000);
	assert.equal(clockElapsedMs({}), undefined);
});

test("execClockText：回放时的一帧耗时不当成真实耗时", () => {
	assert.equal(execClockText(undefined), undefined);
	assert.equal(execClockText({}), undefined);
	// 回放：构造即完成，只跨几毫秒
	assert.equal(execClockText({ startedAt: 1000, endedAt: 1003 }), undefined);
	// 真实命令
	assert.equal(execClockText({ startedAt: 1000, endedAt: 1612 }), "612ms");
	// 运行中：正在计时的块要出数字（用固定偏移量避开毫秒抖动）
	assert.match(execClockText({ startedAt: Date.now() - 40 }), /^\d{1,3}ms$/);
});

test("promptTokens：input + 缓存读写", () => {
	assert.equal(promptTokens(undefined), 0);
	assert.equal(promptTokens({ input: 10, cacheRead: 5, cacheWrite: 1, output: 99 }), 16);
});

test("mixRgb：按比例混合并钳制越界值", () => {
	assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 0), [0, 0, 0]);
	assert.deepEqual(mixRgb([0, 0, 0], [255, 255, 255], 1), [255, 255, 255]);
	assert.deepEqual(mixRgb([0, 0, 0], [100, 100, 100], 0.5), [50, 50, 50]);
	assert.deepEqual(mixRgb([10, 10, 10], [20, 20, 20], 5), [20, 20, 20]);
	assert.deepEqual(mixRgb([10, 10, 10], [20, 20, 20], -5), [10, 10, 10]);
});

test("shimmerPosition：三角波左右往返（0 → 1 → 0）", () => {
	const base = 1_000;
	assert.equal(shimmerPosition(base, base), 0);
	assert.equal(shimmerPosition(base, base + 350), 0.5);
	assert.equal(shimmerPosition(base, base + 700), 1);
	assert.equal(shimmerPosition(base, base + 1050), 0.5);
	assert.ok(Math.abs(shimmerPosition(base, base + 1400)) < 1e-9);
	// 时间倒流（理论上不该发生）也不能出现 NaN
	assert.ok(Number.isFinite(shimmerPosition(base, base - 100)));
});

test("shimmerFrame：相位粒度 40ms，无起点时为 0", () => {
	assert.equal(shimmerFrame(undefined), 0);
	assert.equal(shimmerFrame(1000, 1039), 0);
	assert.equal(shimmerFrame(1000, 1040), 1);
	assert.equal(shimmerFrame(1000, 1999), 24);
});

test("shimmerText：宽度不变、颜色随时间变化、无起点时退化成单色", () => {
	const base = [95, 135, 215] as const;
	const ansi = "\x1b[38;2;95;135;215m";
	const colors = (text) => [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];

	// 平色：只有一个前景色 + RESET，且文本原样
	const flat = shimmerText("Bash", base, undefined);
	assert.equal(visibleWidth(flat), 4);
	assert.equal(flat.replace(/\x1b\[[0-9;]*m/g, ""), "Bash");
	assert.equal(new Set(colors(flat).map((m) => m[0])).size, 1);
	assert.ok(flat.startsWith(ansi));

	// 扫光：中段位置时不同字符颜色不同，但可见宽度与纯文本一致
	const swept = shimmerText("Bash", base, 0, 350);
	assert.equal(visibleWidth(swept), 4);
	assert.equal(swept.replace(/\x1b\[[0-9;]*m/g, ""), "Bash");
	assert.ok(new Set(colors(swept).map((m) => m[0])).size > 1);
	// 结尾必须有前景复位，否则会污染后面的内容
	assert.ok(swept.endsWith("\x1b[39m"));

	// 相位一开始在最左：首字符比末字符亮
	const left = shimmerText("Bash", base, 0, 0);
	const leftColors = colors(left).map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
	const first = leftColors[0] ?? [0, 0, 0];
	const last = leftColors[leftColors.length - 1] ?? [0, 0, 0];
	assert.ok(first[0]! + first[1]! + first[2]! > last[0]! + last[1]! + last[2]!);

	// CJK 也不改变宽度（每个字 2 列）
	const cjk = shimmerText("思考中", base, 0, 500);
	assert.equal(visibleWidth(cjk), visibleWidth("思考中"));
});

test("tailLines：取尾部行，O(窗口)，并报告上面是否还有内容", () => {
	assert.deepEqual(tailLines("a\nb\nc", 2), { lines: ["b", "c"], more: true });
	assert.deepEqual(tailLines("a\nb\n", 2), { lines: ["a", "b"], more: false });
	assert.deepEqual(tailLines("只有一行", 3), { lines: ["只有一行"], more: false });
	assert.deepEqual(tailLines("", 3), { lines: [], more: false });
	assert.deepEqual(tailLines("a\nb", 0), { lines: [], more: true });
	// Windows 换行
	assert.deepEqual(tailLines("a\r\nb\r\n", 5), { lines: ["a", "b"], more: false });
	// 长文本只取尾部（不 split 全文）
	const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
	const tail = tailLines(long, 3);
	assert.deepEqual(tail.lines, ["line 4997", "line 4998", "line 4999"]);
	assert.equal(tail.more, true);
});


test("tailVisualRows：按可视行封顶（长段落不会把窗口撑爆）", () => {
	// 一整段 3000 字、没有换行 → 折行后只取最后 6 行
	const long = "很长的思考内容，".repeat(375);
	const tail = tailVisualRows(long, 6, 40);
	assert.equal(tail.rows.length, 6, `应恰好 6 行，实际 ${tail.rows.length}`);
	assert.equal(tail.more, true);
	for (const row of tail.rows) assert.ok(visibleWidth(row) <= 40, `行宽超限：${visibleWidth(row)}`);
	// 尾部内容对得上
	assert.ok(tail.rows[tail.rows.length - 1]?.includes("内容"));

	// 多行文本：窗口不超过 rows
	const multi = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
	const tail2 = tailVisualRows(multi, 5, 40);
	assert.deepEqual(tail2.rows, ["line 46", "line 47", "line 48", "line 49", "line 50"]);
	assert.equal(tail2.more, true);

	// 内容比窗口短：全显示、more=false
	const short = tailVisualRows("a\nb", 5, 40);
	assert.deepEqual(short.rows, ["a", "b"]);
	assert.equal(short.more, false);

	assert.deepEqual(tailVisualRows("", 5, 40), { rows: [], more: false });
});


test("formatCwd / shortenPathLine：home 缩写、统一斜杠、超长从左边砍", () => {
	const home = homedir();
	assert.equal(formatCwd(`${home}/proj/demo`), "~/proj/demo");
	assert.equal(formatCwd("/opt/x"), "/opt/x");
	assert.equal(shortenPathLine("~/proj/demo", 40), "~/proj/demo");
	const long = "~/a/b/c/proj/demo";
	const cut = shortenPathLine(long, 12);
	assert.ok(visibleWidth(cut) <= 12, cut);
	assert.ok(cut.endsWith("demo"), cut);
	assert.equal(shortenPathLine("~/proj/demo", 0), "");
});

test("computeSessionStats：token/费用/缓存命中率/轮次/累计用时", () => {
	const usage = { input: 100, output: 50, cacheRead: 300, cacheWrite: 0, cost: { total: 0.1 } };
	const entries = [
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", usage } },
		{ type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "toolResult", usage: { input: 10, output: 0 } } },
		{ type: "message", timestamp: "2026-01-01T00:09:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:10:00.000Z", message: { role: "assistant", usage } },
	];
	const stats = computeSessionStats(entries, Date.parse("2026-01-01T00:10:00.000Z"));

	assert.equal(stats.inputTokens, 210);
	assert.equal(stats.outputTokens, 100);
	assert.equal(stats.cacheReadTokens, 600);
	assert.equal(stats.promptTokens, 210 + 600);
	assert.equal(stats.totalTokens, 910);
	assert.equal(stats.messageCount, 3);
	assert.equal(stats.turnCount, 2);
	assert.ok(Math.abs(stats.cost - 0.2) < 1e-9, `cost=${stats.cost}`);
	assert.equal(stats.hasCache, true);
	assert.ok(Math.abs((stats.cacheHitRate ?? 0) - (600 / 810) * 100) < 1e-6);
	// 第 1 轮：60s（到最后一个条目）；第 2 轮：60s
	assert.equal(stats.activeMs, 120_000);
	assert.equal(stats.wallMs, 10 * 60_000);
});

test("computeSessionStats：没有缓存读写时命中率为 undefined（不误报 0%）", () => {
	const stats = computeSessionStats([
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", usage: { input: 10, output: 5 } } },
	]);
	assert.equal(stats.hasCache, false);
	assert.equal(stats.cacheHitRate, undefined);
	assert.equal(stats.totalTokens, 15);
});

test("computeSessionStats：末轮只在最近 2 分钟内补增长（离开去泡咖啡不算用时）", () => {
	const entries = [
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant" } },
	];
	// 距最后条目 110s（≤120s）：当作还在生成，补上
	const live = computeSessionStats(entries, Date.parse("2026-01-01T00:02:00.000Z"));
	assert.equal(live.activeMs, 10_000 + 110_000);
	// 早就过去了：这一轮已经结束，不补
	const idle = computeSessionStats(entries, Date.parse("2026-01-01T03:00:00.000Z"));
	assert.equal(idle.activeMs, 10_000);
});

test("exactTokens / tokenCell：千分位 + 缩写", () => {
	assert.equal(exactTokens(3287), "3,287");
	assert.equal(exactTokens(13620), "13,620");
	assert.equal(tokenCell(3287), "3.3k (3,287)");
	assert.equal(tokenCell(0), "0 (0)");
});

test("renderContextBar：格子数正确、档位阈值一致（状态栏与面板共用）", () => {
	assert.equal(levelOf(50), "ok");
	assert.equal(levelOf(80), "warn");
	assert.equal(levelOf(81), "bad");
	assert.equal(levelOf(undefined), "ok");
	assert.equal(renderContextBar(50, 0), "");
	assert.equal(visibleWidth(renderContextBar(50, 10)), 10);
	assert.equal(visibleWidth(renderContextBar(undefined, 6)), 6);
	// 两种字形都支持：box（状态栏 ▣□）与 block（信息面板 █░）
	const half = renderContextBar(50, 10, "block");
	assert.equal((half.match(/\u2588/g) ?? []).length, 5);
	const box = renderContextBar(50, 10);
	assert.equal((box.match(/\u25A3/g) ?? []).length, 5);
	assert.equal(visibleWidth(box), 10);
});

test("panelViewport / clampScroll：窗口按终端行数封顶，滚动不越界", () => {
	assert.equal(panelViewport(40, 10), 10);
	assert.equal(panelViewport(40, 100), 37);
	assert.equal(panelViewport(6, 100), 5);
	assert.equal(clampScroll(-5, 20, 10), 0);
	assert.equal(clampScroll(999, 20, 10), 10);
	assert.equal(clampScroll(3, 5, 10), 0);
});

test("buildSessionInfoRows：窄宽度下不超宽，长会话名被截断", () => {
	const model = { id: "very-long-model-name-here", provider: "some-provider", contextWindow: 200000, reasoning: true };
	const view = {
		model,
		thought: "xhigh",
		models: [model],
		modelIndex: 0,
		levelIndex: 1,
		sessionName: "一个很长很长的会话名字用来测试截断行为",
		cwd: "/home/somewhere/very/deep/path/to/project",
		sessionId: "01JC-0000000000",
		contextTokens: 12345,
		contextWindow: 200000,
		contextPercent: 6.2,
		stats: {
			cost: 1.234,
			cacheHitRate: 92.5,
			hasCache: true,
			totalTokens: 99999,
			promptTokens: 90000,
			inputTokens: 4000,
			outputTokens: 2000,
			cacheReadTokens: 93000,
			cacheWriteTokens: 999,
			messageCount: 12,
			turnCount: 6,
			activeMs: 5_000,
			wallMs: 60_000,
		},
		entryCount: 12,
		streaming: true,
	};
	for (const width of [24, 40, 72, 120]) {
		const lines = buildSessionInfoRows(view, plainTheme, width).map((row) => row.text);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width=${width} 超宽：${visibleWidth(line)}\n${stripAnsi(line)}`);
		}
	}
	const wide = buildSessionInfoRows(view, plainTheme, 100).map((row) => stripAnsi(row.text)).join("\n");
	assert.ok(wide.includes("xhigh"), wide);
	assert.ok(wide.includes("6.2%"), wide);
	assert.ok(wide.includes("生成中"), wide);
});

test("supportedThinkingLevels / modelLabel：档位过滤与显示名", () => {
	assert.deepEqual(supportedThinkingLevels({ id: "m", provider: "p", reasoning: false }), ["off"]);
	assert.deepEqual(supportedThinkingLevels(undefined), ["off"]);
	assert.deepEqual(supportedThinkingLevels({ id: "m", provider: "p", reasoning: true }), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
	assert.deepEqual(
		supportedThinkingLevels({
			id: "m",
			provider: "p",
			reasoning: true,
			thinkingLevelMap: { low: null, xhigh: "high", max: "high" },
		}),
		["off", "minimal", "medium", "high", "xhigh", "max"],
	);
	assert.equal(modelLabel({ id: "x", provider: "y" }), "x (y)");
	assert.equal(modelLabel(undefined), "no-model");
});

test("framePanel：边框与所有行等宽，过长的行被截断", () => {
	const rows = [
		{ text: "短" },
		{ text: "x".repeat(500) },
		{ text: "", field: "name" as const },
	];
	for (const inner of [20, 42, 74]) {
		const lines = framePanel(rows, inner, "会话信息", "↑↓ 选择 · Esc 关闭", 3, 0);
		assert.equal(lines.length, 5, "内容 3 行 → 上下边框各 1 行");
		for (const line of lines) {
			assert.equal(visibleWidth(line), inner + 4, `宽度不一致：${visibleWidth(line)}`);
		}
	}
});

test("panelInnerWidth：夹在上下限之间，且受终端宽度约束", () => {
	assert.equal(panelInnerWidth(10, 120), 54);
	assert.equal(panelInnerWidth(1000, 120), 74);
	assert.equal(panelInnerWidth(1000, 64), 56);
});

test("cursorAtColumn：点击列换算成字符下标（含宽字符）", () => {
	const ascii = Array.from("abcdef");
	// column = 点击处左侧有多少列 → 光标下标
	assert.equal(cursorAtColumn(ascii, 0), 0);
	assert.equal(cursorAtColumn(ascii, 1), 1);
	assert.equal(cursorAtColumn(ascii, 2), 2);
	assert.equal(cursorAtColumn(ascii, 99), 6);
	// 中文每个字两列
	const cjk = Array.from("会话名");
	assert.equal(cursorAtColumn(cjk, 1), 0);
	assert.equal(cursorAtColumn(cjk, 2), 1);
	assert.equal(cursorAtColumn(cjk, 4), 2);
	assert.equal(cursorAtColumn(cjk, 6), 3);
});

test("buildSessionInfoRows：下拉行插在字段行之后并带标记", () => {
	const model = { id: "m", provider: "p", reasoning: true };
	const view = {
		model,
		thought: "high",
		models: [model, { id: "n", provider: "p", reasoning: true }],
		modelIndex: 0,
		levelIndex: 0,
		sessionName: "s",
		cwd: "/tmp",
		sessionId: "id",
		contextTokens: 1,
		contextWindow: 2,
		contextPercent: 50,
		stats: {
			cost: 0,
			cacheHitRate: undefined,
			hasCache: false,
			totalTokens: 0,
			promptTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			messageCount: 0,
			turnCount: 0,
			activeMs: 0,
			wallMs: 0,
		},
		entryCount: 0,
		streaming: false,
	};
	const rows = buildSessionInfoRows(view, plainTheme, 60, {
		dropdown: { after: "model", lines: ["DROP-1", "DROP-2"] },
	});
	const modelRow = rows.findIndex((row) => row.field === "model");
	assert.equal(rows[modelRow + 1]?.text, "DROP-1");
	assert.equal(rows[modelRow + 1]?.dropdown, true);
	assert.equal(rows[modelRow + 2]?.text, "DROP-2");
	assert.equal(rows[modelRow + 3]?.field, "thinking", "下拉之后应回到下一个字段行");

	// 箭头列：在值之后、行尾之前
	const arrows = rows[modelRow]?.arrowsCol;
	assert.ok(typeof arrows === "number" && arrows > 0, "模型行应有箭头列");
});

test("buildSessionInfoRows：只有一项可选时不画箭头", () => {
	const model = { id: "m", provider: "p", reasoning: false };
	const view = {
		model,
		thought: "off",
		models: [model],
		modelIndex: 0,
		levelIndex: 0,
		sessionName: "s",
		cwd: "/tmp",
		sessionId: "id",
		contextTokens: 1,
		contextWindow: 2,
		contextPercent: 50,
		stats: {
			cost: 0,
			cacheHitRate: undefined,
			hasCache: false,
			totalTokens: 0,
			promptTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			messageCount: 0,
			turnCount: 0,
			activeMs: 0,
			wallMs: 0,
		},
		entryCount: 0,
		streaming: false,
	};
	const rows = buildSessionInfoRows(view, plainTheme, 60);
	for (const row of rows) {
		assert.equal(row.arrowsCol, undefined, "无可选项时不应有箭头");
	}
});

test("#2 LiveTailView：等长但内容不同的文本必须重绘", async () => {
	const { LiveTailView } = await import("../core.ts");
	let text = "aaaa\nbbbb";
	const view = new LiveTailView(
		{ text: () => text, finished: () => false },
		plainTheme,
		{ maxLines: 2 },
	);
	const first = view.render(40);
	text = "cccc\ndddd"; // 长度完全相同
	const second = view.render(40);
	assert.notDeepEqual(second, first, "长度相同但内容变化时必须重绘");
	assert.ok(stripAnsi(second.join("\n")).includes("cccc"), second.join("\n"));
});

test("#2 LiveTailView：内容完全相同时仍然命中缓存", async () => {
	const { LiveTailView } = await import("../core.ts");
	const text = "same\ncontent";
	const view = new LiveTailView(
		{ text: () => text, finished: () => false },
		plainTheme,
		{ maxLines: 2 },
	);
	const first = view.render(40);
	const second = view.render(40);
	assert.deepEqual(second, first);
});

test("#4 collapsePreviewLines：PreviewSource 的尾部空行不算剩余行数", () => {
	const source = headLinesOfTexts(["line1\nline2\nline3\n\n\n"], 10);
	const fromSource = collapsePreviewLines(source, 1, 80, (line) => line);
	const fromArray = collapsePreviewLines(["line1", "line2", "line3", "", ""], 1, 80, (l) => l);
	assert.equal(fromSource.remaining, 2, "应为 2 而不是 4");
	assert.equal(fromSource.remaining, fromArray.remaining);
});

test("#5 stripBackgroundSgr：47 / 100 / 48;2 与非法 mode", () => {
	const cases = [
		// 普通背景色被剥掉，前景保留
		["\x1b[47mtext\x1b[49m", "\x1b[47m"],
		["\x1b[100mtext\x1b[49m", "\x1b[100m"],
		["\x1b[48;2;1;2;3mtext\x1b[49m", "\x1b[48;2;1;2;3m"],
	];
	for (const [input, stripped] of cases) {
		const out = stripBackgroundSgr(input);
		assert.ok(!out.includes(stripped), `应剥掉 ${JSON.stringify(stripped)}：${JSON.stringify(out)}`);
	}
	// 非法 mode：无法安全解析 → 整段原样保留（以前 48 会丢掉尾部、把前景参数吞掉）
	const illegal = stripBackgroundSgr("\x1b[48;9;31mred");
	assert.ok(illegal.includes("48;9;31"), `整段应保留：${JSON.stringify(illegal)}`);
	// 同一条 SGR 里前面已剥过背景、尾部是非法 mode 时，尾部参数也不能丢
	const mixed = stripBackgroundSgr("\x1b[41;48;9;31mred");
	assert.ok(mixed.includes("31"), `foreground 31 必须保留：${JSON.stringify(mixed)}`);
	assert.ok(!/\[41m|;41/.test(mixed), `背景 41 仍应剥掉：${JSON.stringify(mixed)}`);
});

test("#1 ExtensionStatusText：插入序≠字母序时第二次调用命中缓存", () => {
	const cache = new ExtensionStatusText();
	const statuses = new Map([
		["zebra", "Z"],
		["alpha", "A"],
	]);
	assert.equal(cache.update(statuses), "A Z");
	assert.equal(cache.updates, 1);
	assert.equal(cache.update(statuses), "A Z");
	assert.equal(cache.updates, 1, "内容没变不应重算");

	// 值变了才重算
	statuses.set("zebra", "ZZ");
	assert.equal(cache.update(statuses), "A ZZ");
	assert.equal(cache.updates, 2);

	// 换一个新 Map（同内容、同插入序）也应命中
	const same = new Map([
		["zebra", "ZZ"],
		["alpha", "A"],
	]);
	assert.equal(cache.update(same), "A ZZ");
	assert.equal(cache.updates, 2, "换个 Map 但内容与插入序相同不应重算");

	// 插入序变了会重算一次（pi 的 getExtensionStatuses() 返回同一个 Map，
	// 插入序稳定；为省掉每帧排序，这里不做顺序无关比较）
	const reordered = new Map([
		["alpha", "A"],
		["zebra", "ZZ"],
	]);
	assert.equal(cache.update(reordered), "A ZZ");
	assert.equal(cache.updates, 3);
});
