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
	chromeLine,
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
	patchPrototypeSlots,
	promptTokens,
	shimmerFrame,
	shimmerPosition,
	SHIMMER_PERIOD_MS,
	shimmerText,
	shortenTail,
	shortenHome,
	stripHomePrefix,
	stripAnsi,
	stripBom,
	tailVisualRows,
	touchClock,
	trimZero,
	unpatchPrototypeSlots,
	formatCwd,
	shortenPathLine,
	BOLD_OFF,
	BOLD_ON,
	CHROME_PAD,
	ExtensionStatusText,
} from "../core.ts";
import {
	buildSessionInfoRows,
	cursorAtColumn,
	framePanel,
	modelLabel,
	panelInnerWidth,
	clampScroll,
	panelViewport,
} from "../info-panel.ts";
import { computeSessionStats } from "../session-stats.ts";
import {
	renderContextBar,
	levelOf,
	hitRateLevel,
	levelRgb,
	LEVEL_BAR_FILL,
} from "../context-bar.ts";
import {
	applyPreviewEdits,
	getPreviewInput,
	normalizeForFuzzyMatch,
	resolvePreviewPath,
} from "../edit-preview.ts";
import { replyStartScrollDirection } from "../reading.ts";
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
	// Windows 盘符根不能退化成 "C:"（否则整盘都会被当成 home）
	assert.equal(stripHomePrefix("C:\\Windows", "C:\\", true), "Windows");
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

test("formatIndentedPreview：优先使用调用方传入的 keyHint", () => {
	const out = formatIndentedPreview(["a", "b", "c", "d", "e"], false, false, plainTheme, 40, {
		keyHint: (binding, description) => `[${binding}:${description}]`,
	});
	const text = out.join("\n");
	assert.ok(text.includes("[app.tools.expand:to expand]"), text);
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
	// 周期从常量取，调速度不会让用例失效
	const period = SHIMMER_PERIOD_MS;
	assert.equal(shimmerPosition(base, base), 0);
	assert.ok(Math.abs(shimmerPosition(base, base + period / 4) - 0.5) < 1e-9);
	assert.ok(Math.abs(shimmerPosition(base, base + period / 2) - 1) < 1e-9);
	assert.ok(Math.abs(shimmerPosition(base, base + (period * 3) / 4) - 0.5) < 1e-9);
	assert.ok(Math.abs(shimmerPosition(base, base + period)) < 1e-9);
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

test("computeSessionStats：assistant 收尾后不补尾；user/toolResult 收尾才补", () => {
	const finished = [
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant" } },
	];
	// 最后一条是 assistant：本轮已给出答案，读屏/离开的时间不能算进 activeMs。
	const idle = computeSessionStats(finished, Date.parse("2026-01-01T00:02:00.000Z"));
	assert.equal(idle.activeMs, 10_000);

	// 最后一条是 toolResult：agent 还在跑，距现在 110s（≤120s）时补上。
	const running = [...finished, {
		type: "message",
		timestamp: "2026-01-01T00:00:20.000Z",
		message: { role: "toolResult" },
	}];
	const live = computeSessionStats(running, Date.parse("2026-01-01T00:02:10.000Z"));
	assert.equal(live.activeMs, 20_000 + 110_000);
});

test("renderContextBar：格子数正确、档位阈值一致（状态栏与面板共用）", () => {
	assert.equal(levelOf(50), "ok");
	assert.equal(levelOf(80), "warn");
	assert.equal(levelOf(81), "bad");
	assert.equal(levelOf(undefined), "ok");
	assert.equal(renderContextBar(50, 0), "");
	assert.equal(visibleWidth(renderContextBar(50, 10)), 10);
	assert.equal(visibleWidth(renderContextBar(undefined, 6)), 6);
	// 只有一套字形（▣ 实心 / □ 空心）：生产里状态栏与信息面板共用
	const box = renderContextBar(50, 10);
	assert.equal((box.match(/\u25A3/g) ?? []).length, 5);
	assert.equal(visibleWidth(box), 10);
});

test("panelViewport / clampScroll：窗口按终端行数封顶，滚动不越界", () => {
	assert.equal(panelViewport(40, 10), 10);
	assert.equal(panelViewport(40, 100), 36);
	assert.equal(panelViewport(6, 100), 2);
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
		sessionName: "一个很长很长的会话名字用来测试截断行为",
		cwd: "/home/somewhere/very/deep/path/to/project",
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
			sessionAgeMs: 0,
			createdAt: 0,
		},
		entryCount: 12,
		resources: { skills: ["docx", "web-dev"], extensions: ["ui-style.ts"], mcp: ["filesystem"] },
	};
	for (const width of [24, 40, 72, 120]) {
		const lines = buildSessionInfoRows(view, plainTheme, width).map((row) => row.text);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width=${width} 超宽：${visibleWidth(line)}\n${stripAnsi(line)}`);
		}
	}
	const wide = buildSessionInfoRows(view, plainTheme, 100).map((row) => stripAnsi(row.text)).join("\n");
	assert.ok(wide.includes("xhigh"), wide);
	// 概览：创建（无 createdAt 时退回 wallMs → 1 m 0 s）+ 目录；加载区：技能/扩展/MCP
	assert.ok(wide.includes("1 m 0 s"), wide);
	assert.ok(wide.includes("创建"), wide);
	assert.ok(wide.includes("目录"), wide);
	assert.ok(wide.includes("加载"), wide);
	assert.ok(wide.includes("docx · web-dev"), wide);
	assert.ok(wide.includes("filesystem"), wide);
	// 用量/时间与位置已经退场：不再渲染 token/上下文/费用/会话 id
	assert.ok(!wide.includes("6.2%"), wide);
	assert.ok(!wide.includes("生成中"), wide);
	assert.ok(!wide.includes("01JC"), wide);
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
		sessionName: "s",
		cwd: "/tmp",
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
		resources: { skills: [], extensions: [], mcp: [] },
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
		sessionName: "s",
		cwd: "/tmp",
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
		resources: { skills: [], extensions: [], mcp: [] },
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

test("edit-preview：与 pi edit 同语义（多编辑/fuzzy/唯一命中/重叠）", () => {
	assert.deepEqual(getPreviewInput({ path: "a", oldText: "x", newText: "y" }), {
		path: "a",
		edits: [{ oldText: "x", newText: "y" }],
	});
	assert.equal(getPreviewInput({ path: "a" }), undefined);

	const exact = applyPreviewEdits("a\nb\nc", [
		{ oldText: "a", newText: "A" },
		{ oldText: "c", newText: "C" },
	]);
	assert.ok(!("error" in exact));
	assert.equal(exact.content, "A\nb\nC");

	// 智能引号走 fuzzy 归一化
	const fuzzy = applyPreviewEdits("const s = “hello”;", [{ oldText: '"hello"', newText: '"bye"' }]);
	assert.ok(!("error" in fuzzy));
	assert.equal(fuzzy.content, 'const s = "bye";');
	assert.equal(normalizeForFuzzyMatch("“a”"), '"a"');

	const duplicate = applyPreviewEdits("aa", [{ oldText: "a", newText: "b" }]);
	assert.ok("error" in duplicate && duplicate.error.includes("不唯一"), JSON.stringify(duplicate));

	// 自重叠 needle 与 pi 的 split 计数一致（"aaa" 里的 "aa" 只算一次）
	const selfOverlap = applyPreviewEdits("aaa", [{ oldText: "aa", newText: "b" }]);
	assert.ok(!("error" in selfOverlap), JSON.stringify(selfOverlap));
	assert.equal(selfOverlap.content, "ba");

	const overlap = applyPreviewEdits("abcd", [
		{ oldText: "abc", newText: "x" },
		{ oldText: "bcd", newText: "y" },
	]);
	assert.ok("error" in overlap && overlap.error.includes("重叠"), JSON.stringify(overlap));

	const empty = applyPreviewEdits("abc", [{ oldText: "", newText: "x" }]);
	assert.ok("error" in empty && empty.error.includes("为空"), JSON.stringify(empty));

	// 路径归一：与 pi 的 resolveToCwd 一样支持 @ 前缀、Unicode 空格、file://
	assert.equal(resolvePreviewPath("@src/a.ts", "/proj"), "/proj/src/a.ts");
	assert.equal(resolvePreviewPath("a\u00A0b.ts", "/proj"), "/proj/a b.ts");
	assert.equal(resolvePreviewPath("file:///tmp/x.ts", "/proj"), "/tmp/x.ts");
});

test("阅读辅助：回复首行在视口内时向下扫，高于视口时向上扫", () => {
	assert.equal(replyStartScrollDirection(30, 20), -1);
	assert.equal(replyStartScrollDirection(10, 20), 1);
	assert.equal(replyStartScrollDirection(20, 20), -1);
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

test("patchPrototypeSlots / unpatchPrototypeSlots：打补丁替换方法，unpatch 恢复原方法", () => {
	const proto = { greet: () => "hi" };
	const original = proto.greet;
	const patched = () => "patched";
	patchPrototypeSlots(proto, "t", { greet: patched });
	assert.equal(proto.greet, patched);
	assert.equal(proto.greet(), "patched");
	unpatchPrototypeSlots(proto, "t", ["greet"]);
	assert.equal(proto.greet, original);
	assert.equal(proto.greet(), "hi");
});

test("patchPrototypeSlots：连续 patch 两次是 no-op，original 不被覆盖", () => {
	const originalA = () => 1;
	const originalB = () => 2;
	const proto = { a: originalA, b: originalB };
	const implA = () => 10;
	const implB = () => 20;
	patchPrototypeSlots(proto, "t", { a: implA, b: implB });
	patchPrototypeSlots(proto, "t", { a: implA, b: implB });
	assert.equal(proto.a, implA);
	assert.equal(proto.b, implB);
	// original 仍是最初的原方法（不能是我们自己打上去的补丁，否则 unpatch 恢复不回 pi）
	const record = proto as Record<string, unknown>;
	assert.equal(record["t:original:a"], originalA);
	assert.equal(record["t:original:b"], originalB);
	unpatchPrototypeSlots(proto, "t", ["a", "b"]);
	assert.equal(proto.a, originalA);
	assert.equal(proto.b, originalB);
});

test("patchPrototypeSlots：槽位被第三方改写后 unpatch 不动它，标志清干净", () => {
	const proto = { a: () => 1 } as Record<string, unknown>;
	patchPrototypeSlots(proto, "t", { a: () => 10 });
	const foreign = () => 99;
	proto.a = foreign;
	unpatchPrototypeSlots(proto, "t", ["a"]);
	assert.equal(proto.a, foreign, "第三方函数不能被覆盖回原方法");
	// 失权路径也必须清标志，否则 /reload 再次 patch 会读到残留的 original
	for (const key of ["t:a", "t:original:a", "t:patched:a"]) {
		assert.equal(key in proto, false, `失权路径必须清掉 ${key}`);
	}
	// 标志清干净之后再次 patch 正常工作（这次 original 记的是第三方函数）
	const impl2 = () => 20;
	patchPrototypeSlots(proto, "t", { a: impl2 });
	assert.equal(proto.a, impl2);
	unpatchPrototypeSlots(proto, "t", ["a"]);
	assert.equal(proto.a, foreign);
});

test("patchPrototypeSlots：patch 中途部分失权，unpatch 只恢复仍持有的槽位", () => {
	const originalA = () => 1;
	const originalB = () => 2;
	const proto = { a: originalA, b: originalB } as Record<string, unknown>;
	patchPrototypeSlots(proto, "t", { a: () => 10, b: () => 20 });
	const foreign = () => 99;
	proto.a = foreign;
	const restored = unpatchPrototypeSlots(proto, "t", ["a", "b"]);
	assert.equal(restored, true, "至少收回了 b");
	assert.equal(proto.a, foreign, "失权的 a 保持第三方函数");
	assert.equal(proto.b, originalB, "仍持有的 b 恢复原方法");
});

test("computeSessionStats：缺 timestamp 的第二轮不从上一轮结束时间虚增 activeMs", () => {
	const entries = [
		{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant" } },
		// 缺 timestamp 的用户消息：turnStart 必须归 0，而不是回退用上一轮的结束时间
		{ type: "message", message: { role: "user" } },
		{ type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant" } },
	];
	const stats = computeSessionStats(entries, Date.parse("2026-01-01T03:00:00.000Z"));
	assert.equal(stats.turnCount, 2);
	assert.equal(stats.activeMs, 5000, "只累计第一轮（5s），缺 timestamp 的第二轮不计");
	assert.equal(stats.wallMs, 10_000);
});

test("renderContextBar：填充格按「格子中点 <= percent」计（75% / 10 格 = 8 格）", () => {
	const filled = (bar: string) => (bar.match(/\u25A3/g) ?? []).length;
	// 10 格的中点是 5,15,...,95；<= 75 的有 8 格（边界 75 本身算填充）
	assert.equal(filled(renderContextBar(75, 10)), 8);
	assert.equal(filled(renderContextBar(0, 10)), 0);
	assert.equal(filled(renderContextBar(null, 10)), 0);
	assert.equal(filled(renderContextBar(undefined, 10)), 0);
	// 未知占用率也要画满 cells 个暗灰空心格
	assert.equal(visibleWidth(renderContextBar(null, 10)), 10);
});

test("chromeLine：CHROME_PAD + BOLD_ON + 内容 + BOLD_OFF", () => {
	assert.equal(chromeLine("内容"), `${CHROME_PAD}${BOLD_ON}内容${BOLD_OFF}`);
	assert.equal(chromeLine(""), `${CHROME_PAD}${BOLD_ON}${BOLD_OFF}`);
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

test("缓存命中率方向：越高越好（99.2% 绿、40% 红），别和上下文占用混用", () => {
	// 缓存：越高越好
	assert.equal(hitRateLevel(99.2), "ok");
	assert.equal(hitRateLevel(85), "ok");
	assert.equal(hitRateLevel(80), "warn");
	assert.equal(hitRateLevel(50), "bad");
	assert.equal(hitRateLevel(12), "bad");
	assert.equal(hitRateLevel(undefined), "ok");

	// 上下文占用：越高越糟（阈值相同、方向相反）
	assert.equal(levelOf(12), "ok");
	assert.equal(levelOf(80), "warn");
	assert.equal(levelOf(99.2), "bad");

	// 颜色映射不能混
	assert.deepEqual(levelRgb(99.2), LEVEL_BAR_FILL.bad);
});

test("stripHomePrefix：Linux 上大小写必须敏感（/HOME/x 不能被当成 home）", async () => {
	const { stripHomePrefix } = await import("../path-text.ts");

	// 大小写敏感（Linux）：只有完全相同的前缀才算 home
	assert.equal(stripHomePrefix("/home/u/proj", "/home/u", false), "/proj");
	assert.equal(stripHomePrefix("/home/u", "/home/u", false), "");
	// 大小写不同 → 不是 home（这是原实现最坑的地方：/HOME/x 会被误缩成 ~/x）
	assert.equal(stripHomePrefix("/HOME/u/proj", "/home/u", false), undefined);
	assert.equal(stripHomePrefix("/Home/U/proj", "/home/u", false), undefined);

	// 大小写不敏感（Windows/macOS）：命中并且 rest 取原串（保留大小写）
	assert.equal(stripHomePrefix("/HOME/u/proj", "/home/u", true), "/proj");
	assert.equal(stripHomePrefix("/HOME/U/Proj", "/home/u", true), "/Proj");
});

test("stripHomePrefix：同前缀的兄弟目录不会被误缩", async () => {
	const { stripHomePrefix, shortenHome } = await import("../path-text.ts");

	// /home/u2 不是 /home/u 的子路径
	assert.equal(stripHomePrefix("/home/u2/proj", "/home/u", false), undefined);
	// Windows 路径同理
	assert.equal(stripHomePrefix("C:\\Users\\x2\\a", "C:\\Users\\x", true), undefined);
	assert.equal(stripHomePrefix("C:\\Users\\x\\a", "C:\\Users\\x", true), "\\a");

	// shortenHome 走 HOME 常量：不在 home 下就原样返回
	assert.equal(shortenHome("/definitely/not/home/dir"), "/definitely/not/home/dir");
});

test("stripHomePrefix：home 末尾的分隔符不影响判断", async () => {
	const { stripHomePrefix } = await import("../path-text.ts");

	assert.equal(stripHomePrefix("/home/u/a", "/home/u/", false), "/a");
	assert.equal(stripHomePrefix("/home/u", "/home/u/", false), "");
	// 根目录不能因为去尾分隔符变成空串
	assert.equal(stripHomePrefix("/etc/hosts", "/", false), "etc/hosts");
});

test("stripHomePrefix：toLowerCase 会改变长度时也不能错位", async () => {
	const { stripHomePrefix } = await import("../path-text.ts");

	// "İ".toLowerCase() 是 2 个码点（i + 组合点），原实现用 toLowerCase().startsWith
	// 判断、再用 HOME.length 截原串，遇到这种字符下标就会错。
	const home = "/home/\u0130x";
	const path = "/home/\u0130x/proj";
	assert.equal(stripHomePrefix(path, home, false), "/proj");
	assert.equal(stripHomePrefix(path, home, true), "/proj");
	// 长度不足时直接不命中（不能越界切片）
	assert.equal(stripHomePrefix("/home/\u0130", home, false), undefined);
});

test("createSessionStatsComputer：只累加新增条目，结果与全量重算一致", async () => {
	const { createSessionStatsComputer, computeSessionStats } = await import("../session-stats.ts");

	const entry = (ts, role, input, output, cacheRead = 0) => ({
		type: "message",
		timestamp: ts,
		message: { role, usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: 0.01 } } },
	});
	const entries = [
		entry("2026-11-15T10:00:00.000Z", "user", 0, 0),
		entry("2026-11-15T10:00:10.000Z", "assistant", 100, 20, 900),
		entry("2026-11-15T10:00:20.000Z", "user", 0, 0),
		entry("2026-11-15T10:00:40.000Z", "assistant", 200, 30, 1800),
	];
	const now = Date.parse("2026-11-15T10:00:45.000Z");

	const incremental = createSessionStatsComputer();
	// 逐步追加：每一步都必须与全量重算结果一致
	for (let n = 1; n <= entries.length; n++) {
		const slice = entries.slice(0, n);
		assert.deepEqual(
			incremental(slice, now),
			computeSessionStats(slice, now),
			`前 ${n} 条：增量结果应等于全量重算`,
		);
	}

	// 分支变短 / 前缀不一致（切分支）→ 必须回退成全量重算，不能带旧累积
	const switched = [entries[0], entry("2026-11-15T10:02:00.000Z", "assistant", 50, 5)];
	assert.deepEqual(
		incremental(switched, now),
		computeSessionStats(switched, now),
		"换成另一条分支后应等同全量重算",
	);

	// 返回的是副本：调用方修改不会污染缓存
	const a = incremental(entries, now);
	a.totalTokens = 0;
	assert.deepEqual(incremental(entries, now), computeSessionStats(entries, now), "缓存不应被上一次的返回值污染");
});

test("isEnabledByPatterns：精确模式按路径匹配，不按 basename（-commit 不误伤嵌套同名技能）", async () => {
	const { isEnabledByPatterns } = await import("../startup.ts");
	const base = "/base/skills";
	const flat = `${base}/commit/SKILL.md`;
	const nested = `${base}/nested/commit/SKILL.md`;

	// `-path` 是精确路径：`-commit` 只匹配 base 下的 commit 技能目录
	assert.equal(isEnabledByPatterns(["-commit"], flat, base, "commit", ["commit"]), false);
	assert.equal(isEnabledByPatterns(["-commit"], nested, base, "commit", ["commit"]), true);

	// `+path` 同理：嵌套目录要用相对路径
	assert.equal(isEnabledByPatterns(["+nested/commit"], nested, base, "commit", ["commit"]), true);
	assert.equal(isEnabledByPatterns(["+nested/commit"], flat, base, "commit", ["commit"]), true);
	assert.equal(isEnabledByPatterns(["+commit"], flat, base, "commit", ["commit"]), true);

	// `!glob` 仍然按 glob 匹配（大小写不敏感、支持 **）
	assert.equal(isEnabledByPatterns(["!**/commit/**"], nested, base, "commit", ["commit"]), false);
	assert.equal(isEnabledByPatterns(["!**/other/**"], nested, base, "commit", ["commit"]), true);

	// 没有规则时默认启用
	assert.equal(isEnabledByPatterns([], nested, base, "commit", ["commit"]), true);
});

test("createSessionStatsComputer：历史条目被就地改写后，周期性全量重算能纠正", async () => {
	const { createSessionStatsComputer, computeSessionStats } = await import("../session-stats.ts");

	const mk = (ts, input, output) => ({
		type: "message",
		timestamp: ts,
		message: { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
	});
	const entries = [
		mk("2026-11-15T10:00:00.000Z", 100, 10),
		mk("2026-11-15T10:00:10.000Z", 200, 20),
	];
	const compute = createSessionStatsComputer();
	const first = compute(entries);
	assert.equal(first.totalTokens, 330);

	// 就地改写历史条目的 usage（模拟 compaction / 会话编辑）
	entries[0].message.usage.input = 1000;
	// 紧接一次前缀续算仍会按旧值（这是已知取舍：不做 O(n) 校验）
	const second = compute(entries);
	assert.equal(second.totalTokens, 330, "续算会跳过已累加的历史条目（先按旧值）");

	// 连续调用若干次后会触发全量重算，把改写纠正回来
	let last = second;
	for (let i = 0; i < 25; i++) last = compute(entries);
	assert.deepEqual(last, computeSessionStats(entries), "周期性全量重算后应与全量结果一致");
	assert.equal(last.totalTokens, 1230);
});

test("本轮性能/正确性修复的纯函数回归", async () => {
	const { shouldHideEarlyMs, formatPanelDuration } = await import("../core.ts");
	const { summaryTokens } = await import("../summary-blocks.ts");
	const { shortenPathLine } = await import("../path-text.ts");

	// ① 首帧阈值：未结束且 <16ms → 隐藏；已结束 → 显示真实毫秒
	assert.equal(shouldHideEarlyMs({ startedAt: Date.now() }, 0), true);
	assert.equal(shouldHideEarlyMs({ startedAt: Date.now() }, 15), true);
	assert.equal(shouldHideEarlyMs({ startedAt: Date.now() }, 16), false);
	assert.equal(shouldHideEarlyMs({ startedAt: Date.now(), endedAt: Date.now() }, 3), false);

	// ② 摘要 token 缓存：同一内容两次调用结果一致；内容变了会重算
	const a = summaryTokens("这是一段摘要内容");
	const b = summaryTokens("这是一段摘要内容");
	assert.equal(a, b);
	assert.ok((a ?? 0) > 0, "摘要 token 不该是 0（assistant 必须传 block 数组）");
	assert.notEqual(summaryTokens("完全不同的另一段更长一些的摘要内容"), a);
	assert.equal(summaryTokens("   "), undefined);

	// ③ shortenPathLine：从右侧保留末尾若干段，且不超预算
	const path = "/very/long/path/to/some/project/src/components/deep/file.ts";
	for (const budget of [10, 20, 30, 40, 60]) {
		const out = shortenPathLine(path, budget);
		assert.ok(visibleWidth(out) <= budget, `budget=${budget} 超宽：${out}`);
	}
	// 放得下时原样返回
	assert.equal(shortenPathLine("/a/b.ts", 40), "/a/b.ts");
	// 放不下时保住文件名
	assert.ok(shortenPathLine(path, 20).endsWith("file.ts"), shortenPathLine(path, 20));
});

test("sessionCreatedAt / sessionAgeMs：时长按会话创建时间算，拿不到时退回 wallMs", async () => {
	const { sessionCreatedAt, computeSessionStats, createSessionStatsComputer } = await import(
		"../session-stats.ts"
	);

	// ① 从 header 时间戳解析
	const created = Date.parse("2026-11-19T10:00:00.000Z");
	assert.equal(
		sessionCreatedAt({ getHeader: () => ({ timestamp: "2026-11-19T10:00:00.000Z" }) }),
		created,
	);
	// 拿不到 / 坏值 / 抛错 → undefined（不伪造）
	assert.equal(sessionCreatedAt(undefined), undefined);
	assert.equal(sessionCreatedAt({ getHeader: () => null }), undefined);
	assert.equal(sessionCreatedAt({ getHeader: () => ({ timestamp: "not-a-date" }) }), undefined);
	assert.equal(
		sessionCreatedAt({ getHeader: () => { throw new Error("boom"); } }),
		undefined,
	);

	// ② sessionAgeMs = now - createdAt
	const now = created + 90 * 60_000; // 1.5 小时后
	const stats = computeSessionStats([], now, created);
	assert.equal(stats.sessionAgeMs, 90 * 60_000);

	// ③ 没有创建时间 → 0（不显示假的时长）
	assert.equal(computeSessionStats([], now).sessionAgeMs, 0);
	assert.equal(computeSessionStats([], now, 0).sessionAgeMs, 0);
	// 创建时间在未来（时钟偏差）→ 钳到 0，不出现负数
	assert.equal(computeSessionStats([], now, now + 60_000).sessionAgeMs, 0);

	// ④ 增量计算器同样支持
	const compute = createSessionStatsComputer();
	assert.equal(compute([], now, created).sessionAgeMs, 90 * 60_000);
	assert.equal(compute([], now).sessionAgeMs, 0);

	// ⑤ wallMs 语义不变（首条 → 最后一条），两者是独立的数
	const entries = [
		{ type: "message", timestamp: "2026-11-19T10:10:00.000Z", message: { role: "user" } },
		{ type: "message", timestamp: "2026-11-19T10:20:00.000Z", message: { role: "assistant" } },
	];
	const both = computeSessionStats(entries, now, created);
	assert.equal(both.wallMs, 10 * 60_000, "wallMs 仍是首条→最后一条");
	assert.equal(both.sessionAgeMs, 90 * 60_000, "sessionAgeMs 是创建→现在");
});

test("formatDateOnly / formatTimeOnly：拆成日期与时刻两行，窄宽度也放得下", async () => {
	const { formatDateTime, formatDateOnly, formatTimeOnly } = await import("../core.ts");

	const ms = new Date(2026, 10, 19, 10, 0, 0).getTime();
	assert.equal(formatDateOnly(ms), "2026年11月19日");
	assert.equal(formatTimeOnly(ms), "10时00分00秒");
	// 组合起来与 formatDateTime 一致
	assert.equal(formatDateTime(ms), "2026年11月19日 10时00分00秒");
	// 补零
	const midnight = new Date(2026, 0, 5, 3, 7, 9).getTime();
	assert.equal(formatDateOnly(midnight), "2026年01月05日");
	assert.equal(formatTimeOnly(midnight), "03时07分09秒");
	// 无效值一律 --
	for (const bad of [undefined, 0, Number.NaN, -1]) {
		assert.equal(formatDateOnly(bad), "--");
		assert.equal(formatTimeOnly(bad), "--");
	}
});
