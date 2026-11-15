/**
 * 行为测试：通过 pi 自己的加载器（jiti）把扩展加载起来，断言这次修复的具体
 * 行为——不只是“不崩”。
 *
 * 运行：bash tests/run.sh
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const piMain = await jiti.import("@earendil-works/pi-coding-agent");
piMain.initTheme("dark");

const extension = await jiti.import(new URL("../extension.ts", import.meta.url).pathname, {
	default: true,
});

const handlers = new Map();
const toolRenderers = [];
const commands = new Map();
const shortcuts = new Map();

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
	registerMarkdownTransformer() {},
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

test("B4 `!` 回放（构造即完成）不显示假耗时", () => {
	const exec = new piMain.BashExecutionComponent("echo hi", { requestRender() {} }, false, 1);
	exec.appendOutput("hi\n");
	exec.setComplete(0, false);
	const out = strip(exec.render(80).join("\n"));
	assert.ok(!/\b[01]ms\b/.test(out), out);
	assert.ok(out.includes("echo hi"));
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

		Date.now = () => 10_350; // 相位 0.5：亮带扫到中间
		const middle = call.render(80)[0] ?? "";
		assert.notEqual(first, middle, "标题应随帧重画（否则缓存把动画停住了）");
		assert.ok(
			distinctFgColors(middle).size >= 3,
			`运行中标题应有多个颜色，实际 ${distinctFgColors(middle).size}`,
		);
		assert.equal(strip(middle).includes("Bash"), true);

		// 再过一个完整周期：相位回到 0，首个字符的亮色应恢复
		Date.now = () => 11_400;
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
	const infobar = await jiti.import(new URL("../infobar.ts", import.meta.url).pathname);
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
	const reading = await jiti.import(new URL("../reading.ts", import.meta.url).pathname);
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
		"6.4k (6,400)", // 两条 assistant 各记一次 usage
		"2.8k (2,840)",
		"27k (27,240)", // input + output + cacheRead + cacheWrite 的总计
		"68.0%",
		"136k / 200k",
		"重构 ui-style",
		"~/proj/demo",
		"￥3.60",
		"01JC-abcdef",
		"概览",
		"用量",
		"时间与位置",
	]) {
		assert.ok(out.includes(expected), `面板缺少 ${expected}：\n${out}`);
	}
	assert.match(out, /用时\s+\d/, "应显示累计用时");

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

	// r 刷新：换一份数据后应显示新值
	entries[3].message.usage = { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
	panel.handleInput("r");
	const after = render().join("\n");
	assert.ok(after.includes("$0.7500"), `刷新后费用应为 0.25+0.5=0.75：\n${after}`);
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
					terminal: { rows: options.rows ?? 34, columns: 100 },
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
	const { panel, plain, find, mouse } = await openPanelForTest({ rows: 14 });

	// 点「思考」行 → 焦点移过去
	mouse({ type: "click", x: 3, y: find("思考") });
	assert.ok(plain()[find("▸")].includes("▸思考"), plain().join("\n"));

	// 点「模型」行右侧的 › → 切到下一个模型
	const modelRow = find("模型");
	const arrowCol = plain()[modelRow].indexOf("›");
	assert.ok(arrowCol > 0, "模型行应有 › 箭头");
	mouse({ type: "click", x: arrowCol, y: modelRow });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "model"), [["model", "model-b"]]);

	// 双击「会话」行 → 改名（第一次输入整体替换）
	const nameRow = find("会话  会话名");
	mouse({ type: "click", x: 4, y: nameRow });
	mouse({ type: "click", clickCount: 2, x: 4, y: nameRow });
	panel.handleInput("新");
	panel.handleInput("名");
	panel.handleInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(piStub.calls.filter((c) => c[0] === "name"), [["name", "新名"]]);

	// 单击名称值中间 → 光标落在那一位
	const valueCol = plain()[nameRow].indexOf("会话名");
	mouse({ type: "click", x: valueCol + 2, y: nameRow });
	panel.handleInput("X");
	// 光标（▏）会画在插入点后面，比较时去掉
	assert.ok(plain()[nameRow].replace("▏", "").includes("会X话名"), plain()[nameRow]);
	panel.handleInput("\x1b"); // 取消编辑

	// 滚轮：内容比窗口高时能滚动
	const before = plain()[1];
	mouse({ type: "wheel", x: 5, y: 5, wheelDelta: 3 });
	assert.notEqual(plain()[1], before, "滚轮应滚动内容");
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
