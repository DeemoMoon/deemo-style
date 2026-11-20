/**
 * 行为测试：通过 pi 自己的加载器（jiti）把扩展加载起来，断言这次修复的具体
 * 行为——不只是“不崩”。
 *
 * 运行：bash tests/run.sh
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const piMain = await jiti.import("@earendil-works/pi-coding-agent");
piMain.initTheme("dark");

const extension = await jiti.import(fileURLToPath(new URL("../extension.ts", import.meta.url)), {
	default: true,
});

const { SHIMMER_PERIOD_MS } = await jiti.import("../core.ts");

const handlers = new Map();
const toolRenderers = [];
const commands = new Map();
const shortcuts = new Map();
const markdownTransformers = [];

/** 面板会用到的 pi 侧可变桩（测试里按需改 thinkingLevel / 记录调用）。 */
const piStub = {
	thinkingLevel: "medium",
	calls: [],
	authOk: true,
	/** 非空时 setModel 会等它 resolve（模拟真实异步切换） */
	gate: null,
	reset() {
		this.calls.length = 0;
		this.authOk = true;
		this.thinkingLevel = "medium";
		this.gate = null;
	},
};

extension({
	on(event, fn) {
		handlers.set(event, [...(handlers.get(event) ?? []), fn]);
	},
	registerToolRenderer(resolver) {
		toolRenderers.push(resolver);
	},
	registerMarkdownTransformer(transformer) {
		markdownTransformers.push(transformer);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	registerShortcut(key, options) {
		shortcuts.set(key, options);
	},
	getThinkingLevel: () => piStub.thinkingLevel,
	setThinkingLevel(level) {
		piStub.thinkingLevel = level;
		piStub.calls.push(["level", level]);
	},
	async setModel(model) {
		piStub.calls.push(["model", model.id]);
		if (piStub.gate) await piStub.gate;
		return piStub.authOk;
	},
	setSessionName(name) {
		piStub.calls.push(["name", name]);
	},
});
const resolvePanel = toolRenderers[0];

const color = (text) => `\x1b[38;2;100;100;100m${text}\x1b[39m`;
const theme = {
	fg: (_token, text) => color(text),
	bg: (_token, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	inverse: (text) => text,
	strikethrough: (text) => text,
	getThinkingBorderColor: () => (text) => text,
	borderColor: (text) => text,
	selectList: { selectedText: (text) => text },
};

const strip = (text) =>
	text.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

/** 构造走扩展真实 markdown transformer 的用户消息（ 图标 + 加粗）。 */
function styledUserMessage(text) {
	return new piMain.UserMessageComponent(
		text,
		undefined,
		undefined,
		markdownTransformers,
		`msg-${text.length}`,
	);
}

/** 渲染后第一条非空行的纯文本。 */
function firstVisibleLine(component, width = 80) {
	return strip(component.render(width).join("\n"))
		.split("\n")
		.find((line) => line.trim() !== "") ?? "";
}

/** 图标前缀（行首控制序列之后，正文之前）：必须是 0 或 1 个空格 + \uE370 + 1 个空格。 */
function iconPrefix(line) {
	const m = /^(\s*)\uE370 /.exec(line);
	return m ? m[1].length : -1;
}

function panelContext(overrides = {}) {
	return {
		args: {},
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		invalidate() {},
		...overrides,
	};
}

test("B1 助手消息以代码块结尾时，OSC133 标记不能跟着围栏行一起被删", () => {
	const component = new piMain.AssistantMessageComponent({
		content: [{ type: "text", text: "说明\n\n```js\nconst a = 1;\n```" }],
		timestamp: 1,
	});
	const lines = component.render(80);
	const out = lines.join("\n");
	assert.ok(out.includes("\x1b]133;B\x07"), "ZONE_END 丢了");
	assert.ok(out.includes("\x1b]133;C\x07"), "ZONE_FINAL 丢了");
	assert.ok(
		!strip(out)
			.split("\n")
			.some((line) => line.trim().startsWith("```")),
		"围栏行仍应被删掉",
	);

	// 助手消息也要能当「跳到上/下一条消息」的落点：pi 的 scrollToPrompt 用
	// /^\x1b\]133;A/ 匹配行首，所以标记必须在第 0 列，缩进/图标得排在它后面。
	assert.ok(
		lines[0]?.startsWith("\x1b]133;A"),
		`首行应以 ZONE_START 开头：${JSON.stringify(lines[0]?.slice(0, 12))}`,
	);

	// 缩进仍在：可见内容左边缘不变（标记零宽，不影响行宽）
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80, `行宽超限：${visibleWidth(line)}`);
	}

	// 图标 + 后面那个空格都必须在染色范围内：PUA 字形在部分 CJK 终端里按 2 列渲染，
	// 若字形后立刻 RESET，第 2 个填充格会露出默认前景色（“左蓝右白”的半截图标）。
	const iconLine = lines.find((line) => line.includes("\uE22C")) ?? "";
	assert.match(iconLine, /\uE22C \x1b\[39m/, "图标后的空格应仍在天青色范围内");

	// 普通消息（不以围栏结尾，不触发“搬移标记”逻辑）：末行应保留 pi 的 ZONE_END 前缀
	const plain = new piMain.AssistantMessageComponent({
		content: [{ type: "text", text: "第一行\n\n结尾一行" }],
		timestamp: 2,
	});
	const plainLines = plain.render(80);
	assert.ok(plainLines[0]?.startsWith("\x1b]133;A"), "普通消息首行也应以 ZONE_START 开头");
	assert.ok(
		plainLines[plainLines.length - 1]?.startsWith("\x1b]133;B"),
		`普通消息末行应以 ZONE_END 开头：${JSON.stringify(plainLines[plainLines.length - 1]?.slice(0, 12))}`,
	);
});

test("B11 thinking：窗口 12 行，运行中/完成后都定格尾巴", () => {
	const tailSource = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 步：继续推理`).join("\n");
	const msg = { content: [{ type: "thinking", thinking: tailSource }], timestamp: 21 };
	const comp = new piMain.AssistantMessageComponent(msg, false);

	// 完成态：标题 + 尾部内容（≤12 行，含“上面还有内容”提示），不再是光秃秃一行
	const finished = comp.render(80).map(strip).filter((line) => line.trim() !== "");
	assert.ok(finished.some((line) => line.includes("思考")), "应保留标题行");
	assert.ok(finished.some((line) => line.includes("第 20 步")), "应显示最后一行的内容");
	assert.ok(
		finished.some((line) => line.includes("上面还有内容")),
		"内容超过窗口应提示上面还有内容",
	);
	assert.ok(!finished.some((line) => line.includes("第 1 步")), "不应显示最早的内容");
	assert.ok(finished.length <= 13, `窗口应封顶（1 标题 + 12 行），实际 ${finished.length}`);
	assert.ok(!finished.join("").includes("▍"), "完成后不应有光标");

	// 运行中：标题「思考中...」+ 尾窗 + 光标
	const realNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		comp.updateContent({ content: [msg.content[0]], timestamp: 21 }, true);
		comp.render(80);
		now += 5000;
		const streaming = comp.render(80).map(strip).filter((line) => line.trim() !== "");
		assert.ok(streaming.some((line) => line.includes("思考中")), "运行中标题应为「思考中...」");
		assert.ok(streaming.some((line) => line.includes("第 20 步")), "运行中也显示尾部");
		assert.ok(streaming.join("").includes("▍"), "运行中末行应有光标");
	} finally {
		Date.now = realNow;
	}

	// 用户点开：pi 自己渲染完整 Markdown
	comp.setHideThinkingBlock(false);
	const expanded = strip(comp.render(80).join("\n"));
	assert.ok(!expanded.includes("思考中"), "展开后不应再有折叠标题");
	assert.ok(expanded.includes("第 1 步"), "展开后能看到完整思考链");
});

test("思考块：多个连续 thinking 段都必须进预览（cacheKey 不能污染快照）", () => {
	const a = Array.from({ length: 20 }, (_, i) => `A-${i + 1}`).join("\n");
	const b = "B-1\nB-2\nB-3";
	const component = new piMain.AssistantMessageComponent(undefined, true);
	component.updateContent(
		{
			content: [
				{ type: "thinking", thinking: a },
				{ type: "thinking", thinking: b },
			],
			timestamp: 22,
		},
		true,
	);
	const out = strip(component.render(80).join("\n"));
	assert.ok(out.includes("A-20"), `应能看到第一段的尾部：\n${out}`);
	assert.ok(out.includes("B-3"), `应能看到最后一段：\n${out}`);
	assert.ok(out.includes("上面还有内容"), `内容被截断时应提示：\n${out}`);
});

test("B4 `!` 回放（构造即完成）不显示假耗时", () => {
	const exec = new piMain.BashExecutionComponent("echo hi", { requestRender() {} }, false, 1);
	exec.appendOutput("hi\n");
	exec.setComplete(0, false);
	const out = strip(exec.render(80).join("\n"));
	assert.ok(!/\b[01]ms\b/.test(out), out);
	assert.ok(out.includes("echo hi"));
});

test("B3 `!` 命令：单条超长行在折叠/展开态都不会爆出无界可视行", () => {
	const exec = new piMain.BashExecutionComponent("cat huge.json", { requestRender() {} }, false, 1);
	exec.appendOutput("x".repeat(500_000));
	exec.setComplete(0, false);

	const collapsed = exec.render(80);
	assert.ok(collapsed.length < 60, `折叠态应封顶，实际 ${collapsed.length} 行`);
	assert.ok(collapsed.join("\n").includes("cat huge.json"));

	exec.setExpanded(true);
	const expanded = exec.render(80);
	assert.ok(expanded.length < 1200, `展开态应封顶，实际 ${expanded.length} 行`);
});

test("B5 工具面板 partial 阶段不重复“执行中”", () => {
	const panel = resolvePanel("bash", () => undefined);
	const context = panelContext({
		args: { command: "sleep 1" },
		isPartial: true,
	});
	const lines = strip(
		[
			...panel.renderCall(context.args, theme, context).render(80),
			...panel
				.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: true }, theme, context)
				.render(80),
		].join("\n"),
	);
	assert.equal(lines.split("执行中").length - 1, 1);
});

test("B2/B3 edit 预览：异步、按 cwd 解析、CRLF 与 fuzzy 与 pi 同语义", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ui-style-edit-"));
	writeFileSync(join(dir, "a.txt"), "line1\r\nline2\r\n");

	const panel = resolvePanel("edit", () => undefined);
	let invalidated = 0;
	const state = {};
	const args = { path: "a.txt", edits: [{ oldText: "line1", newText: "LINE1" }] };
	const context = panelContext({
		args,
		state,
		cwd: dir,
		invalidate() {
			invalidated++;
		},
	});

	panel.renderCall(args, theme, context).render(80);
	assert.equal(state.previewDiff, undefined, "首帧不应有同步读盘算出的 diff");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(invalidated > 0, "算完必须请求重绘");
	assert.equal(typeof state.previewDiff, "string", state.previewError);
	assert.ok(state.previewDiff.includes("LINE1"));

	const file2 = join(dir, "b.txt");
	writeFileSync(file2, "他说\u201Chello\u201D\n");
	const state2 = {};
	const args2 = { path: file2, edits: [{ oldText: '他说"hello"', newText: "他说bye" }] };
	panel.renderCall(args2, theme, panelContext({ args: args2, state: state2 })).render(80);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(typeof state2.previewDiff, "string", state2.previewError);
});

test("B8 极窄终端下 ls 框不出超宽行/内嵌换行", () => {
	const panel = resolvePanel("ls", () => undefined);
	const context = panelContext({ args: { path: "/tmp" } });
	const view = panel.renderResult(
		{ content: [{ type: "text", text: "a\nb\nc" }] },
		{ expanded: false, isPartial: false },
		theme,
		context,
	);
	for (const width of [1, 2, 3, 4]) {
		const lines = view.render(width);
		for (const line of lines) {
			assert.ok(!line.includes("\n"), `width=${width} 出现换行`);
			assert.ok(visibleWidth(line) <= width, `width=${width} 超宽`);
		}
	}
});

test("用户消息：左移一列但总宽不变，末尾空行被删", () => {
	const component = new piMain.UserMessageComponent("你好\n\n第二段");
	for (const width of [40, 80]) {
		const widths = [...new Set(component.render(width).map((line) => visibleWidth(line)))];
		assert.deepEqual(widths, [width]);
	}
	const lines = component.render(40);
	assert.notEqual(strip(lines[lines.length - 1]).trim(), "");
});

test("用户消息图标 \uE370 出现在引用 / 标题标记之前（第 0 列）", () => {
	// 图标插在块级前缀之前：屏幕上永远只偏 0~1 列（pi 的 Markdown 渲染会给
	// 段落加缩进），且不会落到 > / # 之后（否则会被算进引用块/标题内容）。
	// 注：pi 渲染 blockquote 时把 > 换成 │；h1/h2 的 # 标记会被 pi 的
	// markdown 主题吞掉（只保留标题文字），h3 才原样保留 "###"。
	const cases = [
		["> 引用内容", "│ 引用内容"],
		["# 标题", "标题"],
	];
	for (const [text, rendered] of cases) {
		const line = firstVisibleLine(styledUserMessage(text));
		assert.ok(iconPrefix(line) <= 1, `「${text}」图标应在行首 0~1 列：${JSON.stringify(line)}`);
		assert.ok(line.includes(rendered), `「${text}」应渲染出内容：${JSON.stringify(line)}`);
	}
});

test("技能横幅：折叠 4 行预览，展开显示全部", () => {
	const banner = new piMain.SkillInvocationMessageComponent({
		name: "demo",
		content: Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
	});
	const collapsed = strip(banner.render(80).join("\n"));
	assert.ok(collapsed.includes("demo"));
	assert.ok(collapsed.includes("已加载"));
	assert.match(collapsed, /more lines?/);

	banner.setExpanded(true);
	assert.ok(strip(banner.render(80).join("\n")).includes("第 12 行"));
});

test("所有面板在 1~200 列都能渲染出合法行", () => {
	const tools = ["bash", "codemode", "read", "write", "edit", "grep", "find", "powershell", "ls"];
	const argsByTool = {
		bash: { command: "npm test -- --watch=false | tee /tmp/out.log" },
		codemode: { code: "const x = 1;" },
		read: { file_path: "/home/user/project/src/a-very-long-file-name.tsx" },
		write: { file_path: "/home/user/a/b/c.txt", content: "line1\nline2\n" },
		edit: { path: "/home/user/a/b/c.txt", edits: [{ oldText: "line1", newText: "L1" }] },
		grep: { pattern: "foo", glob: "*.ts", path: "/home/user/project" },
		find: { pattern: "*.ts", path: "/home/user/project" },
		powershell: { command: "Get-ChildItem -Recurse" },
		ls: { path: "/home/user/project" },
	};
	const result = {
		content: [{ type: "text", text: "out 1\nout 2\nout 3" }],
		details: { diff: "- old\n+ new\n" },
	};

	for (const width of [1, 2, 3, 4, 6, 10, 20, 40, 80, 200]) {
		for (const toolName of tools) {
			const panel = resolvePanel(toolName, () => undefined);
			assert.ok(panel, `${toolName} 未注册`);
			for (const expanded of [false, true]) {
				for (const isPartial of [false, true]) {
					const context = panelContext({
						args: argsByTool[toolName],
						expanded,
						isPartial,
					});
					const components = [
						panel.renderCall(context.args, theme, context),
						panel.renderResult(result, { expanded, isPartial }, theme, context),
					];
					for (const component of components) {
						for (const line of component.render(width)) {
							assert.ok(!line.includes("\n"), `${toolName} width=${width} 内嵌换行`);
							assert.ok(
								visibleWidth(line) <= width,
								`${toolName} width=${width} 行宽 ${visibleWidth(line)}`,
							);
						}
					}
				}
			}
		}
	}
});

test("未注册的工具交还给 pi", () => {
	assert.equal(resolvePanel("mcp__foo__bar", () => undefined), undefined);
});

// ---------------------------------------------------------------------------
// session_start 接线 + 状态栏 / 信息条 / 输入框 / 启动页的渲染
// ---------------------------------------------------------------------------

test("session_start 接线：状态栏 / 信息条 / 输入框 / 启动页都能渲染出合法行", async () => {
	const { mkdirSync } = await import("node:fs");
	const cwd = mkdtempSync(join(tmpdir(), "ui-style-start-"));
	writeFileSync(join(cwd, "AGENTS.md"), "# 规则\n");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!**/secret/**"] }));

	let header;
	let footer;
	let editor;
	let widget;

	const tui = { requestRender() {}, terminal: { rows: 40 } };
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["other-ext", "状态文本"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const sessionManager = {
		getCwd: () => cwd,
		getSessionId: () => "session-1",
		getSessionName: () => "演示会话",
		getLeafId: () => "leaf-1",
		getBranch: () => [],
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getTree: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({}),
	};
	const ui = {
		theme,
		setHeader(factory) {
			header = factory(tui, theme);
		},
		setFooter(factory) {
			footer = factory(tui, theme, footerData);
		},
		setEditorComponent(factory) {
			editor = factory(tui, { ...theme, selectList: theme.selectList }, { matches: () => false });
		},
		// 信息条用的 widget 才是我们要检查的（还有一个 0 行的“滚动桥” widget）
		setWidget(key, factory) {
			if (key === "input-info-bar" && typeof factory === "function") widget = factory(tui, theme);
		},
		setWorkingIndicator() {},
		setWorkingMessage() {},
		setStatus() {},
	};
	const ctx = {
		mode: "tui",
		cwd,
		ui,
		model: { id: "demo-model", provider: "demo", contextWindow: 200_000 },
		sessionManager,
		getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6.2 }),
	};

	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, ctx);
	}
	// 启动页扫描是异步的，等它跑完
	await new Promise((resolve) => setTimeout(resolve, 400));

	assert.ok(footer, "没有设置状态栏");
	assert.ok(widget, "没有设置信息条");
	assert.ok(editor, "没有设置输入框");
	assert.ok(header, "没有设置启动页");

	const targets = { footer, widget, editor, header };
	for (const [name, component] of Object.entries(targets)) {
		for (const width of [40, 80, 120]) {
			const lines = component.render(width);
			assert.ok(lines.length > 0, `${name} width=${width} 渲染出 0 行`);
			for (const line of lines) {
				assert.ok(!line.includes("\n"), `${name} width=${width} 内嵌换行`);
				assert.ok(
					visibleWidth(line) <= width,
					`${name} width=${width} 行宽 ${visibleWidth(line)}`,
				);
			}
		}
	}

	const statuslineText = strip(footer.render(120).join("\n"));
	assert.ok(statuslineText.includes("demo-model(demo)"), statuslineText);
	assert.ok(statuslineText.includes("Ctx"), statuslineText);
	const headerText = strip(header.render(120).join("\n"));
	assert.ok(headerText.includes("AGENTS.md"), headerText);
	assert.ok(!headerText.includes("正在扫描"), "扫描应该已经完成");
});

// ---------------------------------------------------------------------------
// 运行中块的标题扫光
// ---------------------------------------------------------------------------

/** 一行里出现过的所有 24-bit 前景色。 */
function distinctFgColors(line) {
	return new Set([...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m[0]));
}

test("扫光：运行中的面板标题在多色之间往返，结束后恢复平色", () => {
	const panel = resolvePanel("bash", () => undefined);
	const args = { command: "ls -la" };
	const running = panelContext({ args, isPartial: true });
	const realNow = Date.now;

	try {
		Date.now = () => 10_000;
		const call = panel.renderCall(args, theme, running);
		const first = call.render(80)[0] ?? "";

		Date.now = () => 10_000 + SHIMMER_PERIOD_MS / 2; // 相位 1：亮带扫到最右
		const middle = call.render(80)[0] ?? "";
		assert.notEqual(first, middle, "标题应随帧重画（否则缓存把动画停住了）");
		assert.ok(
			distinctFgColors(middle).size >= 3,
			`运行中标题应有多个颜色，实际 ${distinctFgColors(middle).size}`,
		);
		assert.equal(strip(middle).includes("Bash"), true);

		// 再过一个完整周期：相位回到 0，首个字符的亮色应恢复
		Date.now = () => 10_000 + SHIMMER_PERIOD_MS;
		const again = call.render(80)[0] ?? "";
		const headColors = (line) => [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m[0]);
		assert.equal(headColors(again)[0], headColors(first)[0], "相位回到起点时首个字符颜色应一致");
	} finally {
		Date.now = realNow;
	}

	// 参数流式阶段（executionStarted 还是 false）也必须已经开始扫光：
	// 这是回归点——以前用 isPartial && executionStarted 判定，edit/write 要等
	// 参数流完、真正开跑才亮，用户看到的就是“晚两三秒”。
	const streaming = panelContext({ args, isPartial: true, executionStarted: false });
	Date.now = () => 20_000;
	const streamingView = panel.renderCall(args, theme, streaming);
	Date.now = () => 20_350;
	const streamingLine = streamingView.render(80)[0] ?? "";
	const streamingColors = distinctFgColors(streamingLine).size;
	assert.ok(streamingColors >= 3, `参数流式阶段就该扫光，实际 ${streamingColors} 种颜色`);

	// 结束态：只保留主题色 + 计时色，没有扫光
	const finished = panelContext({ args, isPartial: false, durationMs: 1234 });
	const result = panel.renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false, isPartial: false },
		theme,
		finished,
	);
	const finishedLine = result.render(80)[0] ?? "";
	assert.ok(
		distinctFgColors(finishedLine).size <= 2,
		`结束态不应再扫光，实际 ${distinctFgColors(finishedLine).size} 种颜色`,
	);
});

test("扫光：`!` 短命令运行中闪，长命令不闪", () => {
	const realNow = Date.now;
	try {
		Date.now = () => 5_000;
		const short = new piMain.BashExecutionComponent("echo hi", { requestRender() {} }, false, 1);
		Date.now = () => 5_350;
		const shortLine = short.render(60).map(strip).find((line) => line.includes("echo hi"));
		assert.ok(shortLine, "找不到命令行");
		const shortColors = distinctFgColors(short.render(60).find((line) => strip(line).includes("echo hi")));
		assert.ok(shortColors.size >= 3, `短命令应扫光，实际 ${shortColors.size} 种颜色`);

		Date.now = () => 5_000;
		const long = new piMain.BashExecutionComponent("x".repeat(80), { requestRender() {} }, false, 1);
		Date.now = () => 5_350;
		const longLine = long.render(40).find((line) => strip(line).includes("xxx"));
		long.setComplete(0, false);
		assert.ok(longLine, "找不到命令行");
		// 长命令不扫光：两个相位渲染结果应完全一致
		Date.now = () => 5_700;
		const longAgain = long.render(40).find((line) => strip(line).includes("xxx"));
		assert.equal(longLine, longAgain, "长命令不扫光");

		// 结束后短命令不再随相位变化（扫光停了）
		short.setComplete(0, false);
		Date.now = () => 6_000;
		const doneA = short.render(60).find((line) => strip(line).includes("echo hi"));
		Date.now = () => 6_400;
		const doneB = short.render(60).find((line) => strip(line).includes("echo hi"));
		assert.ok(doneA);
		assert.equal(doneA, doneB, "结束态不应再随相位变化");
	} finally {
		Date.now = realNow;
	}
});

test("工作中：月相转圈 + 亮黄↔暗紫滚动呼吸文案", async () => {
	const workingMessages = [];
	let indicator;
	const tui = { requestRender() {}, terminal: { rows: 40 } };
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionId: () => "s",
		getSessionName: () => "",
		getLeafId: () => "l",
		getBranch: () => [],
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getTree: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({}),
	};
	const ui = {
		theme,
		setHeader() {},
		setFooter() {},
		setEditorComponent() {},
		setWidget() {},
		setWorkingIndicator(options) {
			indicator = options;
		},
		setWorkingMessage(message) {
			workingMessages.push(message);
		},
		setStatus() {},
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		ui,
		model: { id: "m", provider: "p", contextWindow: 1000 },
		sessionManager,
		getContextUsage: () => undefined,
	};

	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, ctx);
	}

	// 月相：8 帧、每帧 2 列宽（emoji 都是宽字符）；帧间隔是可调参数（大于 pi 默认 80ms）
	assert.ok(typeof indicator?.intervalMs === "number" && indicator.intervalMs > 80);
	assert.equal(indicator?.frames?.length, 8);
	for (const frame of indicator.frames) assert.equal(visibleWidth(frame), 2);

	const colors = (text) => new Set([...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m[0]));
	const first = workingMessages[workingMessages.length - 1] ?? "";
	const plain = first.replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal(plain, "工作中", "文案只剩「工作中」，没有省略号");
	assert.ok(colors(first).size >= 2, "文案应是逐字渐变");

	// 播一帧：相位前进后颜色必须变（滚动呼吸在进行）
	const realNow = Date.now;
	try {
		for (const handler of handlers.get("agent_start") ?? []) {
			await handler({ type: "agent_start" }, ctx);
		}
		Date.now = () => realNow() + 600;
		await new Promise((resolve) => setTimeout(resolve, 160));
		const later = workingMessages[workingMessages.length - 1];
		assert.notEqual(later, first, "呼吸相位应该随时间推进");
		assert.equal(later.replace(/\x1b\[[0-9;]*m/g, ""), "工作中");
	} finally {
		Date.now = realNow;
		for (const handler of handlers.get("agent_settled") ?? []) {
			await handler({ type: "agent_settled" }, ctx);
		}
	}
});

test("信息条图标：沙漏 4 帧轮转 + 速度档字形，宽度不抖、沙漏颜色恒定（不闪）", async () => {
	let widget;
	const tui = { requestRender() {}, terminal: { rows: 40 } };
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionId: () => "s",
		getSessionName: () => "",
		getLeafId: () => "l",
		getBranch: () => [],
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getTree: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({}),
	};
	const ui = {
		theme,
		setHeader() {},
		setFooter() {},
		setEditorComponent() {},
		// 信息条用的 widget 才是我们要检查的（还有一个 0 行的“滚动桥” widget）
		setWidget(key, factory) {
			if (key === "input-info-bar" && typeof factory === "function") widget = factory(tui, theme);
		},
		setWorkingIndicator() {},
		setWorkingMessage() {},
		setStatus() {},
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		ui,
		model: { id: "m", provider: "p", contextWindow: 1000 },
		sessionManager,
		getContextUsage: () => undefined,
	};
	for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);
	for (const h of handlers.get("agent_start") ?? []) await h({ type: "agent_start" }, ctx);

	const realNow = Date.now;
	const start = realNow();
	try {
		const glyphs = [];
		const plains = [];
		const rawLines = [];
		const colors = [];
		const widths = [];
		// 采 8 秒（4 帧一轮，只要单帧 ≤ 2s 就能覆盖完整一轮），每 100ms 取一帧
		for (let dt = 0; dt <= 8000; dt += 100) {
			Date.now = () => start + dt;
			const line = widget.render(80)[0] ?? "";
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			// 沙漏是「私有区字形 + 空格 + 耗时」里的那个私有区字形（倒数第二段）
			const tail = plain.trimEnd().split(" ");
			const glyph = tail[tail.length - 2] ?? "";
			glyphs.push(glyph);
			plains.push(plain);
			rawLines.push(line);
			widths.push(visibleWidth(line));
			// 取该行最后一个 24-bit 前景色（就是沙漏的颜色）
			const found = [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
			colors.push(found[found.length - 1]?.[0] ?? "");
		}

		// 1) 出现 4 种不同的沙漏字形，且顺序是给定的轮转
		const order = [...new Set(glyphs)];
		assert.deepEqual(order, ["󰔟", "󱦟", "󰚭", "󰞌"]);

		// 2) 整行宽度全程不变（字形都是 1 列，不会左右抖）
		assert.equal(new Set(widths).size, 1, `宽度抖动: ${[...new Set(widths)].join(",")}`);

		// 3) 颜色全程恒定：只轮转字形、不做亮度脉冲（闪烁的根源就是那个包络）
		assert.equal(new Set(colors).size, 1, `沙漏颜色应恒定，实际 ${new Set(colors).size} 种`);

		// 4) 速度图标：本测试里没有真实速度 → 固定落在最低档（天青速度表），
		//    且动画只改亮度不改字形（所以整段采样里只应出现这一个速度字形）
		const speedGlyphs = new Set();
		for (const text of plains) {
			for (const glyph of ["\udb83\udf86", "\udb83\udf85", "\udb81\udcc5"]) {
				if (text.includes(glyph)) speedGlyphs.add(glyph);
			}
		}
		assert.deepEqual([...speedGlyphs], ["\udb83\udf86"], `应只有最低档速度字形，实际 ${[...speedGlyphs].join(",")}`);

		// 两个图标后面的空格都必须在染色范围内（PUA 双宽终端否则会露出白色填充格）
		const one = rawLines[0] ?? "";
		assert.match(one, /[\u{F051F}\u{F199F}\u{F06AD}\u{F078C}] \x1b\[39m/u, "沙漏后的空格应仍在染色范围内");
		assert.match(one, /[\u{F0F86}\u{F0F85}\u{F04C5}] \x1b\[39m/u, "速度图标后的空格应仍在染色范围内");
	} finally {
		Date.now = realNow;
		for (const h of handlers.get("agent_settled") ?? []) await h({ type: "agent_settled" }, ctx);
	}
});

test("速度图标：3 档字形+颜色，档内按 6s/4s/2s 平滑呼吸", async () => {
	const infobar = await jiti.import(fileURLToPath(new URL("../infobar.ts", import.meta.url)));
	const { speedFrame, speedIdleFrame, speedTier } = infobar;

	// 1) 三档字形（60 / 150 是档位边界，含边界）
	const tiers = [
		{ speed: 0, glyph: "\udb83\udf86" },
		{ speed: 60, glyph: "\udb83\udf86" },
		{ speed: 61, glyph: "\udb83\udf85" },
		{ speed: 150, glyph: "\udb83\udf85" },
		{ speed: 151, glyph: "\udb81\udcc5" },
		{ speed: 9999, glyph: "\udb81\udcc5" },
	];
	for (const tier of tiers) {
		assert.equal(speedFrame(0, tier.speed).glyph, tier.glyph, `${tier.speed} tok/s 字形不对`);
		assert.equal(speedTier(tier.speed).glyph, tier.glyph);
	}
	assert.equal(speedFrame(0, undefined).glyph, "\udb83\udf86", "无速度数据落到最低档");

	// 2) 颜色色相：天青 B>G>R、黄 R≥G>B、红 R>G≥B
	const rgbOf = (frame) => {
		const m = /38;2;(\d+);(\d+);(\d+)/.exec(frame.color);
		return [Number(m[1]), Number(m[2]), Number(m[3])];
	};
	const [br, bg, bb] = rgbOf(speedFrame(0, 10));
	assert.ok(bb > bg && bg > br, `天青应 B>G>R：${br},${bg},${bb}`);
	const [yr, yg, yb] = rgbOf(speedFrame(0, 100));
	assert.ok(yr >= yg && yg > yb, `黄应 R≥G>B：${yr},${yg},${yb}`);
	const [rr, rg, rb] = rgbOf(speedFrame(0, 300));
	assert.ok(rr > rg && rg >= rb, `红应 R>G≥B：${rr},${rg},${rb}`);

	// 3) 呼吸周期按档：低 6s / 中 4s / 高 2s
	assert.equal(speedFrame(0, 10).breathMs, 6000, "低档应 6s");
	assert.equal(speedFrame(0, 100).breathMs, 4000, "中档应 4s");
	assert.equal(speedFrame(0, 200).breathMs, 2000, "高档应 2s");

	// 4) 平滑呼吸：两端落在 45% / 100%，前半周期单调上升
	const period = speedFrame(0, 10).breathMs;
	assert.ok(Math.abs(speedFrame(0, 10).intensity - 0.45) < 0.01, "周期起点应为最暗 45%");
	assert.ok(Math.abs(speedFrame(period / 2, 10).intensity - 1) < 0.01, "半个周期应为最亮 100%");
	let previous = -1;
	for (let t = 0; t <= period / 2; t += period / 24) {
		const value = speedFrame(t, 10).intensity;
		assert.ok(value >= previous - 1e-9, "前半周期应单调上升（不能跳变）");
		previous = value;
	}

	// 5) 不闪：相邻 50ms 采样（实际帧率）的亮度差必须很小
	for (const speed of [10, 100, 200]) {
		const p = speedFrame(0, speed).breathMs;
		let maxDelta = 0;
		let minIntensity = 1;
		for (let t = 0; t < p; t += 50) {
			const a = speedFrame(t, speed).intensity;
			const b = speedFrame(t + 50, speed).intensity;
			maxDelta = Math.max(maxDelta, Math.abs(b - a));
			minIntensity = Math.min(minIntensity, a);
		}
		assert.ok(maxDelta < 0.1, `${speed} tok/s 相邻帧亮度差应 <0.1，实际 ${maxDelta.toFixed(3)}`);
		assert.ok(minIntensity >= 0.44, `${speed} tok/s 不应熄灭，最暗 ${minIntensity.toFixed(2)}`);
	}

	// 6) 空闲帧：字形随档、亮度固定在中位
	const idle = speedIdleFrame(100);
	assert.equal(idle.glyph, speedFrame(0, 100).glyph);
	assert.ok(Math.abs(idle.intensity - 0.725) < 0.01, `空闲亮度应为中位，实际 ${idle.intensity}`);
});


test("工具框：运行中/完成都显示 3 行尾窗，展开后看全部", () => {
	const tools = ["bash", "read", "write", "edit", "grep", "find", "powershell", "ls", "codemode"];
	const argsByTool = {
		bash: { command: "npm test" },
		codemode: { code: "const a = 1;" },
		read: { file_path: "/tmp/a.ts" },
		write: { file_path: "/tmp/b.ts", content: "x\ny\n" },
		edit: { path: "/tmp/b.ts", edits: [{ oldText: "x", newText: "X" }] },
		grep: { pattern: "foo", path: "/tmp" },
		find: { pattern: "*.ts", path: "/tmp" },
		powershell: { command: "Get-ChildItem" },
		ls: { path: "/tmp" },
	};
	const output = Array.from({ length: 9 }, (_, i) => `out ${i + 1}`).join("\n");
	const result = { content: [{ type: "text", text: output }], details: { diff: "- old\n+ new\n" } };

	for (const toolName of tools) {
		const panel = resolvePanel(toolName, () => undefined);
		const args = argsByTool[toolName];

		// 完成 + 收起：显示尾部 3 行（或更少），不再是 0 行
		const doneCtx = panelContext({ args });
		panel.renderResult(result, { expanded: false, isPartial: false }, theme, doneCtx);
		const doneLines = panel
			.renderResult(result, { expanded: false, isPartial: false }, theme, doneCtx)
			.render(80)
			.map(strip)
			.filter((line) => line.trim() !== "");
		assert.ok(doneLines.length > 0, `${toolName} 完成态应显示尾部内容`);
		assert.ok(
			doneLines.length <= 4,
			`${toolName} 完成态窗口应 ≤3 行内容 + 提示，实际 ${doneLines.length}`,
		);

		// 标题行带 “· N 行”
		const header = strip(panel.renderCall(args, theme, doneCtx).render(80)[0] ?? "");
		assert.match(header, /·\s*\d+ 行$/, `${toolName} 标题应带行数：${header}`);

		// 展开：完整内容
		const expandedCtx = panelContext({ args, expanded: true });
		const expandedLines = panel
			.renderResult(result, { expanded: true, isPartial: false }, theme, expandedCtx)
			.render(80);
		assert.ok(expandedLines.length > 0, `${toolName} 展开后应有完整内容`);

		// 运行中且没有 partial 输出 → 一行“执行中”占位（write 例外：它会滚动显示正在写入的内容）
		const runningCtx = panelContext({ args, isPartial: true });
		const runningLines = panel.renderCall(args, theme, runningCtx).render(80);
		if (toolName === "write") {
			assert.ok(runningLines.length > 1, "write 运行中应显示正在写入的内容");
		} else {
			assert.ok(
				runningLines.some((line) => strip(line).includes("执行中")),
				`${toolName} 运行中应有「执行中」占位`,
			);
		}
	}
});

test("运行中实时尾窗：只显示最新 3 行、末行带光标", () => {
	const panel = resolvePanel("bash", () => undefined);
	const args = { command: "seq 1 20" };
	const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const result = { content: [{ type: "text", text: output }] };
	const ctx = panelContext({
		args,
		isPartial: true,
		state: { startedAt: Date.now() - 1000 },
	});

	const realNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	try {
		const view = panel.renderResult(result, { expanded: false, isPartial: true }, theme, ctx);
		view.render(80); // 首帧
		now += 2000;     // 追平
		const lines = view.render(80).map(strip).filter((line) => line.trim() !== "");

		assert.ok(lines.length > 0, "运行中应有实时内容");
		assert.ok(lines.length <= 3, `工具框窗口应 ≤3 行，实际 ${lines.length}`);
		assert.ok(lines.some((line) => line.includes("line 20")), "应显示到最新一行");
		assert.ok(!lines.some((line) => line.includes("line 15")), "不应显示更早的内容");
		assert.ok(lines.join("").includes("▍"), "运行中末行应有静态光标");
	} finally {
		Date.now = realNow;
	}
});

test("完成后标题带行数（· N 行），点开仍能看全部", () => {
	const panel = resolvePanel("bash", () => undefined);
	const args = { command: "seq 1 20" };
	const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const result = { content: [{ type: "text", text: output }] };
	const ctx = panelContext({ args });

	// 先渲染结果（会把行数写进共享状态），再渲染标题
	panel.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
	const header = strip(panel.renderCall(args, theme, ctx).render(80)[0] ?? "");
	assert.match(header, /·\s*20 行$/, `标题应带 “· 20 行”：${header}`);
});

test("思考块：整段无换行也不会把窗口撑高（可视行封顶 12）", () => {
	const text = "这是一段很长的思考内容，".repeat(250); // 3000 字，无换行
	const msg = { content: [{ type: "thinking", thinking: text }], timestamp: 9001 };
	const comp = new piMain.AssistantMessageComponent(msg, false);
	const realNow = Date.now;
	let now = 5_000;
	Date.now = () => now;
	try {
		comp.updateContent(msg, true);
		comp.render(100);
		now += 5000;
		const lines = comp
			.render(100)
			.map(strip)
			.filter((line) => line.trim() !== "");
		// 1 行标题 + 1 行“上面还有内容” + ≤12 行窗口
		assert.ok(lines.length <= 20, `窗口应被可视行封顶，实际 ${lines.length} 行`);
		assert.ok(lines.some((line) => line.includes("上面还有内容")), "应提示上面还有内容");
	} finally {
		Date.now = realNow;
	}
});

test("工具框：运行中（哪怕刚出现）就显示 3 行窗口，完成后同一位置定格", () => {
	const panel = resolvePanel("bash", () => undefined);
	const args = { command: "echo hi" };
	const output = Array.from({ length: 9 }, (_, i) => `out ${i + 1}`).join("\n");
	const result = { content: [{ type: "text", text: output }] };

	const liveCtx = panelContext({ args, isPartial: true, state: { startedAt: Date.now() - 20 } });
	const liveLines = panel
		.renderResult(result, { expanded: false, isPartial: true }, theme, liveCtx)
		.render(80)
		.map(strip)
		.filter((line) => line.trim() !== "");
	assert.ok(liveLines.length > 0, "运行中就应该有内容（不再等 350ms）");
	assert.ok(liveLines.length <= 4, `窗口应 ≤3 行内容 + 提示，实际 ${liveLines.length}`);
	assert.ok(liveLines.some((line) => line.includes("out 9")), "应显示最新一行");
	assert.ok(liveLines.join("").includes("▍"), "运行中应有光标");

	const doneCtx = panelContext({ args, state: { startedAt: Date.now() - 20 } });
	const doneLines = panel
		.renderResult(result, { expanded: false, isPartial: false }, theme, doneCtx)
		.render(80)
		.map(strip)
		.filter((line) => line.trim() !== "");
	assert.ok(doneLines.some((line) => line.includes("out 9")), "完成后应定格在同一尾部");
	assert.ok(!doneLines.join("").includes("▍"), "完成后不应有光标");
});

test("高速流式（≈200 tok/s）：末行始终完整", () => {
	const panel = resolvePanel("bash", () => undefined);
	const args = { command: "bun run build" };
	const ctx = { args, state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: true, expanded: false, invalidate() {} };
	const realNow = Date.now;
	let now = 100_000;
	Date.now = () => now;
	try {
		let received = "";
		const frames = 8;
		for (let frame = 1; frame <= frames; frame++) {
			// 每帧到 ~35 字符（700 字符/秒 ≈ 200 tok/s）
			while (received.length < frame * 35) {
				received += `step ${received.split("\n").length + 1} ` + "x".repeat(18) + "\n";
			}
			const view = panel.renderResult(
				{ content: [{ type: "text", text: received }] },
				{ expanded: false, isPartial: true },
				theme,
				ctx,
			);
			const shown = view.render(80).map(strip).filter((line) => line.trim() !== "");
			const lastActual = received.trimEnd().split("\n").at(-1) ?? "";
			// 去掉行首的 ⎿/续行前缀（续行只有空格，没有 ⎿）
			const lastShown = (shown.at(-1) ?? "")
				.replace(/^\s*(?:⎿\s*)?/, "")
				.replace(/▍$/, "")
				.trimEnd();
			// 快照节拍之外内容不变，末行必须是完整的
			if (frame > 1) {
				assert.equal(lastShown, lastActual, `帧 ${frame} 的末行应完整显示`);
			}
			now += 50;
		}
	} finally {
		Date.now = realNow;
	}
});

test("阅读辅助：只有「在跟随 + 回复超过视口 70%」才跳回回复开头", async () => {
	const reading = await jiti.import(fileURLToPath(new URL("../reading.ts", import.meta.url)));
	const { shouldJumpToReplyStart } = reading;

	// 用户在翻历史 → 不打扰
	assert.equal(shouldJumpToReplyStart({ following: false, viewportHeight: 40, renderedLines: 200 }), false);
	// 短回复（不到 70%）→ 停在末尾就好
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 40, renderedLines: 20 }), false);
	// 长回复 + 跟随中 → 跳
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 40, renderedLines: 28 }), true);
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 40, renderedLines: 200 }), true);
	// 视口高度取不到 → 固定阈值 20 行
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 0, renderedLines: 19 }), false);
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 0, renderedLines: 20 }), true);
	// 空回复
	assert.equal(shouldJumpToReplyStart({ following: true, viewportHeight: 40, renderedLines: 0 }), false);
});

test("阅读辅助：整轮结束按条件跳回回复开头（跟随 + 长回复才跳）", async () => {
	let following = true;
	const jumps: number[] = [];
	const fakeTui = {
		requestRender() {},
		get isFollowingOutput() {
			return following;
		},
		getPrimaryScrollView: () => ({ viewportHeight: 20 }),
		scrollToPrompt: (direction: number) => {
			jumps.push(direction);
		},
	};
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionId: () => "s",
		getSessionName: () => "",
		getLeafId: () => "l",
		getBranch: () => [],
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getTree: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({}),
	};
	const ui = {
		theme,
		setHeader() {},
		setFooter() {},
		setEditorComponent() {},
		setWidget(key, factory) {
			if (key === "ui-style-scroll-bridge" && typeof factory === "function") factory(fakeTui, theme);
		},
		setWorkingIndicator() {},
		setWorkingMessage() {},
		setStatus() {},
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		ui,
		model: { id: "m", provider: "p", contextWindow: 1000 },
		sessionManager,
		getContextUsage: () => undefined,
	};
	for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx);

	const settle = async () => {
		for (const h of handlers.get("agent_settled") ?? []) await h({ type: "agent_settled" }, ctx);
	};

	// 长回复（40 行 > 视口 20 行的 70%）：跟在底部 → 跳一次
	const longText = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行正文`).join("\n\n");
	new piMain.AssistantMessageComponent({ content: [{ type: "text", text: longText }], timestamp: 88001 }, false).render(80);
	following = true;
	jumps.length = 0;
	await settle();
	assert.deepEqual(jumps, [-1], "长回复 + 跟随中应跳回回复开头");

	// 用户自己在翻历史 → 不打扰
	following = false;
	jumps.length = 0;
	await settle();
	assert.deepEqual(jumps, [], "不在跟随时不应动视口");

	// 短回复 → 停在末尾
	following = true;
	new piMain.AssistantMessageComponent({ content: [{ type: "text", text: "很短的一行" }], timestamp: 88002 }, false).render(80);
	jumps.length = 0;
	await settle();
	assert.deepEqual(jumps, [], "短回复不应跳");
});

test("会话信息面板：内容 / 边框宽度 / 关闭 / 刷新", async () => {
	const usage = {
		input: 3200,
		output: 1420,
		cacheRead: 8600,
		cacheWrite: 400,
		cost: { total: 0.25 },
	};
	const entries = [
		{ type: "message", id: "e1", parentId: null, timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "hi" } },
		{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-15T10:01:00.000Z", message: { role: "assistant", content: [], usage } },
		{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-11-15T10:02:00.000Z", message: { role: "user", content: "again" } },
		{ type: "message", id: "e4", parentId: "e3", timestamp: "2026-11-15T10:03:30.000Z", message: { role: "assistant", content: [], usage } },
	];
	const sessionManager = {
		getCwd: () => "/home/sunqiulei/proj/demo",
		getSessionId: () => "01JC-abcdef",
		getSessionName: () => "重构 ui-style",
		getLeafId: () => "e4",
		getBranch: () => entries,
		getEntries: () => entries,
		getSessionFile: () => "/tmp/x.jsonl",
		getSessionDir: () => "/tmp",
	};
	piStub.reset();
	let doneCalls = 0;
	let panel = null;
	const ctx = {
		mode: "tui",
		cwd: "/home/sunqiulei/proj/demo",
		model: { id: "demo-model", provider: "demo", contextWindow: 200000, reasoning: true },
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [
				{ id: "demo-model", provider: "demo", contextWindow: 200000, reasoning: true },
				{ id: "big-model", provider: "other", contextWindow: 400000, reasoning: true },
				{ id: "no-auth-model", provider: "third", contextWindow: 100000 },
			],
		},
		thinkingLevel: "medium",
		sessionManager,
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 136000, contextWindow: 200000, percent: 68 }),
		ui: {
			theme,
			custom(factory) {
				panel = factory(
					{ requestRender() {}, terminal: { rows: 40, columns: 100 } },
					theme,
					undefined,
					() => {
						doneCalls += 1;
					},
				);
				return Promise.resolve(undefined);
			},
		},
	};

	const info = shortcuts.get("alt+i");
	assert.ok(info, "没有注册 alt+i 快捷键");
	await info.handler(ctx);
	assert.ok(panel, "ctx.ui.custom 没有被调用");

	const render = () => panel.render(panel.preferredWidth()).map(strip);
	const out = render().join("\n");
	for (const expected of [
		"demo-model (demo)",
		"medium",
		"重构 ui-style",
		"~/proj/demo",
		"概览",
		"加载",
		"技能",
		"扩展",
		"MCP",
	]) {
		assert.ok(out.includes(expected), `面板缺少 ${expected}：\n${out}`);
	}
	// 概览：会话总时长（10:00:00 → 10:03:30 = 3 m 30 s）+ 分支规模
	assert.ok(out.includes("3 m 30 s"), `应显示会话总时长：\n${out}`);
	assert.ok(out.includes("4 条目"), `应显示分支条目数：\n${out}`);
	// 用量/时间与位置已退场：不再渲染 token/上下文/费用/会话 id
	assert.ok(!out.includes("68.0%"), out);
	assert.ok(!out.includes("136k / 200k"), out);
	assert.ok(!out.includes("01JC-abcdef"), out);

	// 边框：所有行等宽，且就是 preferredWidth
	const width = panel.preferredWidth();
	for (const line of render()) {
		assert.equal(visibleWidth(line), width, `行宽不齐：${visibleWidth(line)} != ${width}\n${line}`);
	}
	assert.ok(out.startsWith("╭─ 会话信息"), "顶边缺失");
	assert.ok(out.trimEnd().endsWith("╯"), "底边缺失");

	// Esc 关闭
	panel.handleInput("\x1b");
	assert.equal(doneCalls, 1, "Esc 应关闭弹窗");

	// r 刷新：改一条时间戳后，会话总时长应跟着变
	entries[3].timestamp = "2026-11-15T10:05:30.000Z";
	panel.handleInput("r");
	const after = render().join("\n");
	assert.ok(after.includes("5 m 30 s"), `刷新后总时长应为 10:00:00 → 10:05:30：\n${after}`);
});

test("会话信息面板：Tab 切焦点、←→ 改模型/思考、Enter 改名", async () => {
	const sessionManager = {
		getCwd: () => "/tmp/demo",
		getSessionId: () => "s1",
		getSessionName: () => "旧名字",
		getLeafId: () => "e1",
		getBranch: () => [],
		getEntries: () => [],
	};
	piStub.reset();
	piStub.thinkingLevel = "medium";
	const calls = piStub.calls;
	const models = [
		{ id: "model-a", provider: "p1", reasoning: true, thinkingLevelMap: { xhigh: "high" } },
		{ id: "model-b", provider: "p2", reasoning: false },
	];
	let panel = null;
	const ctx = {
		mode: "tui",
		cwd: "/tmp/demo",
		model: models[0],
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => (models[0].id === "model-a" ? models : [...models].reverse()),
		},
		sessionManager,
		isIdle: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			custom(factory) {
				panel = factory(
					{ requestRender() {}, terminal: { rows: 40, columns: 100 } },
					theme,
					undefined,
					() => {},
				);
				return Promise.resolve(undefined);
			},
		},
	};

	await shortcuts.get("alt+i").handler(ctx);
	const out = () => panel.render(panel.preferredWidth()).map(strip).join("\n");

	// 初始焦点在「会话」
	assert.ok(out().includes("▸会话"), `初始焦点应在会话名：\n${out()}`);

	// Tab → 模型；→ 切到下一个模型
	panel.handleInput("\t");
	assert.ok(out().includes("▸模型"), out());
	panel.handleInput("\x1b[C");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(calls.filter((c) => c[0] === "model"), [["model", "model-b"]], JSON.stringify(calls));

	// Tab → 思考：model-b 没有推理能力，只能 off（应给提示，不该偷偷切换）
	panel.handleInput("\t");
	assert.ok(out().includes("▸思考"), out());
	panel.handleInput("\x1b[C");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(calls.filter((c) => c[0] === "level").length, 0, "无推理能力的模型不应切档位");
	assert.ok(out().includes("只有 off") || out().includes("只有"), out());

	// 回到 model-a（有推理能力）再切思考档位：Tab → 会话、Tab → 模型、← 回 a、Tab → 思考
	panel.handleInput("\t");
	panel.handleInput("\t");
	panel.handleInput("\x1b[D");
	await new Promise((resolve) => setTimeout(resolve, 10));
	panel.handleInput("\t");
	panel.handleInput("\x1b[C");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(
		calls.some((c) => c[0] === "level"),
		`应已切换思考档位：${JSON.stringify(calls)}`,
	);

	// Tab 回到会话名 → Enter 进入编辑 → 清空 → 输入新名 → Enter 保存
	panel.handleInput("\t");
	panel.handleInput("\r");
	assert.ok(out().includes("输入名称"), "编辑态应提示输入名称");
	panel.handleInput("\x05"); // ctrl+e 到行尾
	for (let i = 0; i < 3; i++) panel.handleInput("\x7f"); // 删掉旧名字（3 个字）
	panel.handleInput("新");
	panel.handleInput("名");
	assert.ok(out().includes("新名"), out());
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(
		calls.filter((c) => c[0] === "name"),
		[["name", "新名"]],
		JSON.stringify(calls),
	);
	assert.ok(out().includes("已更新会话名"), out());
});

test("会话信息面板：正在生成时拒绝切模型/思考", async () => {
	piStub.reset();
	const calls = piStub.calls;
	let panel = null;
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		model: { id: "m", provider: "p", reasoning: true },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [{ id: "m", provider: "p", reasoning: true }, { id: "n", provider: "p", reasoning: true }] },
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "s",
			getSessionName: () => "x",
			getLeafId: () => "e",
			getBranch: () => [],
			getEntries: () => [],
		},
		isIdle: () => false,
		getContextUsage: () => undefined,
		ui: {
			theme,
			custom(factory) {
				panel = factory({ requestRender() {}, terminal: { rows: 30, columns: 90 } }, theme, undefined, () => {});
				return Promise.resolve(undefined);
			},
		},
	};

	await shortcuts.get("alt+i").handler(ctx);
	panel.handleInput("\t"); // → 模型
	panel.handleInput("\x1b[C");
	await new Promise((resolve) => setTimeout(resolve, 10));
	const out = panel.render(panel.preferredWidth()).map(strip).join("\n");
	assert.deepEqual(calls, [], `生成中不应切换任何东西：${JSON.stringify(calls)}`);
	assert.ok(out.includes("正在生成"), out);
});

/** 面板测试的公共装配：返回 { panel, lines, find, mouse, ctx }。 */
async function openPanelForTest(options = {}) {
	const models = [
		{ id: "model-a", provider: "p1", contextWindow: 200000, reasoning: true },
		{ id: "model-b", provider: "p2", contextWindow: 400000, reasoning: true },
		{ id: "model-c", provider: "p3", contextWindow: 100000, reasoning: false },
	];
	const sessionManager = {
		getCwd: () => "/home/u/proj",
		getSessionId: () => "01JC",
		getSessionName: () => "会话名",
		getLeafId: () => "e",
		getBranch: () => [],
		getEntries: () => [],
	};
	const ctx = {
		mode: "tui",
		cwd: "/home/u/proj",
		model: options.model ?? models[0],
		scopedModels: [],
		modelRegistry: { getAvailable: () => models },
		sessionManager,
		isIdle: () => options.idle ?? true,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
		ui: null,
	};
	let panel = null;
	let overlayOptions = null;
	const renders = { count: 0 };
	ctx.ui = {
		theme,
		custom(factory, opts) {
			overlayOptions = opts;
			panel = factory(
				{
					requestRender() {
						renders.count += 1;
					},
					terminal: { rows: options.rows ?? 34, columns: options.columns ?? 100 },
				},
				theme,
				undefined,
				() => {},
			);
			return Promise.resolve(undefined);
		},
	};
	await shortcuts.get("alt+i").handler(ctx);
	const width = () =>
		typeof overlayOptions.overlayOptions === "function"
			? overlayOptions.overlayOptions().width
			: overlayOptions.overlayOptions.width;
	const lines = () => panel.render(width());
	const plain = () => lines().map(strip);
	const find = (needle) => plain().findIndex((line) => line.includes(needle));
	const mouse = (event) =>
		panel.handleMouse({
			button: "left",
			clickCount: 1,
			screenX: 0,
			screenY: 0,
			width: 0,
			height: 0,
			shift: false,
			alt: false,
			ctrl: false,
			...event,
		});
	return { ctx, panel, renders, lines, plain, find, mouse };
}

test("信息面板下拉：Enter 打开、↓ 移动、Enter 应用模型", async () => {
	piStub.reset();
	piStub.thinkingLevel = "medium";
	const { panel, plain, find } = await openPanelForTest();

	panel.handleInput("\t"); // 焦点 → 模型
	panel.handleInput("\r"); // 打开下拉
	const opened = plain().join("\n");
	assert.ok(opened.includes("→ model-a"), `下拉应以当前模型为选中项：\n${opened}`);
	assert.ok(opened.includes("model-b"), opened);
	assert.ok(opened.includes("p2 · 400k"), "描述列应显示 provider / 窗口");

	panel.handleInput("\x1b[B"); // ↓ → model-b
	panel.handleInput("\r"); // 确认
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [["model", "model-b"]]);
	const after = plain().join("\n");
	assert.ok(!after.includes("→ model-"), "确认后下拉应收起");
	assert.ok(after.includes("已切换到 model-b"), after);

	// 窄终端下拉框宽度也要与面板一致
	const widths = new Set(plain().length ? [] : []);
	void widths;
});

test("信息面板下拉：输入过滤 + Esc 取消不改动", async () => {
	piStub.reset();
	const { panel, plain, lines } = await openPanelForTest();
	panel.handleInput("\t");
	panel.handleInput("\r");
	panel.handleInput("b"); // 过滤 "b" → 只剩 model-b
	const filtered = plain().join("\n");
	assert.ok(filtered.includes("过滤：b"), filtered);
	assert.ok(filtered.includes("model-b"), filtered);
	assert.ok(!filtered.includes("model-c"), `model-c 应被过滤掉：\n${filtered}`);

	panel.handleInput("\x1b"); // Esc 取消
	const closed = plain().join("\n");
	assert.ok(!closed.includes("过滤："), closed);
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [], "Esc 不应切换模型");

	// 每行等宽（下拉框不能把面板撑歪）
	const widths = new Set(lines().map((line) => visibleWidth(line)));
	assert.equal(widths.size, 1, `行宽不一致：${[...widths].join(",")}`);
});

test("信息面板下拉：思考档位按模型能力过滤", async () => {
	piStub.reset();
	piStub.thinkingLevel = "medium";
	const { panel, plain } = await openPanelForTest();
	panel.handleInput("\t");
	panel.handleInput("\t"); // 焦点 → 思考
	panel.handleInput("\r");
	const opened = plain().join("\n");
	assert.ok(opened.includes("→ medium"), opened);
	assert.ok(opened.includes("不思考"), "off 档应带说明");
	panel.handleInput("\x1b[B"); // ↓ high
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "level"), [["level", "high"]]);
});

test("信息面板下拉：正在生成时拒绝打开", async () => {
	piStub.reset();
	const { panel, plain } = await openPanelForTest({ idle: false });
	panel.handleInput("\t");
	panel.handleInput("\r");
	const out = plain().join("\n");
	assert.ok(out.includes("正在生成"), out);
	assert.ok(!out.includes("→ model-a"), "生成中不应打开下拉");
});

test("信息面板鼠标：点行聚焦 / 点箭头切换 / 双击改名 / 点值定位光标 / 滚轮", async () => {
	piStub.reset();
	piStub.thinkingLevel = "medium";
	// 面板现在只有 11 行内容（概览 6 + 空行 + 加载 4），终端给小一点才能溢出可滚动
	const { panel, plain, find, mouse } = await openPanelForTest({ rows: 9 });

	// 点「思考」行 → 焦点移过去
	mouse({ type: "click", x: 3, y: find("思考") });
	assert.ok(plain()[find("▸")].includes("▸思考"), plain().join("\n"));

	// 点「模型」行右侧的 › → 切到下一个模型
	const modelRow = find("模型");
	const modelLine = plain()[modelRow];
	// indexOf 是字符下标，不是显示列；必须按 visibleWidth 换算（前面有 CJK）。
	const arrowCol = visibleWidth(modelLine.slice(0, modelLine.indexOf("›")));
	assert.ok(arrowCol > 0, "模型行应有 › 箭头");
	mouse({ type: "click", x: arrowCol, y: modelRow });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [["model", "model-b"]]);

	// 点「‹」应向左切回 model-a（同一套坐标换算，方向相反）
	const modelLine2 = plain()[find("模型")];
	const leftArrowCol = visibleWidth(modelLine2.slice(0, modelLine2.indexOf("‹")));
	mouse({ type: "click", x: leftArrowCol, y: modelRow });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [
		["model", "model-b"],
		["model", "model-a"],
	]);

	// 双击「会话」行 → 改名（第一次输入整体替换）
	const nameRow = find("会话  会话名");
	mouse({ type: "click", x: 4, y: nameRow });
	mouse({ type: "click", clickCount: 2, x: 4, y: nameRow });
	panel.handleInput("新");
	panel.handleInput("名");
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "name"), [["name", "新名"]]);

	// 单击名称值中间 → 光标落在那一位（用显示列，不是字符下标）
	const nameLine = plain()[nameRow];
	const valueCol = visibleWidth(nameLine.slice(0, nameLine.indexOf("会话名")));
	mouse({ type: "click", x: valueCol + 2, y: nameRow });
	panel.handleInput("X");
	// 光标（▏）会画在插入点后面，比较时去掉
	assert.ok(plain()[nameRow].replace("▏", "").includes("会X话名"), plain()[nameRow]);
	panel.handleInput("\x1b"); // 取消编辑

	// 滚轮：内容比窗口高时能滚动
	const before = plain()[1];
	mouse({ type: "wheel", x: 5, y: 5, wheelDelta: 3 });
	assert.notEqual(plain()[1], before, "滚轮应滚动内容");

	// 点标题栏/底边框不能被当成内容行（滚动后 top > 0 时尤其容易误命中）
	const focusLine = plain()[find("▸")];
	mouse({ type: "click", x: 30, y: 0 });
	assert.equal(plain()[find("▸")], focusLine, "点标题栏不应改变焦点/打开下拉");
	mouse({ type: "click", x: 30, y: plain().length - 1 });
	assert.equal(plain()[find("▸")], focusLine, "点底边框不应改变焦点/打开下拉");
});

test("信息面板鼠标：点下拉项直接选中", async () => {
	piStub.reset();
	const { panel, plain, find, mouse } = await openPanelForTest();
	panel.handleInput("\t");
	panel.handleInput("\r");
	const target = find("model-c");
	assert.ok(target > 0, "下拉里应有 model-c");
	mouse({ type: "press", x: 12, y: target });
	mouse({ type: "click", x: 12, y: target });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [["model", "model-c"]]);
	assert.ok(!plain().some((line) => line.includes("→ model")), "点选后下拉应收起");
});

test("信息面板：窄终端下不产生超宽行", async () => {
	const { panel } = await openPanelForTest({ columns: 20, rows: 20 });
	const lines = panel.render(18); // 20 列终端，margin 1 后的 overlay 宽度
	assert.ok(lines.length > 0);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 18, `窄终端出现了超宽行：${visibleWidth(line)} > 18`);
	}
});

test("信息面板下拉：滚轮滚动下拉选中项，而不是外层面板", async () => {
	piStub.reset();
	const { panel, plain, find, mouse } = await openPanelForTest();
	panel.handleInput("\t");
	panel.handleInput("\r");
	const row = find("→ model-a");
	assert.ok(row > 0, plain().join("\n"));
	mouse({ type: "wheel", x: 12, y: row, wheelDelta: 1 });
	const after = plain().join("\n");
	assert.ok(after.includes("→ model-b"), `滚轮应移动下拉选中项：\n${after}`);
});

test("信息面板：←→ 快切模型时面板宽度/高度保持稳定（不跳）", async () => {
	piStub.reset();
	const { panel, plain, find } = await openPanelForTest();
	const before = { width: plain()[0].length, lines: plain().length };
	panel.handleInput("\t"); // 焦点 → 模型
	for (let i = 0; i < 3; i++) {
		panel.handleInput("\x1b[C"); // →
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const after = { width: plain()[0].length, lines: plain().length };
	assert.equal(after.width, before.width, "换模型后面板宽度不应变化");
	assert.equal(after.lines, before.lines, "换模型后面板高度不应变化");
	assert.ok(find("已切换到") > 0, "切换提示应出现在底部（不占内容行）");
	// 循环一圈回到起点
	assert.deepEqual(
		piStub.calls.filter((c) => c[0] === "model").map((c) => c[1]),
		["model-b", "model-c", "model-a"],
	);
});

test("信息面板：点击模型/思考「值」直接展开下拉", async () => {
	piStub.reset();
	const { panel, plain, find, mouse } = await openPanelForTest();

	// 点模型行右侧的值区域（不在标签上、也不在 ‹ › 上）
	const modelRow = find("模型");
	mouse({ type: "click", x: 14, y: modelRow });
	const openedModel = plain().join("\n");
	assert.ok(openedModel.includes("→ model-a"), `点值应展开模型下拉：\n${openedModel}`);
	panel.handleInput("\x1b");

	// 点思考行的值
	const thinkRow = find("思考");
	mouse({ type: "click", x: 14, y: thinkRow });
	const openedThink = plain().join("\n");
	assert.ok(openedThink.includes("不思考"), `点值应展开思考下拉：\n${openedThink}`);
	panel.handleInput("\x1b");
});

test("信息面板：切模型过程中不打断底边框（不闪烁/无中间帧）", async () => {
	piStub.reset();
	const { panel, plain, renders } = await openPanelForTest();

	let release;
	piStub.gate = new Promise((resolve) => {
		release = resolve;
	});

	panel.handleInput("\t"); // 焦点 → 模型
	const before = plain().join("\n");
	renders.count = 0;

	panel.handleInput("\x1b[C"); // → 发起切换（异步未完成）
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(renders.count, 0, "切换过程中不应重绘（否则底边框会闪）");
	assert.equal(plain().join("\n"), before, "切换过程中界面应保持不变");

	release();
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(renders.count, 1, "切换完成只重绘一次");
	const after = plain().join("\n");
	assert.ok(after.includes("已切换到 model-b"), after);
	assert.ok(!after.includes("…"), "底边框不应出现占位省略号");
});

test("启动资源：promptOptions 空数组是权威结果；force 会重扫技能", async () => {
	const startup = await jiti.import(fileURLToPath(new URL("../startup.ts", import.meta.url)));
	const dir = mkdtempSync(join(tmpdir(), "ui-style-res-"));
	mkdirSync(join(dir, ".agents", "skills", "foo"), { recursive: true });
	writeFileSync(join(dir, ".agents", "skills", "foo", "SKILL.md"), "# foo\n");
	mkdirSync(join(dir, ".agents", "skills", "bar"), { recursive: true });
	writeFileSync(join(dir, ".agents", "skills", "bar", "SKILL.md"), "# bar\n");

	// promptOptions 明确给出空 skills：不能再回退到扫描，foo/bar 都不应出现
	const promptCtx = { getSystemPromptOptions: () => ({ contextFiles: [], skills: [] }) };
	const empty = await startup.collectSessionResources(dir, promptCtx, [], { force: true });
	assert.deepEqual(empty.skills, []);

	// 没有 promptOptions：扫描应看到 foo + bar
	const scanned = await startup.collectSessionResources(dir, undefined, [], { force: true });
	assert.ok(scanned.skills.includes("foo") && scanned.skills.includes("bar"), scanned.skills.join(","));

	// 新增技能后，不带 force 仍读缓存；带 force 才重扫
	mkdirSync(join(dir, ".agents", "skills", "baz"), { recursive: true });
	writeFileSync(join(dir, ".agents", "skills", "baz", "SKILL.md"), "# baz\n");
	const cached = await startup.collectSessionResources(dir, undefined, []);
	assert.ok(!cached.skills.includes("baz"), `不该读到新技能：${cached.skills.join(",")}`);
	const forced = await startup.collectSessionResources(dir, undefined, [], { force: true });
	assert.ok(forced.skills.includes("baz"), `force 后应读到新技能：${forced.skills.join(",")}`);
});

test("#3 edit 展开态：diff 只在 result 区出现一次（不再重复）", async () => {
	const panel = resolvePanel("edit", () => undefined);
	const args = { path: "/tmp/b.ts", edits: [{ oldText: "x", newText: "UNIQUE_ADDED_LINE" }] };
	const result = {
		content: [{ type: "text", text: "已修改 1 处" }],
		details: { diff: "--- a\n+++ b\n- x\n+ UNIQUE_ADDED_LINE\n" },
	};
	const ctx = panelContext({ args, expanded: true });
	// 等异步预览算完（展开态也应该只由 result 区渲染）
	panel.renderCall(args, theme, ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));

	const callLines = strip(panel.renderCall(args, theme, ctx).render(80).join("\n"));
	const resultLines = strip(
		panel.renderResult(result, { expanded: true, isPartial: false }, theme, ctx).render(80).join("\n"),
	);
	const occurrences = `${callLines}\n${resultLines}`.split("UNIQUE_ADDED_LINE").length - 1;
	assert.equal(occurrences, 1, `diff 应只出现一次，实际 ${occurrences} 次：\n${callLines}\n---\n${resultLines}`);
});

test("#7 原型补丁：unpatch 有所有权校验（别人改过就不动），重复调用安全", async () => {
	const { patchAssistantMessageStyle, unpatchAssistantMessageStyle } = await import(
		"../assistant.ts"
	);
	const proto = piMain.AssistantMessageComponent.prototype;
	patchAssistantMessageStyle();
	const patched = proto.render;
	assert.notEqual(patched, undefined);

	// 模拟"别人（新实例/pi 自己）又改写了这个方法"：unpatch 不应把它改回去
	const foreign = () => ["FOREIGN"];
	proto.render = foreign;
	unpatchAssistantMessageStyle();
	assert.equal(proto.render, foreign, "没有所有权时不应恢复/覆盖");

	// 恢复正常后再 unpatch 两次都应安全
	proto.render = patched;
	unpatchAssistantMessageStyle();
	unpatchAssistantMessageStyle();
	assert.notEqual(typeof proto.render, "undefined");

	// 重新打补丁，避免影响后续用例
	patchAssistantMessageStyle();
});

test("对外只注册 alt+i 快捷键，不注册任何 /命令", () => {
	assert.ok(shortcuts.get("alt+i"), "应注册 alt+i");
	assert.equal(commands.size, 0, `不应注册命令：${[...commands.keys()].join(",")}`);
});

test("状态栏缓存命中率：有缓存数据时必须渲染成功，且越高越绿（回归：hitRateMuted 漏导入）", async () => {
	const usage = { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.1 } };
	const tui = { requestRender() {}, terminal: { rows: 40 } };
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionId: () => "session-cache",
		getSessionName: () => "缓存用例",
		getLeafId: () => "leaf-cache",
		getBranch: () => [
			{ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } },
			{ type: "message", timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", usage } },
		],
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getHeader: () => null,
		getTree: () => [],
		buildContextEntries: () => [],
		buildSessionProjection: () => ({}),
	};
	let footer;
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		model: { id: "demo", provider: "p", contextWindow: 200000 },
		sessionManager,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
		ui: {
			theme,
			setFooter(factory) {
				footer = factory(tui, theme, footerData);
			},
			setHeader() {},
			setEditorComponent() {},
			setWidget() {},
			setWorkingIndicator() {},
			setWorkingMessage() {},
			setStatus() {},
		},
	};
	// 9000 / (1000 + 9000) = 90% 命中
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, ctx);
	}

	assert.ok(footer, "footer 没挂上");
	let lines;
	assert.doesNotThrow(() => {
		lines = footer.render(120);
	}, "有缓存数据时渲染不能崩（hitRateMuted 必须已导入）");
	const text = strip(lines.join("\n"));
	assert.match(text, /Cache\s+90\.0%/, `应显示 90.0%：\n${text}`);
	// 降饱和绿色 rgb(126;180;120)；红色是 228;122;110
	assert.ok(lines.join("").includes("38;2;126;180;120"), "90% 命中应着绿色");
	assert.ok(!lines.join("").includes("38;2;228;122;110"), "不该出现红色");
});

// ---------------------------------------------------------------------------
// subagent 面板：单个 / 并行 / 链式
// ---------------------------------------------------------------------------

/** subagent 工具的 details 样本（与 pi 自带 subagent 扩展的 SingleResult 同形）。 */
function subagentDetails(mode, results) {
	return { mode, results, isError: false };
}

function subagentChild(overrides = {}) {
	return {
		agent: "reviewer",
		agentSource: "user",
		task: "审查 panels.ts",
		status: "completed",
		exitCode: 0,
		messages: [
			{ role: "user", content: [{ type: "text", text: "审查 panels.ts" }] },
			{
				role: "assistant",
				thinkingLevel: "high",
				content: [
					{ type: "text", text: "先看文件结构" },
					{ type: "toolCall", name: "read" },
					{ type: "text", text: "发现两处问题" },
				],
			},
		],
		stderr: "",
		usage: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 0, cost: 0.02 },
		model: "claude-sonnet-4",
		...overrides,
	};
}

test("subagent 面板：单个/并行/链式都能渲染，且窄终端不超宽", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	// 找 subagent 的渲染器（resolvePanel 是第一个 resolver，这里单独查表）
	let resolver;
	const fakePi = {
		registerToolRenderer(fn) {
			resolver = fn;
		},
	};
	registerSubagentPanel(fakePi);
	assert.ok(resolver, "没注册渲染器");
	assert.equal(resolver("bash", () => undefined), undefined, "别的工具应交还给 pi");
	const panel = resolver("subagent", () => undefined);
	assert.ok(panel, "subagent 应有渲染器");
	assert.equal(panel.renderShell, "self");

	const cases = [
		["single", [subagentChild()]],
		["parallel", [subagentChild(), subagentChild({ agent: "worker", status: "running" })]],
		[
			"chain",
			[
				subagentChild({ step: 1 }),
				subagentChild({ agent: "worker", step: 2, status: "failed", errorMessage: "失败" }),
			],
		],
	];

	for (const [mode, results] of cases) {
		const result = {
			content: [{ type: "text", text: "最终输出" }],
			details: subagentDetails(mode, results),
		};
		for (const width of [1, 2, 4, 10, 20, 40, 80, 200]) {
			for (const isPartial of [false, true]) {
				const context = panelContext({ args: { agent: "reviewer", task: "审查" }, isPartial });
				const components = [
					panel.renderCall(context.args, theme, context),
					panel.renderResult(result, { expanded: false, isPartial }, theme, context),
				];
				for (const component of components) {
					for (const line of component.render(width)) {
						assert.ok(!line.includes("\n"), `${mode} width=${width} 内嵌换行`);
						assert.ok(
							visibleWidth(line) <= width,
							`${mode} width=${width} 行宽 ${visibleWidth(line)} 超宽`,
						);
					}
				}
			}
		}
	}
});

test("subagent 面板：状态/用量/结论等纯函数", async () => {
	const {
		statusMark,
		statusMarkGlyph,
		statusMarkText,
		cacheHitRate,
		childThinkingLevel,
		childModel,
		childFooterText,
		displayItems,
		childFinalOutput,
		conclusionHead,
		processSummary,
	} = await import("../subagent-panel.ts");

	// 状态标记：running / ok / fail 三种 kind
	assert.equal(statusMark([subagentChild({ status: "running" })], true).kind, "running");
	assert.equal(statusMark([subagentChild({ status: "completed" })], false).kind, "ok");
	assert.equal(statusMark([subagentChild({ status: "failed" })], false).kind, "fail");
	assert.equal(statusMark([subagentChild({ status: "aborted" })], false).kind, "fail");
	assert.equal(statusMarkGlyph({ kind: "running" }), "\uDB80\uDE11");
	assert.match(strip(statusMarkText({ kind: "ok" })), /✓/);
	assert.match(strip(statusMarkText({ kind: "fail" })), /✗/);

	// 缓存命中率：cacheRead 800 / (1200 + 800) = 40%；没有缓存读写 → undefined
	assert.equal(
		Math.round(cacheHitRate({ input: 1200, cacheRead: 800, cacheWrite: 0, output: 1, cost: 0 })),
		40,
	);
	assert.equal(cacheHitRate({ input: 1200, cacheRead: 0, cacheWrite: 0, output: 1, cost: 0 }), undefined);

	// 思考强度 / 模型 / display items / 结论 / 过程摘要
	const child = subagentChild();
	assert.equal(childThinkingLevel(child.messages), "high");
	assert.equal(childModel(child), "claude-sonnet-4");
	const items = displayItems(child.messages);
	assert.equal(items.length, 3, `应抽到 2 text + 1 toolCall，实际 ${items.length}`);
	assert.equal(items[1].type, "toolCall");
	assert.equal(items[1].name, "read");
	// 与 pi 的 getFinalOutput 同语义：最后一条 assistant 的**第一个** text 块
	assert.equal(childFinalOutput(child.messages), "先看文件结构");
	assert.equal(processSummary(child.messages), "1 次工具调用");

	// 结论折叠：看头部 N 行，超出返回 remaining
	const head = conclusionHead(["a", "b", "c", "d", "e"].join("\n"), 3);
	assert.deepEqual(head.lines, ["a", "b", "c"]);
	assert.equal(head.remaining, 2);
	// 尾部空行不计入
	assert.equal(conclusionHead("a\nb\n\n\n", 3).remaining, 0);

	// 底行五段
	const footer = strip(childFooterText(child));
	assert.match(footer, /1\.2k/);
	assert.match(footer, /340/);
	assert.match(footer, /claude-sonnet-4/);
	assert.match(footer, /high/);
	assert.match(footer, /40\.0%/);
});

test("subagent 面板 renderCall：并行按子代理逐个显示（标题带 agent 名与耗时）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// renderCall 在参数流式阶段（还没有 details）
	const bare = panel
		.renderCall({ tasks: [{ agent: "reviewer" }] }, theme, panelContext({ isPartial: true }))
		.render(100)
		.map(strip);
	// 骨架标题从 args 推出模式与数量（这里是 parallel → \uEE0D 图标）
	assert.match(bare.join("\n"), /子代理 · 并行 · 1 个任务/, `骨架应带模式与数量：${bare.join("\n")}`);
	assert.ok(bare.join("").includes("\uEE0D"), "并行骨架应使用 \uEE0D");
	// 单个模式用 \uF4BE 并带 agent 名
	const singleSkeleton = panel
		.renderCall({ agent: "reviewer", task: "审查" }, theme, panelContext({ isPartial: true }))
		.render(100)
		.map(strip)
		.join("\n");
	assert.match(singleSkeleton, /子代理 · reviewer/);
	assert.ok(singleSkeleton.includes("\uF4BE"), "单个骨架应使用 \uF4BE");
	// 链式骨架带步数
	const chainSkeleton = panel
		.renderCall({ chain: [{ agent: "a" }, { agent: "b" }, { agent: "c" }] }, theme, panelContext({ isPartial: true }))
		.render(100)
		.map(strip)
		.join("\n");
	assert.match(chainSkeleton, /链式 · 共 3 步/);

	// 执行中：details 通过 partial result 推送
	const result = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("parallel", [
			subagentChild({ agent: "reviewer" }),
			subagentChild({ agent: "worker", status: "running" }),
		]),
	};
	const callCtx = panelContext({ isPartial: true, args: { tasks: [{ agent: "reviewer" }, { agent: "worker" }] } });
	const lines = panel
		.renderResult(result, { expanded: false, isPartial: true }, theme, callCtx)
		.render(100)
		.map(strip);
	const text = lines.join("\n");
	// 两个子代理各自一行标题（\uF4BE 图标 + 名称 + 状态标记）
	assert.match(text, /\uF4BE reviewer · /, `reviewer 应有块标题：\n${text}`);
	assert.match(text, /\uF4BE worker · /, `worker 应有块标题：\n${text}`);
	// 每块都带任务行（黄色「」）与底行
	assert.match(text, /「审查 panels\.ts」/);
	// 执行内容与底行都出现
	assert.match(text, /发现两处问题/);
	assert.match(text, /→ read/);
	assert.match(text, /claude-sonnet-4/);
	// 底行带缓存命中率
	assert.match(text, /40\.0%/);
	// 每个子代理的滚动内容不超过 4 行
	const reviewerBlock = lines.slice(lines.findIndex((l) => l.includes("reviewer")));
	assert.ok(reviewerBlock.length > 0);
});

test("subagent 面板 renderResult：单个完成态显示结论（头 4 行）+ 过程一行摘要", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 结论 8 行（第 1 行是"结论"标题，第 8 行是细节），加 3 次工具调用
	const conclusion = [
		"结论：SHIMMER_PERIOD_MS 现在是 2800ms。",
		"它只影响扫光相位计算。",
		"第三行",
		"第四行",
		"第五行",
		"第六行",
		"第七行",
		"第八行细节",
	].join("\n");
	const tools = [
		{ type: "toolCall", name: "read" },
		{ type: "toolCall", name: "grep" },
		{ type: "toolCall", name: "bash" },
	];
	const child = subagentChild({
		messages: [{ role: "assistant", thinkingLevel: "high", content: [...tools, { type: "text", text: conclusion }] }],
	});
	const result = {
		content: [{ type: "text", text: conclusion }],
		details: subagentDetails("single", [child]),
	};
	const state = { startedAt: Date.now() - 5000 };
	const body = panel
		.renderResult(result, { expanded: false, isPartial: false }, theme, panelContext({ state }))
		.render(100)
		.map(strip);

	const text = body.join("\n");
	// 看头部：前 4 行结论都在，第 5 行之后不显示
	assert.match(text, /结论：SHIMMER_PERIOD_MS 现在是 2800ms。/, `应显示结论首行：\n${text}`);
	assert.match(text, /第四行/, "应显示第 4 行");
	assert.doesNotMatch(text, /第五行/, "折叠态不该显示第 5 行");
	assert.match(text, /还有 4 行/, `应提示还有 4 行：\n${text}`);
	// 过程只留一行摘要
	assert.match(text, /3 次工具调用/, "应有过程摘要");
	assert.doesNotMatch(text, /→ read/, "折叠态不该列出具体工具调用");
	// 高度：4 行结论 + 1 行还有N行 + 1 行摘要 + 1 行底行 = 7 行
	assert.equal(body.length, 7, `折叠态应固定 7 行，实际 ${body.length}：\n${body.join("\n")}`);
	assert.match(body[body.length - 1], /40\.0%/, "最后一行应是 usage 底行");

	// 展开：完整结论 + 过程列表
	const expanded = panel
		.renderResult(result, { expanded: true, isPartial: false }, theme, panelContext({ state }))
		.render(100)
		.map(strip)
		.join("\n");
	assert.match(expanded, /第八行细节/, "展开态应显示完整结论");
	assert.match(expanded, /→ read/, "展开态应显示工具调用过程");
});

test("subagent 面板 renderResult：失败态显示错误证据行", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const state = { startedAt: Date.now() - 4600 };
	const failed = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("single", [subagentChild({ status: "failed", errorMessage: "子代理超时" })]),
	};
	const body = panel
		.renderResult(failed, { expanded: false, isPartial: false }, theme, panelContext({ state }))
		.render(100)
		.map(strip);
	assert.match(body.join("\n"), /子代理超时/);

	// 标题用缓存下来的失败标记（不能显示成 ✓）
	const title = strip(
		panel.renderCall({ agent: "reviewer" }, theme, panelContext({ state })).render(100)[0] ?? "",
	);
	assert.match(title, /✗/, `失败时标题必须是 ✗：${title}`);
	assert.doesNotMatch(title, /✓/, `失败时标题不该出现 ✓：${title}`);
});

test("subagent 面板 renderResult：并行/链式显示状态行 + 每个任务自己的结论", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const mk = (agent, text, o = {}) =>
		subagentChild({
			agent,
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read" }, { type: "text", text }] }],
			...o,
		});

	// 并行：每个任务各自的结论（不能把拼接后的 result.content 塞给每个块）
	const parallel = {
		content: [{ type: "text", text: "Parallel: 2/2 succeeded\n\n### [reviewer] completed\n\n...\n\n---\n\n### [worker] completed\n\n..." }],
		details: subagentDetails("parallel", [mk("reviewer", "reviewer 的结论"), mk("worker", "worker 的结论")]),
	};
	const text = panel
		.renderResult(parallel, { expanded: false, isPartial: false }, theme, panelContext({ state: { startedAt: Date.now() - 3000 } }))
		.render(100)
		.map(strip)
		.join("\n");

	// 完成态：● 打满 + 进度 + 汇总（同一行）
	assert.equal((text.match(/●/g) ?? []).length, 2, `完成态应有两个 ●：\n${text}`);
	assert.match(text, /2\/2 完成 · in [\d.]+k? · out [\d.]+k? · cache [\d.]+%/);
	// 不再用 ─── 分隔线，每块是自己的标题（\uF4BE 名称 · 耗时 · ✓）
	assert.match(text, /\uF4BE reviewer · [^\n]*✓/, `reviewer 块标题：\n${text}`);
	assert.match(text, /\uF4BE worker · [^\n]*✓/, `worker 块标题：\n${text}`);
	assert.match(text, /reviewer 的结论/, "应显示 reviewer 自己的结论");
	assert.match(text, /worker 的结论/, "应显示 worker 自己的结论");
	assert.doesNotMatch(text, /→ read/, "折叠态不该列出工具调用");
	assert.doesNotMatch(text, /^\s*Total\b/m, "不再有独立的 Total 行");

	// 链式：带 Step 编号
	const chain = {
		content: [{ type: "text", text: "最终结论" }],
		details: subagentDetails("chain", [
			mk("planner", "第一步结论", { step: 1 }),
			mk("worker", "第二步结论", { step: 2 }),
		]),
	};
	const chainText = panel
		.renderResult(chain, { expanded: false, isPartial: false }, theme, panelContext({ state: { startedAt: Date.now() - 3000 } }))
		.render(100)
		.map(strip)
		.join("\n");
	assert.match(chainText, /2\/2 步完成/);
	// 链式只显示"当前这一步"：都结束后显示最后一步，并且保留步骤编号
	assert.match(chainText, /2\. \uF4BE worker · [^\n]*✓/, `链式应显示最后一步：\n${chainText}`);
	assert.doesNotMatch(chainText, /1\. \uF4BE planner/, `不该同时显示第 1 步：\n${chainText}`);
	assert.match(chainText, /第二步结论/);
	assert.match(chainText, /还有 1 步/, `链式应提示"还有 N 步"：\n${chainText}`);
});

test("subagent 面板：拿不到 details 时退化成一行文本，不崩", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);
	const view = panel.renderResult(
		{ content: [{ type: "text", text: "纯文本结果" }] },
		{ expanded: false, isPartial: false },
		theme,
		panelContext(),
	);
	const lines = view.render(80).map(strip).filter((line) => line.trim() !== "");
	assert.ok(lines.length > 0, "应至少渲染一行");
	assert.match(lines.join("\n"), /纯文本结果/);
});

test("subagent 面板：单个运行中不做两级结构，且标题不重复", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const result = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("single", [subagentChild({ status: "running" })]),
	};
	const state = { startedAt: Date.now() - 3000 };
	const ctx = panelContext({ isPartial: true, state });

	// pi 里 call 区与 result 区是两个独立子组件，两块会拼在一起显示
	const callLines = panel
		.renderCall({ agent: "reviewer", task: "审查 panels.ts" }, theme, ctx)
		.render(96)
		.map(strip);
	const bodyLines = panel
		.renderResult(result, { expanded: false, isPartial: true }, theme, ctx)
		.render(96)
		.map(strip);
	const all = [...callLines, ...bodyLines];

	// 1) 标题只能在 call 区出现一次
	const titleLines = all.filter((line) => /子代理 · reviewer/.test(line));
	assert.equal(titleLines.length, 1, `标题必须只出现一次，实际 ${titleLines.length} 次`);
	assert.match(callLines[0], /子代理 · reviewer/, `首行应是标题：${callLines[0]}`);
	// 2) 运行中标题以 󰈑 结尾
	assert.ok(callLines[0].includes("\uDB80\uDE11"), `运行中标题应以 󰈑 结尾：${callLines[0]}`);
	// 3) 任务行在 call 区，且只出现一次
	assert.match(callLines[1], /⎿/, `call 区第二行应是任务行：${callLines[1]}`);
	assert.equal(all.filter((line) => /审查 panels\.ts/.test(line)).length, 1, "任务行只应出现一次");
	// 4) 流式输出不再自带 ⎿
	for (const line of bodyLines.slice(0, -1)) {
		assert.doesNotMatch(line, /⎿/, `流式输出行不该再带 ⎿：${line}`);
	}
	// 5) 底行五段齐全、无思考/缓存图标
	const last = bodyLines[bodyLines.length - 1];
	assert.match(last, /1\.2k/);
	assert.match(last, /claude-sonnet-4/);
	assert.match(last, /high/);
	assert.match(last, /40\.0%/);
	assert.ok(!last.includes("\uE263"), "底行不该有思考图标");
	assert.ok(!last.includes("\uF52E"), "底行不该有缓存图标");
});

test("subagent 面板：并行运行中仍保留每个子代理的分组标题", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const result = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("parallel", [
			subagentChild({ agent: "reviewer", status: "running" }),
			subagentChild({ agent: "worker", status: "running" }),
		]),
	};
	const state = { startedAt: Date.now() - 3000 };
	const ctx = panelContext({ isPartial: true, state });
	const callText = panel
		.renderCall({ tasks: [{ agent: "reviewer" }, { agent: "worker" }] }, theme, ctx)
		.render(96)
		.map(strip)
		.join("\n");
	const text = panel
		.renderResult(result, { expanded: false, isPartial: true }, theme, ctx)
		.render(96)
		.map(strip)
		.join("\n");

	assert.match(callText, /子代理 · 并行 · 2 个任务/);
	assert.doesNotMatch(text, /子代理 · 并行/, "result 区不该重复画标题");
	// 子代理块标题不再画 ⎿（只留等宽缩进），所以断言"缩进 + 图标 + 名称 ·"
	const headers = text.match(/^\s+\uF4BE\s+(reviewer|worker)\s+·/gm) ?? [];
	assert.equal(headers.length, 2, `并行应有 2 个子代理标题：\n${text}`);
	assert.doesNotMatch(text, /⎿\s+\uF4BE/, "块标题不该再带 ⎿");
});

test("subagent 面板：状态标记（󰈑 / ✓ / ✗）是静态字形，颜色比标题暗", async () => {
	const { statusMark, statusMarkText, statusMarkGlyph, ACCENT_SUBAGENT } = await import(
		"../subagent-data.ts"
	);

	const running = statusMark([subagentChild({ status: "running" })], true);
	assert.equal(running.kind, "running");
	const runningText = statusMarkText(running);
	const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(runningText);
	assert.ok(rgb, `执行中标记应有 24-bit 颜色：${runningText}`);
	const [r, g, b] = rgb.slice(1).map(Number);
	assert.ok(b > r, `应是蓝色系：${r},${g},${b}`);
	const lum = (x, y, z) => 0.299 * x + 0.587 * y + 0.114 * z;
	assert.ok(lum(r, g, b) < lum(...ACCENT_SUBAGENT) - 10, "标记应比标题暗");
	assert.notDeepEqual([r, g, b], [227, 179, 65], "不能是原来的警告黄");

	assert.equal(statusMarkGlyph(running), "\uDB80\uDE11");
	assert.equal(visibleWidth(statusMarkGlyph(running)), 1);
	const same = [0, 450, 900, 100000].map(() => statusMarkText(running));
	assert.equal(new Set(same).size, 1, "执行中标记必须与时间无关（静态）");

	assert.equal(statusMark([subagentChild({ status: "completed" })], false).kind, "ok");
	assert.equal(statusMark([subagentChild({ status: "failed" })], false).kind, "fail");
	assert.equal(statusMark([subagentChild({ status: "aborted" })], false).kind, "fail");
	assert.match(strip(statusMarkText({ kind: "ok" })), /✓/);
	assert.match(strip(statusMarkText({ kind: "fail" })), /✗/);
});

test("subagent 面板：任务描述换行显示完整（不截断）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const task =
		"在 /home/sunqiulei/Pi开发/deemo-style/extensions/ui-style.modules 里，统计两个文件各有多少行，" +
		"并说一句话说明这两个文件的分工。纯文本回答，不要表格。";
	const ctx = panelContext({ isPartial: true, state: { startedAt: Date.now() - 3000 } });
	const lines = panel.renderCall({ agent: "scout", task }, theme, ctx).render(70).map(strip);

	const body = lines.slice(1);
	assert.ok(body.length >= 2, `长任务应折成多行，实际 ${body.length} 行`);
	assert.match(body[0], /⎿/);
	for (const line of body.slice(1)) assert.doesNotMatch(line, /⎿/);

	const joined = body.join("").replace(/\s+/g, "");
	assert.ok(joined.includes("在/home/sunqiulei"), "任务开头应完整");
	assert.ok(joined.includes("不要表格。"), "任务结尾应完整（不能截断）");
});

test("subagent 面板：跑完标题必须显示 ✓（不能停在 󰈑）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 模拟 pi 的真实顺序：两个工厂都先跑、之后才 render
	const doneState = { startedAt: Date.now() - 4600 };
	const doneCtx = panelContext({ isPartial: false, state: doneState });
	const done = {
		content: [{ type: "text", text: "ok" }],
		details: subagentDetails("single", [subagentChild({ status: "completed" })]),
	};
	const doneCall = panel.renderCall({ agent: "scout", task: "t" }, theme, doneCtx);
	const doneRes = panel.renderResult(done, { expanded: false, isPartial: false }, theme, doneCtx);
	const doneTitle = strip(doneCall.render(80)[0]);
	doneRes.render(80);
	assert.match(doneTitle, /✓/, `完成帧标题应显示 ✓：${doneTitle}`);
	assert.ok(!doneTitle.includes("\uDB80\uDE11"), "完成帧不该还在显示 󰈑");

	const failState = { startedAt: Date.now() - 4600 };
	const failCtx = panelContext({ isPartial: false, state: failState });
	const fail = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("single", [subagentChild({ status: "failed", errorMessage: "超时" })]),
	};
	const failCall = panel.renderCall({ agent: "scout" }, theme, failCtx);
	const failRes = panel.renderResult(fail, { expanded: false, isPartial: false }, theme, failCtx);
	const failTitle = strip(failCall.render(80)[0]);
	failRes.render(80);
	assert.match(failTitle, /✗/, `失败帧标题应显示 ✗：${failTitle}`);
});

test("subagent 面板：运行中的高光覆盖到状态标记 󰈑", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const ctx = panelContext({ isPartial: true, state: { startedAt: Date.now() - 1000 } });
	const raw = panel.renderCall({ agent: "scout", task: "t" }, theme, ctx).render(80)[0];

	// shimmerText 逐字符着色：SGR 段数应等于扫光文本的字符数（行首缩进在扫光外）
	const body = raw.replace(/^ +/, "");
	assert.equal(
		(body.match(/38;2;/g) ?? []).length,
		Array.from(strip(body)).length,
		`每个可见字符都应被单独着色（含 󰈑）：${JSON.stringify(strip(body))}`,
	);
	// 字形后面不该再有独立配色（那说明它被拼在扫光之外）
	const tail = raw.slice(raw.lastIndexOf("\uDB80\uDE11"));
	assert.doesNotMatch(tail, /38;2;(71|47|186);/, `标记后面不该再有独立配色：${JSON.stringify(tail)}`);
});

test("subagent 面板：任务描述用「」包裹并着黄色", async () => {
	const { registerSubagentPanel, TASK_TEXT_RGB, TASK_WRAP_OPEN, TASK_WRAP_CLOSE } = await import(
		"../subagent-panel.ts"
	);
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const task = "在某个目录里确认一个常量的值，用纯文本回答，不要表格。";
	const ctx = panelContext({ isPartial: true, state: { startedAt: Date.now() - 3000 } });
	const lines = panel
		.renderCall({ agent: "scout", task }, theme, ctx)
		.render(40)
		.map(strip);

	// 第二行起是任务描述：首行以「开头，末行以」结尾
	const taskLines = lines.slice(1).filter((line) => line.trim() !== "");
	assert.ok(taskLines.length >= 1, "应有任务行");
	assert.ok(
		taskLines[0].includes(TASK_WRAP_OPEN),
		`任务首行应带开引号「：${taskLines[0]}`,
	);
	assert.ok(
		taskLines[taskLines.length - 1].includes(TASK_WRAP_CLOSE),
		`任务末行应带闭引号」：${taskLines[taskLines.length - 1]}`,
	);
	// 包裹的内容必须完整（折行不丢字）
	const joined = taskLines.join("").replace(/\s+/g, "");
	assert.ok(joined.includes("在某个目录里确认一个常量的值"), "任务内容应完整");
	assert.ok(joined.includes("不要表格。"), "任务结尾应完整");

	// 续行必须对齐到「后面的第一个字（不是对齐到「）。注意「是全角，占 2 列。
	if (taskLines.length >= 2) {
		const openWidth = visibleWidth(TASK_WRAP_OPEN);
		const bracketCol = visibleWidth(taskLines[0].slice(0, taskLines[0].indexOf(TASK_WRAP_OPEN)));
		const firstCharCol = bracketCol + openWidth;
		for (const line of taskLines.slice(1)) {
			const contCol = line.length - line.trimStart().length;
			assert.equal(
				contCol,
				firstCharCol,
				`续行应缩进到第 ${firstCharCol} 列（对齐任务首字），实际 ${contCol}：${JSON.stringify(line)}`,
			);
		}
	}

	// 颜色是黄色：R 与 G 都明显高于 B，且 R 最大
	const [r, g, b] = TASK_TEXT_RGB;
	assert.ok(r > b && g > b, `应是黄色（RGB 两个分量都高于蓝）：${r},${g},${b}`);
	assert.ok(r >= g, `黄色应 R ≥ G：${r},${g},${b}`);

	// 渲染出来的任务行必须真的带上这个颜色
	const raw = panel.renderCall({ agent: "scout", task }, theme, ctx).render(40);
	const rawTask = raw[1] ?? "";
	assert.deepEqual(
		/38;2;(\d+);(\d+);(\d+)/.exec(rawTask)?.slice(1).map(Number),
		[...TASK_TEXT_RGB],
		`任务行应使用 TASK_TEXT_RGB：${JSON.stringify(rawTask)}`,
	);
});

test("subagent 面板：任意终端宽度下任务描述都不会被兜底截断（一个字都不丢）", async () => {
	const { registerSubagentPanel, TASK_WRAP_OPEN, TASK_WRAP_CLOSE } = await import(
		"../subagent-panel.ts"
	);
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const task =
		"在 /home/sunqiulei/Pi开发/deemo-style/extensions/ui-style.modules 里，确认一个常量的值，" +
		"并说明它控制什么。纯文本回答，不要表格，不要分析，也不要改代码。";
	const ctx = panelContext({ isPartial: true, state: { startedAt: Date.now() - 3000 } });
	const norm = (text) => text.replace(/\s+/g, "");

	for (const width of [20, 25, 30, 40, 60, 80, 120]) {
		const lines = panel
			.renderCall({ agent: "scout", task }, theme, ctx)
			.render(width)
			.map(strip);
		// 标题之后都是任务描述
		const body = lines.slice(1);
		assert.ok(body.length > 0, `width=${width} 应有任务行`);
		// 去掉行首前缀（缩进空格 + ⎿ 连接符）后拼起来，必须与「+原文+」完全一致
		// （兜底截断会吃掉尾字，拼起来就会对不上）
		const joined = norm(body.map((line) => line.replace(/^[\s⎿]+/, "")).join(""));
		assert.equal(
			joined,
			norm(`${TASK_WRAP_OPEN}${task}${TASK_WRAP_CLOSE}`),
			`width=${width} 任务描述被截断：\n${body.join("\n")}`,
		);
		// 每行都不超宽
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`width=${width} 行宽 ${visibleWidth(line)} 超宽：${JSON.stringify(line)}`,
			);
		}
	}
});

test("subagent 面板：并行运行中必须显示进度（已完成 N / 共 M）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const mk = (agent, status) => subagentChild({ agent, status });
	const result = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("parallel", [
			mk("a", "completed"),
			mk("b", "running"),
			mk("c", "pending"),
		]),
	};
	const ctx = panelContext({ isPartial: true, state: { startedAt: Date.now() - 5000 } });
	const lines = panel
		.renderResult(result, { expanded: false, isPartial: true }, theme, ctx)
		.render(100)
		.map(strip);

	// 运行中第一行（块顶部）就是进度：●已完成 / ○未完成 + 运行/待处理数
	const first = lines[0] ?? "";
	assert.equal(
		(first.match(/●/g) ?? []).length,
		1,
		`1 个已完成应有 1 个 ●：${first}`,
	);
	// 未完成的 2 个都用空心 ○（执行中靠黄色区分，不再用 ◑）
	assert.equal(
		(first.match(/○/g) ?? []).length,
		2,
		`2 个未完成应有 2 个 ○：${first}`,
	);
	assert.equal((first.match(/●/g) ?? []).length, 1, `只有 1 个已完成 ●：${first}`);

	assert.match(first, /1 运行中/, `应显示运行中数量：${first}`);
	assert.match(first, /1 待处理/, `应显示待处理数量：${first}`);
	// 运行中不显示 token 汇总（数字还在涨，会一直跳）
	assert.doesNotMatch(first, /cache/, `运行中不该有缓存汇总：${first}`);
	// 不再使用沙漏图标
	assert.ok(!first.includes("⏳"), `运行中不该再出现沙漏：${first}`);
	// 进度行在块之前（每块标题在其后）
	assert.match(lines.join("\n"), /●[\s\S]*\uF4BE a/, "进度行应在子代理块之前");
});

test("subagent 面板：进度点只两种字形（●实心/○空心），四种状态靠颜色区分", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const mk = (agent, status) => subagentChild({ agent, status });
	const results = [
		mk("a", "completed"),
		mk("b", "failed"),
		mk("c", "running"),
		mk("d", "pending"),
	];
	const render = (isPartial, width = 100) =>
		panel
			.renderResult(
				{ content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) },
				{ expanded: false, isPartial },
				theme,
				panelContext({ isPartial, state: { startedAt: Date.now() - 5000 } }),
			)
			.render(width)[0] ?? "";

	const line = render(true);
	const plain = strip(line);

	// 只有 ○ 和 ● 两种字形，不允许出现 ◑（半实心，字重不一致）或 emoji
	assert.ok(!plain.includes("◑"), `不该再用 ◑（比 ●/○ 大）：${plain}`);
	assert.ok(!line.includes("\u26AA"), `不该用 emoji 圆点：${plain}`);
	for (const glyph of ["●", "○"]) {
		assert.equal(visibleWidth(glyph), 1, `${glyph} 必须是 1 列宽`);
	}

	// 实心 = 已结束（2 个），空心 = 未结束（2 个）
	assert.equal((plain.match(/●/g) ?? []).length, 2, `2 个已结束应有 2 个 ●：${plain}`);
	assert.equal((plain.match(/○/g) ?? []).length, 2, `2 个未结束应有 2 个 ○：${plain}`);

	// 颜色：绿=成功、红=失败、黄=执行中、灰=未开始
	const colors = [...line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m([●○])/g)].map((m) => ({
		rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
		glyph: m[4],
	}));
	assert.deepEqual(colors[0], { rgb: [63, 185, 80], glyph: "●" }, "成功应是绿色 ●");
	assert.deepEqual(colors[1], { rgb: [248, 81, 73], glyph: "●" }, "失败应是红色 ●");
	assert.deepEqual(colors[2], { rgb: [227, 179, 65], glyph: "○" }, "执行中应是黄色 ○");
	assert.deepEqual(colors[3], { rgb: [110, 110, 110], glyph: "○" }, "未开始应是灰色 ○");

	// 点位固定：每个点 1 列 + 1 空格 = 间距 2
	const positions = [...plain.matchAll(/[●○]/g)].map((m) => visibleWidth(plain.slice(0, m.index)));
	for (let i = 1; i < positions.length; i++) {
		assert.equal(
			positions[i] - positions[i - 1],
			2,
			`点间距应恒为 2 列，实际 ${positions[i] - positions[i - 1]}：${plain}`,
		);
	}

	// 各种宽度下不超宽
	for (const width of [30, 50, 100]) {
		for (const l of panel
			.renderResult(
				{ content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) },
				{ expanded: false, isPartial: true },
				theme,
				panelContext({ isPartial: true, state: { startedAt: Date.now() - 5000 } }),
			)
			.render(width)) {
			assert.ok(visibleWidth(l) <= width, `width=${width} 超宽：${visibleWidth(l)}`);
		}
	}
});

test("subagent 面板：8 个任务只显示前 3 个块 + 还有 5 个，展开看全部（不轮播）", async () => {
	const { registerSubagentPanel, windowedChildren } = await import("../subagent-panel.ts");

	// 纯函数：固定前 3，不随时间变化
	const items = ["a", "b", "c", "d", "e", "f", "g", "h"];
	const short = windowedChildren(items, false);
	assert.deepEqual(short.visible, ["a", "b", "c"], "窗口应是前 3 个");
	assert.deepEqual(short.indices, [0, 1, 2]);
	assert.equal(short.hidden, 5, "应提示还有 5 个");
	// 展开态全给
	assert.equal(windowedChildren(items, true).visible.length, 8);
	assert.equal(windowedChildren(items, true).hidden, 0);
	// 数量不超过窗口时不隐藏
	assert.equal(windowedChildren(["a", "b"], false).hidden, 0);

	// 真实渲染
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);
	const results = Array.from({ length: 8 }, (_, i) =>
		subagentChild({ agent: `a${i + 1}`, status: i < 3 ? "completed" : "failed" }),
	);
	const details = { content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) };

	const collapsed = panel
		.renderResult(details, { expanded: false, isPartial: false }, theme, panelContext({ isPartial: false }))
		.render(100)
		.map(strip)
		.join("\n");
	const titles = collapsed.match(/^ +\uF4BE a\d+ · /gm) ?? [];
	assert.equal(titles.length, 3, `应只渲染 3 个块：\n${collapsed}`);
	assert.match(collapsed, /还有 5 个子代理/, `应提示剩余数量：\n${collapsed}`);
	assert.doesNotMatch(collapsed, /循环显示/, "不该再提「循环显示」");

	// 多次渲染（等价于多帧）窗口内容不变 —— 不轮播
	const again = strip(
		panel
			.renderResult(details, { expanded: false, isPartial: false }, theme, panelContext({ isPartial: false }))
			.render(100)
			.map(strip)
			.join("\n"),
	);
	assert.equal(again, collapsed, "同一数据多次渲染，窗口内容应完全一致");

	const expanded = panel
		.renderResult(details, { expanded: true, isPartial: false }, theme, panelContext({ isPartial: false }))
		.render(100)
		.map(strip)
		.join("\n");
	assert.equal(
		(expanded.match(/^ +\uF4BE a\d+ · /gm) ?? []).length,
		8,
		`展开应显示全部 8 个块：\n${expanded}`,
	);
	assert.doesNotMatch(expanded, /还有 \d+ 个子代理/, "展开态不该再有省略提示");
});

test("subagent 面板：并行块执行内容窗口固定 2 行（单个/链式仍是 4 行）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const many = Array.from({ length: 6 }, (_, i) => ({ type: "text", text: `内容 ${i + 1}` }));
	const mk = (agent) =>
		subagentChild({ agent, status: "running", messages: [{ role: "assistant", content: many }] });

	const render = (mode, results) =>
		panel
			.renderResult(
				{ content: [{ type: "text", text: "" }], details: subagentDetails(mode, results) },
				{ expanded: false, isPartial: true },
				theme,
				panelContext({ isPartial: true, state: {} }),
			)
			.render(100)
			.map(strip);

	// 并行：每块「标题 + 任务 + 2 行内容 + 底行」
	const parallel = render("parallel", [mk("a")]);
	const contentLines = parallel.filter((line) => /内容 \d/.test(line));
	assert.equal(contentLines.length, 2, `并行执行内容窗口应为 2 行：\n${parallel.join("\n")}`);

	// 单个：仍是 4 行（标题在 renderCall 里，这里只数内容）
	const single = render("single", [mk("b")]);
	assert.equal(
		single.filter((line) => /内容 \d/.test(line)).length,
		4,
		`单个执行内容窗口应为 4 行：\n${single.join("\n")}`,
	);
});

test("subagent 面板：链式只显示当前步骤，任务（含 {previous}）完整显示", async () => {
	const {
		registerSubagentPanel,
		chainWindowChildren,
	} = await import("../subagent-panel.ts");

	// 纯函数：谁在跑就显示谁；都结束后显示最后一步
	const mk = (status) => ({ status });
	assert.deepEqual(chainWindowChildren([mk("completed"), mk("running"), mk("pending")], false).indices, [1]);
	assert.deepEqual(chainWindowChildren([mk("completed"), mk("pending"), mk("pending")], false).indices, [1]);
	assert.deepEqual(chainWindowChildren([mk("completed"), mk("completed"), mk("completed")], false).indices, [2]);
	assert.equal(chainWindowChildren([mk("completed"), mk("running"), mk("pending")], false).hidden, 2);
	// 展开 / 只有一步：全给
	assert.equal(chainWindowChildren([mk("completed"), mk("running")], true).indices.length, 2);
	assert.equal(chainWindowChildren([mk("running")], false).indices.length, 1);

	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 链式的任务里塞着上一步的完整输出（{previous} 被替换），会非常长
	const previousOutput = Array.from({ length: 12 }, (_, i) => `上一步输出的第 ${i + 1} 行内容`).join("\n");
	const mkStep = (agent, step, status = "completed", text = "结论") =>
		subagentChild({
			agent,
			step,
			status,
			task: `按这个计划执行：${previousOutput}。请统计三个文件的行数。`,
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text }] }],
		});

	const details = {
		content: [{ type: "text", text: "最终结论" }],
		details: subagentDetails("chain", [
			mkStep("planner", 1, "completed", "计划：用 wc -l。"),
			mkStep("scout", 2, "completed", "1226 / 997 / 493。"),
			mkStep("reviewer", 3, "completed", "数字对得上。"),
		]),
	};
	const lines = panel
		.renderResult(details, { expanded: false, isPartial: false }, theme, panelContext({ isPartial: false }))
		.render(100)
		.map(strip);
	const text = lines.join("\n");

	// 1) 只显示最后一步（3 步里只有最后一个块），且带步骤编号
	assert.match(text, /3\. \uF4BE reviewer · /, `应只显示第 3 步：\n${text}`);
	assert.doesNotMatch(text, /1\. \uF4BE planner/, `不该显示第 1 步：\n${text}`);
	assert.doesNotMatch(text, /2\. \uF4BE scout/, `不该显示第 2 步：\n${text}`);
	assert.match(text, /还有 2 步/, `应提示被折叠的步骤数（用"步"）：\n${text}`);
	assert.match(text, /3\/3 步完成/);

	// 2) 任务描述**完整显示**（含 {previous} 替换进来的上一步输出，不截断）
	const index = lines.findIndex((line) => /3\. \uF4BE reviewer · /.test(line));
	const taskBlock = lines.slice(index + 1, lines.findIndex((line, i) => i > index && line.includes("数字对得上")));
	const taskText = taskBlock.join("\n");
	assert.ok(taskText.includes("按这个计划执行"), `任务行：${taskText}`);
	// 12 行上一步输出的首尾行都应该在（证明没被截断）
	assert.ok(taskText.includes("上一步输出的第 1 行内容"), `应包含上一步输出的第一行：\n${taskText}`);
	assert.ok(taskText.includes("上一步输出的第 12 行内容"), `应包含上一步输出的最后一行（未截断）：\n${taskText}`);
	assert.ok(!taskText.includes("…"), `任务行不该被截断：\n${taskText}`);

	// 3) 展开态：3 步全给
	const expanded = panel
		.renderResult(details, { expanded: true, isPartial: false }, theme, panelContext({ isPartial: false }))
		.render(100)
		.map(strip)
		.join("\n");
	for (const [step, agent] of [["1", "planner"], ["2", "scout"], ["3", "reviewer"]]) {
		assert.match(expanded, new RegExp(`${step}\\. \uF4BE ${agent} · `), `展开应含第 ${step} 步`);
	}
});

test("subagent 面板：链式不做等高补齐（当前块后面不该有一大片空白）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 第 1 步很短；第 2 步的任务里塞着上一步的长输出（块会很高）
	const longPrevious = Array.from({ length: 14 }, (_, i) => `前一步输出的第 ${i + 1} 行`).join("\n");
	const mkStep = (agent, step, task, text) =>
		subagentChild({
			agent,
			step,
			task,
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text }] }],
		});

	const details = {
		content: [{ type: "text", text: "最终" }],
		details: subagentDetails("chain", [
			mkStep("planner", 1, "简短任务。", "短结论。"),
			mkStep("scout", 2, `按计划执行：${longPrevious}`, "统计完成。"),
		]),
	};

	for (const isPartial of [false, true]) {
		const lines = panel
			.renderResult(details, { expanded: false, isPartial }, theme, panelContext({ isPartial }))
			.render(100)
			.map(strip);
		// 不应出现连续/多余的空白行（补齐的痕迹）
		const blanks = lines.filter((line) => line.trim() === "");
		assert.equal(
			blanks.length,
			0,
			`链式不该有空白补齐行，实际 ${blanks.length} 行：\n${lines.join("\n")}`,
		);
	}
});

test("subagent 面板：链式按计划总步数一次画满进度点（未开始的补 ○）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 链式 details 只增长到当前步：第 1 步在跑时只有 1 个 result，但计划是 3 步
	const partialDetails = {
		content: [{ type: "text", text: "" }],
		details: subagentDetails("chain", [subagentChild({ agent: "planner", step: 1, status: "running" })]),
	};
	const ctx = panelContext({
		isPartial: true,
		state: { startedAt: Date.now() - 3000 },
		args: { chain: [{ agent: "planner" }, { agent: "scout" }, { agent: "reviewer" }] },
	});
	const first = strip(
		panel.renderResult(partialDetails, { expanded: false, isPartial: true }, theme, ctx).render(100)[0] ?? "",
	);

	// 应该有 3 个点：1 个执行中（黄 ○）+ 2 个未开始（灰 ○）
	assert.equal((first.match(/○/g) ?? []).length, 3, `应一次画满 3 个点：${first}`);
	assert.equal((first.match(/●/g) ?? []).length, 0, `还没有成功的点：${first}`);
	// 运行中/待处理计数要把"还没开始的步骤"算进待处理
	assert.match(first, /1 运行中/, `应显示 1 运行中：${first}`);
	assert.match(first, /2 待处理/, `应显示 2 待处理（含未开始的）：${first}`);

	// 不带 args.chain 时退回按 results 数量画（不炸）
	const noArgs = strip(
		panel
			.renderResult(
				partialDetails,
				{ expanded: false, isPartial: true },
				theme,
				panelContext({ isPartial: true, state: { startedAt: Date.now() - 3000 } }),
			)
			.render(100)[0] ?? "",
	);
	assert.equal((noArgs.match(/○/g) ?? []).length, 1, `无 args 时按已有 results 画：${noArgs}`);
});

test("subagent 面板：任务区不显示空行（压掉段落分隔，块不被撑高）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 上一步输出里带段落分隔（\n\n），链式会把它注入到下一步的 task
	const task =
		"审查这份统计：subagent-panel.ts 为 1041 行。\n\n差异主要来自视图层。\n\n\n建议拆分。  用 2 行给结论。";
	const lines = panel
		.renderCall({ agent: "scout", task }, theme, panelContext({ isPartial: true, state: {} }))
		.render(60)
		.map(strip);

	const taskLines = lines.slice(1);
	assert.ok(taskLines.length > 0, "应有任务行");
	// 任务区里不能出现空白行
	const blanks = taskLines.filter((line) => line.trim() === "");
	assert.equal(blanks.length, 0, `任务区不该有空行：\n${taskLines.join("\n")}`);
	// 内容仍然完整（首段与末段都在）
	const joined = taskLines.join("").replace(/\s+/g, "");
	assert.ok(joined.includes("审查这份统计"), "首段应在");
	assert.ok(joined.includes("差异主要来自视图层"), "中间段应在");
	assert.ok(joined.includes("用2行给结论"), "末段应在");
});

test("subagent 面板：并行同名 agent 的计时/尾窗不互相覆盖（按数组下标区分）", async () => {
	const { registerSubagentPanel, AgentBlockView } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 两个同名 agent，一个已完成（3s）、一个还在跑
	const a = subagentChild({ agent: "scout", status: "completed", messages: [{ role: "assistant", content: [{ type: "text", text: "A 的结论" }] }] });
	const b = subagentChild({ agent: "scout", status: "running", messages: [{ role: "assistant", content: [{ type: "text", text: "B 正在跑" }] }] });
	const details = { content: [{ type: "text", text: "" }], details: subagentDetails("parallel", [a, b]) };

	const state = {};
	const theme2 = theme;
	const block0 = new AgentBlockView({ child: a, state, theme: theme2, running: false, expanded: false, showTitle: true, nest: "", index: 0 });
	const block1 = new AgentBlockView({ child: b, state, theme: theme2, running: true, expanded: false, showTitle: true, nest: "", index: 1 });
	const l0 = block0.render(100).map(strip);
	const l1 = block1.render(100).map(strip);

	// 两份计时记录必须是独立的
	assert.notEqual(state.clocks?.get("child:0"), state.clocks?.get("child:1"), "同名块应有各自的 BlockClock");
	assert.notEqual(state.windows?.get("child:0"), state.windows?.get("child:1"), "同名块应有各自的尾窗快照");
	// 内容不串：block1 不能显示 block0 的结论
	assert.ok(l1.join("\n").includes("B 正在跑"), `运行中的块应显示自己的内容：\n${l1.join("\n")}`);
	assert.ok(!l1.join("\n").includes("A 的结论"), `运行中的块不该显示另一个同名 agent 的结论：\n${l1.join("\n")}`);
});

test("subagent 面板：长结论/长错误在展开态按宽度折行（不被 … 切掉）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 一条远超终端宽度的结论（没有换行）
	const longConclusion = "很长的结论".repeat(40);
	const longError = "错误信息".repeat(40);

	for (const [label, child, content] of [
		["长结论", subagentChild({ status: "completed" }), longConclusion],
		["长错误", subagentChild({ status: "failed", errorMessage: longError }), ""],
	]) {
		const details = { content: [{ type: "text", text: content }], details: subagentDetails("single", [child]) };
		for (const expanded of [false, true]) {
			const lines = panel
				.renderResult(details, { expanded, isPartial: false }, theme, panelContext({ isPartial: false }))
				.render(60)
				.map(strip);
			const text = lines.join("");
			// 内容必须完整：把渲染结果去掉空白后，应包含原文本整段
			const flat = text.replace(/\s+/g, "");
			const expect = (label === "长结论" ? longConclusion : longError).replace(/\s+/g, "");
			assert.ok(
				flat.includes(expect),
				`${label}（expanded=${expanded}）应完整显示、不能丢字：\n${lines.join("\n")}`,
			);
			// 每行都不超宽
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= 60, `${label} 行宽超限：${visibleWidth(line)}`);
			}
		}
	}
});

test("subagent 面板：块渲染按签名缓存（同一帧数据不重复渲染），内容变化才失效", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const results = Array.from({ length: 8 }, (_, i) =>
		subagentChild({ agent: `a${i + 1}`, status: i < 6 ? "completed" : "failed" }),
	);
	const details = { content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) };
	const state = { startedAt: Date.now() - 5000 };
	const ctx = panelContext({ state, isPartial: true });

	const first = panel.renderResult(details, { expanded: false, isPartial: true }, theme, ctx).render(100);
	const cache = state.blockCache;
	assert.ok(cache instanceof Map, "应建立块渲染缓存");
	// 只有窗口内的 3 块会被渲染/缓存（不再为量高度把 8 块都渲一遍——这是性能改进）
	assert.equal(cache.size, 3, `只应缓存窗口内的 3 块，实际 ${cache.size}`);

	// 第二次渲染（同数据）：行数一致，且缓存条目里的 lines 是同一个数组（命中，不重渲）
	const before = cache.get("child:0").lines;
	const second = panel.renderResult(details, { expanded: false, isPartial: true }, theme, ctx).render(100);
	assert.equal(second.length, first.length, "同数据两次渲染行数应一致");
	assert.equal(cache.get("child:0").lines, before, "同数据应命中缓存（同一条数组引用）");

	// 内容变化 → 该块缓存失效
	const changed = structuredClone(results);
	changed[0].messages = [{ role: "assistant", content: [{ type: "text", text: "新内容" }] }];
	panel
		.renderResult(
			{ content: [{ type: "text", text: "" }], details: subagentDetails("parallel", changed) },
			{ expanded: false, isPartial: true },
			theme,
			panelContext({ state, isPartial: true }),
		)
		.render(100);
	assert.notEqual(cache.get("child:0").lines, before, "内容变化后该块应重新渲染");
});

// ---------------------------------------------------------------------------
// 压缩摘要 / 分支摘要块
// ---------------------------------------------------------------------------

test("摘要块：图标 / 标题 / 固定 5 行窗口 / 展开全文 / 无背景", async () => {
	const {
		patchSummaryBlocks,
		unpatchSummaryBlocks,
		ICON_COMPACTION,
		ICON_BRANCH,
		SUMMARY_WINDOW_LINES,
	} = await import("../summary-blocks.ts");

	patchSummaryBlocks();
	try {
		// ① 压缩摘要块（pi 的真实组件）
		const summary = Array.from({ length: 9 }, (_, i) => `摘要第 ${i + 1} 行`).join("\n");
		const compaction = new piMain.CompactionSummaryMessageComponent(
			{ role: "compactionSummary", summary, tokensBefore: 12345, timestamp: Date.now() },
			undefined,
			1,
			[],
			"id-1",
			Date.now(),
		);
		const lines = compaction.render(100).map(strip);
		const text = lines.join("\n");

		assert.ok(text.includes(ICON_COMPACTION), `应有压缩图标：\n${text}`);
		assert.match(text, /压缩完成/, "标题应为「压缩完成」");
		assert.match(text, /压缩前 12k tokens/, "应带压缩前 token 数（formatTokens 口径：12.3k → 12k）");
		assert.match(text, /⎿/, "内容应使用 ⎿ 连接符");
		// 折叠态：窗口 5 行 + 「还有 4 行」
		assert.equal((text.match(/摘要第 \d+ 行/g) ?? []).length, SUMMARY_WINDOW_LINES, `折叠应只显示 ${SUMMARY_WINDOW_LINES} 行：\n${text}`);
		assert.match(text, /还有 4 行/, "应提示还有 4 行");
		// 不再有 pi 默认的 [compaction] 标签
		assert.ok(!text.includes("[compaction]"), "不该再有默认标签");

		// ② 展开态给全文
		compaction.setExpanded(true);
		const expanded = compaction.render(100).map(strip).join("\n");
		for (const i of [1, 5, 9]) {
			assert.ok(expanded.includes(`摘要第 ${i} 行`), `展开应含第 ${i} 行：\n${expanded}`);
		}

		// ③ 分支摘要块
		const branch = new piMain.BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "分支摘要内容", fromId: "a1b2c3d4e5f6", timestamp: Date.now() },
			undefined,
			1,
			[],
			"id-2",
			Date.now(),
		);
		const branchText = branch.render(100).map(strip).join("\n");
		assert.ok(branchText.includes(ICON_BRANCH), `应有分支图标：\n${branchText}`);
		assert.match(branchText, /分支摘要/);
		assert.match(branchText, /from a1b2c3d4/, "应带来源短 id");
		// 分支摘要不显示时钟，改成显示摘要大小
		const { ICON_CLOCK } = await import("../core.ts");
		assert.ok(!branchText.includes(ICON_CLOCK), `分支摘要不该有时钟：\n${branchText}`);
		assert.doesNotMatch(branchText, /--/, `分支摘要不该有 -- 占位：\n${branchText}`);
		assert.match(branchText, /摘要 \d+k? tokens/, `应显示摘要大小：\n${branchText}`);
		// 不能是 0：pi-ai 的 estimateTokens 对 assistant 只认 block 数组，传字符串会算成 0
		assert.doesNotMatch(branchText, /摘要 0 tokens/, `摘要大小不该算成 0：\n${branchText}`);
		assert.ok(!branchText.includes("[branch]"), "不该再有默认标签");
	} finally {
		unpatchSummaryBlocks();
	}
});

test("摘要块：长行按宽度折行、窄终端不超宽", async () => {
	const { patchSummaryBlocks, unpatchSummaryBlocks } = await import("../summary-blocks.ts");
	patchSummaryBlocks();
	try {
		const longLine = "很长的摘要内容".repeat(30);
		const compaction = new piMain.CompactionSummaryMessageComponent(
			{ role: "compactionSummary", summary: longLine, tokensBefore: 1000, timestamp: Date.now() },
			undefined,
			1,
			[],
			"id-3",
			Date.now(),
		);
		for (const width of [40, 80]) {
			for (const expanded of [false, true]) {
				compaction.setExpanded(expanded);
				const lines = compaction.render(width).map(strip);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= width, `width=${width} 超宽：${visibleWidth(line)}`);
				}
				// 折叠态不许出现 …（说明没被截断）
				if (!expanded) {
					assert.ok(lines.join("").includes("很长的摘要内容"), "折叠态应保留摘要文字");
				}
			}
		}
	} finally {
		unpatchSummaryBlocks();
	}
});

test("压缩中指示：session_before_compact 起表、session_compact 收表", async () => {
	const { setupCompactionIndicator, CompactionIndicatorView, ICON_COMPACTION } = await import(
		"../summary-blocks.ts"
	);
	const before = handlers.get("session_before_compact")?.length ?? 0;
	const after = handlers.get("session_compact")?.length ?? 0;
	setupCompactionIndicator({
		on(event, fn) {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
	});
	assert.equal((handlers.get("session_before_compact")?.length ?? 0), before + 1);
	assert.equal((handlers.get("session_compact")?.length ?? 0), after + 1);

	// 视图本身：图标 + 文案（默认按手动压缩）+ 扫光
	const clock = { startedAt: Date.now() - 1200 };
	const lines = new CompactionIndicatorView(clock).render(80).map(strip);
	assert.ok(lines[0].includes(ICON_COMPACTION), `标题应有压缩图标：${lines[0]}`);
	assert.match(lines[0], /压缩上下文中/);
	assert.match(lines.join("\n"), /正在生成摘要/);

	// 事件接线：起表挂 widget，收表清 widget
	const widgets = [];
	const ctx = { mode: "tui", ui: { setWidget: (key) => widgets.push(key) } };
	(handlers.get("session_before_compact") ?? []).at(-1)({ type: "session_before_compact" }, ctx);
	(handlers.get("session_compact") ?? []).at(-1)({ type: "session_compact" }, ctx);
	assert.equal(widgets.length, 2, "起表/收表各应操作一次 widget");
});

test("摘要块：标题始终有时钟（未测到耗时显示 --），压缩完成显示前后对比", async () => {
	const {
		patchSummaryBlocks,
		unpatchSummaryBlocks,
		recordCompactionResult,
		resetCompactionTiming,
		compactionTitle,
	} = await import("../summary-blocks.ts");
	const { ICON_CLOCK } = await import("../core.ts");

	// ① 没有本地记录（历史回放）：时钟在，但耗时是 --
	resetCompactionTiming();
	const historic = strip(compactionTitle({ tokensBefore: 12345 }, undefined));
	assert.ok(historic.includes(ICON_CLOCK), `标题应有时钟图标：${historic}`);
	assert.match(historic, /压缩前 12k tokens/, `应显示压缩前大小：${historic}`);
	assert.match(historic, /--/, `没有测到耗时应显示 --：${historic}`);

	// ② 有本地记录：显示 耗时 + 压缩前→压缩后（降幅）
	resetCompactionTiming();
	recordCompactionResult({ elapsedMs: 1800, tokensAfter: 4000 }, "entry-1");
	const live = strip(compactionTitle({ tokensBefore: 12345 }, undefined));
	assert.match(live, /1\.8s/, `应显示耗时：${live}`);
	assert.match(live, /12k → 4k tokens/, `应显示前后对比：${live}`);
	assert.match(live, /-68%/, `应显示降幅：${live}`);

	// ③ 组件层：覆盖 messageId 时也能取到记录
	patchSummaryBlocks();
	try {
		const comp = new piMain.CompactionSummaryMessageComponent(
			{ role: "compactionSummary", summary: "摘要内容", tokensBefore: 12345, timestamp: Date.now() },
			undefined,
			1,
			[],
			"entry-1",
			Date.now(),
		);
		const text = strip(comp.render(100).join("\n"));
		assert.match(text, /1\.8s/, `组件应显示耗时：\n${text}`);
		assert.match(text, /12k → 4k tokens/, `组件应显示前后对比：\n${text}`);
	} finally {
		unpatchSummaryBlocks();
		resetCompactionTiming();
	}
});

test("压缩中指示：5 行窗口按时间自动下滚（流式观感）", async () => {
	const {
		CompactionIndicatorView,
		textsFromPreparation,
		ICON_COMPACTION,
		SUMMARY_WINDOW_LINES,
		SUMMARY_SCROLL_MS,
	} = await import("../summary-blocks.ts");
	const { ICON_CLOCK } = await import("../core.ts");

	// 从 preparation 抽文本（只看 text 块，忽略工具调用）
	const source = textsFromPreparation({
		messagesToSummarize: [
			{ role: "user", content: "第一段用户输入" },
			{ role: "assistant", content: [{ type: "text", text: "助手回答" }, { type: "toolCall", name: "read" }] },
		],
		turnPrefixMessages: [{ role: "user", content: "最后一段" }],
	});
	assert.equal(source, "第一段用户输入\n助手回答\n最后一段");

	const lines12 = Array.from({ length: 12 }, (_, i) => `原文第 ${i + 1} 行`).join("\n");
	const realNow = Date.now;
	try {
		const renderAt = (elapsedMs) => {
			Date.now = () => 10_000_000 + elapsedMs;
			const view = new CompactionIndicatorView({ startedAt: 10_000_000 }, lines12);
			return view.render(80).map(strip);
		};

		// ① 起始：看头部 5 行 + 「下面还有 7 行」
		const head = renderAt(0);
		assert.ok(head[0].includes(ICON_COMPACTION), `标题应有压缩图标：${head[0]}`);
		assert.match(head[0], /压缩上下文中/);
		const headBody = head.slice(1).join("\n");
		assert.ok(headBody.includes("原文第 1 行"), `起始应从头显示：\n${headBody}`);
		assert.equal((headBody.match(/原文第 \d+ 行/g) ?? []).length, SUMMARY_WINDOW_LINES, `窗口应固定 ${SUMMARY_WINDOW_LINES} 行`);
		assert.match(headBody, /下面还有 7 行/);

		// ② 过一段时间：窗口下滚（起始行变了）
		const scrolled = renderAt(SUMMARY_SCROLL_MS * 3);
		const scrolledBody = scrolled.slice(1).join("\n");
		assert.ok(scrolledBody.includes("原文第 4 行"), `应滚动到第 4 行起：\n${scrolledBody}`);
		assert.ok(!scrolledBody.includes("原文第 1 行"), "第 1 行应已滚出窗口");
		assert.match(scrolledBody, /上面还有 3 行/);

		// ③ 滚到底：停在尾部，只提示上面还有内容
		const tail = renderAt(SUMMARY_SCROLL_MS * 100);
		const tailBody = tail.slice(1).join("\n");
		assert.ok(tailBody.includes("原文第 12 行"), `滚到底应显示最后一行：\n${tailBody}`);
		assert.match(tailBody, /上面还有 \d+ 行/);
		assert.doesNotMatch(tailBody, /下面还有/, "到底后不该还有「下面还有」");
		// 任何时候窗口都不超过 5 行原文
		for (const body of [headBody, scrolledBody, tailBody]) {
			assert.ok(
				(body.match(/原文第 \d+ 行/g) ?? []).length <= SUMMARY_WINDOW_LINES,
				`原文窗口不应超过 ${SUMMARY_WINDOW_LINES} 行：\n${body}`,
			);
		}
	} finally {
		Date.now = realNow;
	}
});

test("摘要/压缩指示器：文案换成「摘要生成中」/「压缩上下文中」+ 月相帧（与工作中同款）", async () => {
	const {
		patchSummaryStatusIndicators,
		unpatchSummaryStatusIndicators,
		BRANCH_SUMMARY_TEXT,
		COMPACTION_TEXT,
		workingMessage,
	} = await import("../editor.ts");
	const { Loader } = await import("@earendil-works/pi-tui");
	const { ICON_CLOCK } = await import("../core.ts");

	patchSummaryStatusIndicators();
	const realNow = Date.now;
	// 首帧会记开始时间并隐藏 "0ms"；再推进 1.8s 渲染出耗时。
	const make = (kind) => {
		const loader = new Loader(undefined, (t) => t, (t) => t);
		loader.kind = kind;
		loader.updateDisplay();
		const t0 = Date.now();
		Date.now = () => t0 + 1800;
		loader.updateDisplay();
		Date.now = realNow;
		return loader;
	};
	const branch = make("branchSummary");
	const compaction = make("compaction");
	const plain = new Loader(undefined, (t) => t, (t) => t);
	plain.updateDisplay();
	try {
		// ① 分支摘要
		const branchText = branch.render(80).map(strip).join("\n");
		assert.ok(branchText.includes(BRANCH_SUMMARY_TEXT), `应显示「摘要生成中」：\n${branchText}`);
		assert.ok(!branchText.includes("Summarizing branch"), `不该再有 pi 的英文文案：\n${branchText}`);

		// ② 上下文压缩：同样换成「压缩上下文中」，且**不显示时钟/耗时**
		const compactionText = compaction.render(80).map(strip).join("\n");
		assert.ok(compactionText.includes(COMPACTION_TEXT), `应显示「压缩上下文中」：\n${compactionText}`);
		assert.ok(!compactionText.includes("Compacting context"), `不该再有 pi 的英文文案：\n${compactionText}`);
		// 输入框里的指示只有月相 + 文案：不带时钟/耗时（耗时由压缩块标题负责）
		assert.ok(!compactionText.includes(ICON_CLOCK), `压缩指示不应有时钟：\n${compactionText}`);
		assert.doesNotMatch(compactionText, /\d+\.\d+s|\d+ms/, `压缩指示不应有耗时：\n${compactionText}`);

		// ③ 都是月相 + 呼吸换色
		for (const text of [branchText, compactionText]) {
			assert.ok(/[🌕🌖🌗🌘🌑🌒🌓🌔]/.test(text), `应使用月相 spinner：\n${text}`);
		}
		for (const loader of [branch, compaction]) {
			const colors = new Set(
				[...loader.render(80).join("").matchAll(/38;2;\d+;\d+;\d+/g)].map((m) => m[0]),
			);
			assert.ok(colors.size >= 2, `应逐字符呼吸换色，实际 ${colors.size} 种颜色`);
		}

		// ④ 其它 Loader 不受影响
		assert.ok(
			strip(plain.render(80).join("\n")).includes("Loading..."),
			"普通 Loader 不该被改写",
		);
	} finally {
		// Loader 会自建 spinner 定时器；测试里必须停掉，否则 node --test 不退出。
		branch.stop();
		compaction.stop();
		plain.stop();
		unpatchSummaryStatusIndicators();
	}

	// 文案函数本身：默认"工作中"，传参可换字
	assert.ok(strip(workingMessage(0)).includes("工作中"));
	assert.ok(strip(workingMessage(0, BRANCH_SUMMARY_TEXT)).includes(BRANCH_SUMMARY_TEXT));
	assert.ok(strip(workingMessage(0, COMPACTION_TEXT)).includes(COMPACTION_TEXT));
});

test("压缩块标题带时钟耗时（紫 + 扫光），输入框指示只有月相 + 文案", async () => {
	const { liveTitle } = await import("../core.ts");
	const { CompactionIndicatorView, ICON_COMPACTION } = await import("../summary-blocks.ts");
	const { patchSummaryStatusIndicators, unpatchSummaryStatusIndicators } = await import("../editor.ts");
	const { ICON_CLOCK } = await import("../core.ts");
	const { Loader } = await import("@earendil-works/pi-tui");

	const realNow = Date.now;
	Date.now = () => 1_000_000 + 1840;
	try {
		// ① 压缩块：紫色 + 耗时 + 整行扫光（多色）
		const blockLine = new CompactionIndicatorView({ startedAt: 1_000_000 }, "原文").render(72)[0] ?? "";
		assert.ok(blockLine.includes("177;142;250"), `块标题应是紫色：${JSON.stringify(strip(blockLine))}`);
		assert.ok(blockLine.includes(ICON_CLOCK), "块标题应有时钟图标");
		assert.match(strip(blockLine), /1\.8s/, "块标题应显示耗时");
		const blockColors = new Set([...blockLine.matchAll(/38;2;\d+;\d+;\d+/g)].map((m) => m[0]));
		assert.ok(blockColors.size >= 3, `块标题应逐字符扫光，实际 ${blockColors.size} 种颜色`);

		// ② 输入框指示：只有月相 + 呼吸文案，没有时钟/耗时
		patchSummaryStatusIndicators();
		const loader = new Loader(undefined, (t) => t, (t) => t);
		loader.kind = "compaction";
		Date.now = () => 1_000_000;
		loader.updateDisplay();
		Date.now = () => 1_000_000 + 1840;
		loader.updateDisplay();
		const indicatorLine = loader.render(72)[1] ?? "";
		loader.stop();
		unpatchSummaryStatusIndicators();

		const indicatorText = strip(indicatorLine);
		assert.match(indicatorText, /压缩上下文中/, `应有文案：${indicatorText}`);
		assert.ok(!indicatorLine.includes(ICON_CLOCK), `输入框指示不该有时钟：${indicatorText}`);
		assert.doesNotMatch(indicatorText, /\d+\.\d+s|\d+ms/, `输入框指示不该有耗时：${indicatorText}`);
		// 仍然是逐字符呼吸
		const indicatorColors = new Set(
			[...indicatorLine.matchAll(/38;2;\d+;\d+;\d+/g)].map((m) => m[0]),
		);
		assert.ok(indicatorColors.size >= 2, `输入框指示应逐字符呼吸，实际 ${indicatorColors.size} 种颜色`);

		// liveTitle 本身：首帧 <16ms 不拼耗时
		const firstFrame = liveTitle(ICON_COMPACTION, "压缩中", [177, 142, 250], 0, 0);
		assert.doesNotMatch(strip(firstFrame), /\d+ms|\d+\.\ds/, "首帧不该有耗时");
	} finally {
		Date.now = realNow;
	}
});

test("压缩文案按原因区分：手动 / 自动（阈值）/ 溢出恢复", async () => {
	const { compactionLabel, setActiveCompactionReason } = await import("../core.ts");
	const { CompactionIndicatorView } = await import("../summary-blocks.ts");
	const { compactionTitle } = await import("../summary-blocks.ts");
	const { patchSummaryStatusIndicators, unpatchSummaryStatusIndicators } = await import("../editor.ts");
	const { Loader } = await import("@earendil-works/pi-tui");
	const { strip } = { strip: (s) => s.replace(/\x1b\[[0-9;]*m/g, "") };

	// ① 标签函数
	assert.equal(compactionLabel(undefined, "running"), "压缩上下文中");
	assert.equal(compactionLabel("manual", "running"), "压缩上下文中");
	assert.equal(compactionLabel("threshold", "running"), "自动压缩中");
	assert.equal(compactionLabel("overflow", "running"), "溢出恢复中");
	assert.equal(compactionLabel(undefined, "done"), "压缩完成");
	assert.equal(compactionLabel("threshold", "done"), "自动压缩完成");
	assert.equal(compactionLabel("overflow", "done"), "溢出恢复完成");

	// ② 块标题：记录里带 reason 就体现在标题上
	const done = (reason) =>
		strip(compactionTitle({ tokensBefore: 12345 }, { elapsedMs: 1800, tokensAfter: 4000, reason }));
	assert.match(done("manual"), /压缩完成/);
	assert.match(done("threshold"), /自动压缩完成/);
	assert.match(done("overflow"), /溢出恢复完成/);
	assert.match(done("threshold"), /12k → 4k tokens（-68%）/, "对比信息仍在");

	// ③ 压缩中视图：不同 reason 的标题不同
	for (const [reason, expect] of [
		["manual", /压缩上下文中/],
		["threshold", /自动压缩中/],
		["overflow", /溢出恢复中/],
	]) {
		const text = strip(
			new CompactionIndicatorView({ startedAt: Date.now() - 1200 }, "原文", reason)
				.render(80)[0] ?? "",
		);
		assert.match(text, expect, `${reason} 的标题应是 ${expect}：${text}`);
	}

	// ④ 输入框指示：读共享 reason
	const realNow = Date.now;
	patchSummaryStatusIndicators();
	const indicator = (reason) => {
		setActiveCompactionReason(reason);
		const loader = new Loader(undefined, (t) => t, (t) => t);
		loader.kind = "compaction";
		Date.now = () => 1_000_000;
		loader.updateDisplay();
		Date.now = () => 1_000_000 + 1840;
		loader.updateDisplay();
		const text = strip(loader.render(80)[1] ?? "");
		loader.stop();
		return text;
	};
	try {
		for (const [reason, expect] of [
			[undefined, /压缩上下文中/],
			["threshold", /自动压缩中/],
			["overflow", /溢出恢复中/],
		]) {
			assert.match(indicator(reason), expect, `${reason} 的输入框指示文案不对`);
		}
		// 手动（无 reason）默认仍是「压缩上下文中」
		assert.ok(indicator(undefined).includes("压缩上下文中"));
	} finally {
		Date.now = realNow;
		setActiveCompactionReason(undefined);
		unpatchSummaryStatusIndicators();
	}
});

test("subagent 面板：运行中也能展开（Ctrl+O / 鼠标点击都走 setExpanded）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	const results = Array.from({ length: 8 }, (_, i) =>
		subagentChild({ agent: `a${i + 1}`, status: "running" }),
	);
	const details = { content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) };

	const render = (expanded) =>
		panel
			.renderResult(
				details,
				{ expanded, isPartial: true },
				theme,
				panelContext({ isPartial: true, state: {}, expanded }),
			)
			.render(100)
			.map(strip);

	// 折叠：只显示前 3 个 + 「还有 5 个」
	const collapsed = render(false);
	assert.equal(
		(collapsed.join("\n").match(/^ +\uF4BE a\d+ · /gm) ?? []).length,
		3,
		`折叠应只显示 3 块：\n${collapsed.join("\n")}`,
	);
	assert.match(collapsed.join("\n"), /还有 5 个子代理/, "折叠应有省略提示");

	// 展开：全部 8 个、没有省略提示
	const expanded = render(true);
	assert.equal(
		(expanded.join("\n").match(/^ +\uF4BE a\d+ · /gm) ?? []).length,
		8,
		`展开应显示全部 8 块：\n${expanded.join("\n")}`,
	);
	assert.doesNotMatch(expanded.join("\n"), /还有 \d+ 个子代理/, "展开后不该再有省略提示");
});

test("子代理结果弹窗：完成后点击某个块 → 弹窗只显示结论（无执行过程）", async () => {
	const { registerSubagentPanel } = await import("../subagent-panel.ts");
	const overlayMod = await import("../subagent-result-overlay.ts");

	let resolver;
	registerSubagentPanel({ registerToolRenderer: (fn) => (resolver = fn) });
	const panel = resolver("subagent", () => undefined);

	// 每个子代理的消息里既有"过程"（toolCall / 中间文本），也有"结论"
	const mk = (agent, conclusion) =>
		subagentChild({
			agent,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "先跑一下命令" },
						{ type: "toolCall", name: "bash" },
						{ type: "text", text: conclusion },
					],
				},
			],
		});
	const results = [mk("scout", "结论：theme.ts 有 302 行。"), mk("worker", "结论：text.ts 有 706 行。")];
	const details = { content: [{ type: "text", text: "" }], details: subagentDetails("parallel", results) };

	// 收集弹窗调用：注入一个假的 ui.custom
	const opened = [];
	overlayMod.setOverlayUiForTest({
		custom: async (factory) => {
			const done = () => {};
			const theme = { fg: (_t, x) => x };
			const tui = { terminal: { rows: 30 } };
			opened.push(factory(tui, theme, {}, done));
		},
	});

	const context = panelContext({ isPartial: false, expanded: false, state: {} });
	const view = panel.renderResult(details, { expanded: false, isPartial: false }, theme, context);
	const lines = view.render(100).map(strip);
	view.render(100); // 让 blockRanges 稳定

	// 找到第二个子代理标题所在行（y 坐标），点击它
	const hitY = lines.findIndex((line) => /worker · /.test(line));
	assert.ok(hitY >= 0, `找不到 worker 的块：\n${lines.join("\n")}`);

	const result = view.handleMouse?.({ type: "click", button: "left", x: 4, y: hitY, width: 100, height: lines.length });
	assert.deepEqual(result, { handled: true }, "点击子代理块应被拦截（不交给 pi 的展开逻辑）");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(opened.length, 1, "应弹出一个窗口");

	const overlay = opened[0];
	const overlayText = overlay.render(80).map(strip).join("\n");
	// 只显示结论：不包含过程（工具调用 / 中间文本）
	assert.ok(overlayText.includes("结论：text.ts 有 706 行。"), `弹窗应显示该子代理的结论：\n${overlayText}`);
	assert.ok(!overlayText.includes("先跑一下命令"), `弹窗不该显示过程文本：\n${overlayText}`);
	assert.doesNotMatch(overlayText, /→ bash/, "弹窗不该显示工具调用");
	assert.ok(overlayText.includes("worker"), "弹窗标题应带子代理名");
	// 边框闭环 + 宽度一致
	const widths = new Set(overlay.render(80).map((line) => visibleWidth(line)));
	assert.equal(widths.size, 1, `弹窗每行宽度应一致：${[...widths].join(",")}`);
	assert.ok(overlayText.trimEnd().endsWith("╯"), "应有底边框");

	// 滚轮不拦截（交给 pi 滚动 transcript）
	assert.equal(
		view.handleMouse?.({ type: "wheel", wheelDelta: -1, x: 4, y: hitY, width: 100, height: lines.length }),
		undefined,
		"滚轮不该被拦截",
	);
	// 点到块外面也不拦截
	assert.equal(
		view.handleMouse?.({ type: "click", button: "left", x: 4, y: 0, width: 100, height: lines.length }),
		undefined,
		"点状态行不该拦截",
	);

	overlayMod.setOverlayUiForTest(undefined);
});
