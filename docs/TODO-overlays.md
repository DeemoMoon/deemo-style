# 待做：pi overlay（弹窗）面板清单

> 状态：**未开工**。本文是 2026-11 讨论的结论存档，供以后决定做哪些。
> 相关代码改动目前只有「方案 A：整轮结束后跳回回复开头」（已在 `reading.ts` 实现，见文末）。

---

## 0. 一句话背景

高速模型两秒刷满几屏 → 生成完停在末尾要手动翻回去。
方案 A（自动跳回回复开头）已解决"看结尾"的问题，但**"通读 / 对照 / 查看环境信息 / 调参数"**这些需求还没有着落，
而 pi 的 overlay API 正好适合做"按需弹出的临时面板"。

---

## 1. overlay 机制（已核对 1.5.2 源码）

### 1.1 打开 / 关闭

```ts
// 快捷键或 /命令里
await ctx.ui.custom(
    (tui, theme, keybindings, done) => new MyPanel(...ctx, () => done(undefined)),
    { overlay: true, overlayOptions: { width: "85%", maxHeight: "85%", anchor: "center", margin: 1 } },
);
```

- 返回 `Promise<T>`，组件里调用 `done(value)` 关闭，焦点自动回输入框。
- `overlayOptions` 支持：`width` / `minWidth` / `maxHeight`（数字或 `"85%"`）、`anchor`、`offsetX/Y`、`row/col`、`margin`、
  `visible(termW, termH)`、`nonCapturing`（不抢键盘焦点 → 只能做只读 HUD）。
- 非 overlay（`overlay: false`）会**内联插在对话流里**并等待 `done()`，适合"向导式"流程。

### 1.2 键盘

组件实现 `handleInput?(data: string): void`，用 `matchesKey(data, "pageup" | "escape" | "up" …)` 判断
（`matchesKey`、`isKeyRelease` 都从 `@earendil-works/pi-tui` 导出）。
`capturesViewportInput?: boolean` 可让组件接管 alt-screen 的滚动键。

### 1.3 已验证可用的数据 / 操作 API

| 类别 | API |
|---|---|
| 模型 | `ctx.model`（id/provider/contextWindow）、`ctx.modelRegistry`、`ctx.scopedModels`、`pi.setModel(model)` |
| 思考等级 | `ctx.thinkingLevel`、`pi.getThinkingLevel()`、`pi.setThinkingLevel(level)` |
| 会话 | `ctx.sessionManager`：`getCwd/getSessionId/getSessionFile/getSessionDir/getSessionName/getBranch/getTree/getLeafId/getEntry/getLabel/buildContextEntries`；`pi.setSessionName()`、`pi.setLabel()` |
| 上下文 | `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` |
| 工具 | `pi.getActiveTools()`、`pi.getAllTools()`、`pi.setActiveTools(names)` |
| 设置 | `pi.getSettings()`（只读快照） |
| 命令 | `pi.getCommands()`（含描述/来源）、`pi.registerCommand` |
| 输入/输出 | `ctx.ui.pasteToEditor(text)`（回填输入框）、`pi.sendUserMessage()`、`pi.appendEntry()`（自定义条目持久化）、`pi.exec(cmd, args)` |
| 环境 | `ctx.isIdle()`、`ctx.isProjectTrusted()`、`ctx.signal`、`VERSION`（pi 版本） |
| pi-tui 组件 | `Markdown`（需 `getMarkdownTheme()`）、`Text`、`Box`、`Input`、`SelectList`、`Image`、`Spacer`、`matchesKey`、`truncateToWidth`、`visibleWidth` |

**内部但运行时可用**（TS 标 private，必须 `typeof` 守卫 + try/catch，regular 模式没有）：

| 成员 | 用途 |
|---|---|
| `tui.isFollowingOutput`（**public**） | 是否跟随底部 |
| `tui.scrollToPrompt(±1)` | 按 OSC133;A 行首标记跳消息（`Ctrl+↑/↓` 的实现） |
| `tui.getPrimaryScrollView()` → `.viewportHeight` / `.scrollTo(row)` | 视口高度 / 精确定位 |
| `tui.scrollToTop()` / `scrollToBottom()`（**public**） | 会话顶/底 |

### 1.4 坑（每个面板都要注意）

1. overlay **默认独占键盘**；`nonCapturing` 能避免抢焦点，但也就收不到按键（只能纯展示）。
2. **宽度由弹窗决定**（如 85%），内容要按弹窗内宽重渲染，缓存按宽度做。
3. **打开时取快照**；数据变了要重开或加 `r` 刷新键。
4. **只读优先**：需要修改时用官方 setter（`setModel`/`setThinkingLevel`/`setSessionName`/`setActiveTools`），
   **不要**让弹窗去写 `settings.json`（写坏配置风险不值得）。
5. 快捷键：`alt+*` 可能被终端吃；建议 `alt+i` / `alt+p` / `alt+o` / `alt+d`，都能在 `keybindings.json` 里改。
6. 不适合 overlay 的：需要常驻刷新的（用 widget/状态栏）、需要大量文字编辑的（用编辑器）。

---

## 2. 候选面板清单
编号沿用讨论时的序号。「成本」为大致行数（含按键/渲染/测试）。

### 第一批（信息/浏览）

| # | 面板 | 内容 | 数据来源 | 成本 | 评价 |
|---|---|---|---|---|---|
| 1 | **环境信息面板**（`alt+i`） | 模型 `id(provider)` / 上下文窗口 / 思考等级 / 会话名 / 会话 id / 会话文件 / cwd / 分支 / 上下文占用 + 色条 / 累计费用 / 缓存命中率 / git 状态 / 工具数 / 技能与扩展数 / pi 版本 | `ctx.model`、`ctx.thinkingLevel`、`ctx.sessionManager.*`、`ctx.getContextUsage()`、`pi.getActiveTools()`、`pi.getSettings()`、`pi.exec("git",…)`、`VERSION` | ~120 | **✅ 已实现**（`info-panel.ts` + `session-stats.ts`，`alt+i`；带边框居中、可改会话名/模型/思考强度、模型与思考用 `SelectList` 内联下拉、支持鼠标点击） |
| 2 | 环境面板「可改」版 | 同 1，且能改 | 同上 + `pi.setModel/setThinkingLevel/setSessionName/setActiveTools` | ~200 | 省掉 `/model`、`/thinking` 两步 |
| 3 | 消息/轮次浏览器 | 本轮或最近 N 轮完整对话（正文 Markdown、思考可切、工具压一行） | `sessionManager.getBranch()` | ~300 | 工作量最大，见 §4 |
| 4 | 技能/扩展清单 | 名字、启用状态、路径、SKILL.md 首行 | 复用 `startup.ts` 的 `collectStartupData()` | ~150 | 回车预览；**不建议**在这里写 settings |
| 5 | 诊断面板（`alt+d`） | 实时 tok/s、首字延迟、token/字符校准、缓存命中、信息条内部状态、重绘节拍、上次工具耗时 | 扩展内部数据（infobar/statusline/clock） | ~150 | 排查"卡/计时跳"用 |
| 6 | 悬浮 HUD（`nonCapturing`） | 右上角常驻：tok/s 迷你条、上下文占用、模型/思考等级 | 同 1/5 | ~120 | 视觉收益大但会遮挡内容 |
| 7 | 危险操作确认 | "确定清空会话/丢弃未完成工具调用吗" + 上下文摘要 | `ctx.ui.confirm` 或自制 | ~60 | 小手滑防护 |
| 8 | 配色/主题速查 | 当前主题 token 与我们的配色（色块 + RGB） | `ctx.ui.theme`、`getMarkdownTheme()` | ~90 | 调 UI 时对照用 |
| 9 | 会话树只读概览 | 分支/条目/时间/token | `sessionManager.getTree()` | ~150 | 跳转需 command context，待确认 |

### 第二批（操作/导航/展示/元工具）

| # | 面板 | 内容 | 数据来源 / API | 成本 | 评价 |
|---|---|---|---|---|---|
| 10 | **UI 参数编辑器**（`alt+p`） | `FEATURES` + 30 个常量做成表单（开关/数字/颜色），保存到 `~/.pi/agent/ui-style.json` | `ctx.ui.custom` + `Input`/`SelectList`；读写自己的 json | ~250 | **对本项目价值最高**：不改代码调 UI，还能给别人一份配置 |
| 11 | 命令/提示面板 | fuzzy 搜命令 + 技能 + prompt 模板 → 回填输入框 | `pi.getCommands()` + `ctx.ui.pasteToEditor()` | ~120 | 比背 `/xxx` 省事 |
| 12 | 待办/计划面板 | 长任务步骤清单，模型也能读写 | `pi.appendEntry()` 持久化 + overlay 编辑 | ~200 | 官方有 `todo.ts` 示例 |
| 13 | 新建会话向导 | 一步填名称/模型/思考等级/首 prompt | `pi.setSessionName/setModel/setThinkingLevel` + 命令上下文 `newSession` | ~150 | **已出设计稿：`DESIGN-new-session-wizard.md`** |
| 14 | 危险操作确认（增强版） | 见 7，可带更多上下文 | 同上 | ~60 | 与 7 合并 |
| 15 | **用户消息大纲 / 跳到第 k 条** | 列出用户消息首行 → 选中**直接跳转** | 反复调用 `tui.scrollToPrompt(-1)` k 次（fullscreen） | ~140 | "翻历史"的正解 |
| 16 | **完整 diff 查看器** | edit 块弹窗滚动看整段 diff（不撑爆 transcript） | `details.diff` + `colorizeDiffLine` | ~100 | 实用 |
| 17 | Git 面板 | 分支/状态/最近提交 → 把 diff 或提交信息插进对话 | `pi.exec("git", …)` + `pasteToEditor` | ~150 | review 场景 |
| 18 | 书签面板 | 给条目打书签，列表跳回 | `pi.setLabel()`（官方有 `bookmark.ts`） | ~120 | 中 |
| 19 | 会话树只读概览 | 同 9（合并） | `getTree()` | ~150 | 跳转受限 |
| 20 | 图片放大 | 工具结果里的截图/图表，按终端能力放大 | `Image` 组件 + `getCapabilities().images` | ~120 | 需 kitty/iTerm2/sixel |
| 21 | 技能/扩展点开看 | 启动页资源清单改成可点击 | 同 4 | ~100 | 启动页现在是静态文本 |
| 22 | 快捷键冲突检查 | 列出用户自定义键位与默认键位冲突 | `KeybindingsManager.getEffectiveConfig()`（带 `conflicts`） | ~80 | 几乎白捡 |
| 23 | 通知历史 | 回看 `ui.notify` 的提示 | 自己记账 | ~80 | 低 |
| 24 | **兼容性自检** | 逐个验证原型补丁依赖的 pi 内部结构（`contentContainer`/`mouseLayout`/`outputPad`/`setHideThinkingBlock`/`scrollToPrompt`/`addAutocompleteProvider`…），缺哪个列哪个 | 直接探测各对象的 `typeof` / 字段 | ~120 | **pi 升级后一眼看出哪里坏了**（这套补丁很多） |
| 25 | 渲染/帧率诊断 | 重绘次数、缓存命中率、每帧耗时、计时口径 | 扩展内部 | ~150 | 与 5 合并成两个页签 |

---

## 3. 架构结论（重要）

上面所有面板的**外壳完全一样**：标题行 + 行数组 + 滚动 + 键位。

所以正确顺序是：**先写一个 overlay 基建**（约 120 行），之后每个面板只是"提供内容 + 可选按键"（**40–60 行**）。

基建草案：

```ts
// ui-style.modules/overlay.ts
export interface PanelSpec {
    title: string;                  // 顶行：标题 + 可选副标题
    lines: string[];                // 已渲染好的行（按面板宽度）
    hint?: string;                  // 底行键位提示，如 "↑↓ 滚动 · Esc 关闭"
    onKey?(key: string): "close" | "handled" | "rerender" | undefined;
    /** 宽度变化时重新生成行（Markdown 按内宽重排）。 */
    rebuild?(width: number): string[];
}
export function openPanel(ctx, spec): Promise<void>;
```

内置键位：`↑↓/kj` 一行、`PgUp/PgDn` 一屏、`Home/End`、`g/G`、`Esc/q` 关闭。
面板只需给出 `lines`（+ 可选 `onKey`）。

---

## 4. 消息/轮次浏览器（#3）单独说明

| 部分 | 做法 | 成本 |
|---|---|---|
| 数据提取 | `getBranch()` → 过滤 message 条目 → 组装"轮"：`{ userText, blocks: [text \| thinking \| toolCall+result] }`，默认取最近 1 轮，`[`/`]` 切换 | ~80 |
| 渲染 | 标题行；用户消息 `❯ …`；助手正文用 `new Markdown(text, 1, 0, getMarkdownTheme())` 渲染成行；思考 dim（`t` 切显示）；工具调用压 1 行（`⚡ Bash · 1.2s · 9 行`），`o` 展开当前块 | ~80 |
| 滚动/按键 | 手动切片窗口（O(视口)）：`↑↓ PgUp PgDn Home/End g G [ ] t o Esc` | ~60 |
| 接线 | `alt+u` 打开；`pi.registerShortcut` | ~30 |
| **合计** | | **~300** |

精简版 **C1**（只显示最近一条回复 + ↑↓/PgUp/PgDn/Esc + `t` 切思考）：**~150 行**。

> 结论：C1 够用；完整版只在"经常跨轮对照/复制"时才值得。

---

## 5. 推荐顺序（如果以后开做）

1. **overlay 基建**（120 行，一次投入）
2. **#24 兼容性自检**（~120 行）——你改动最频繁的地方，升级 pi 后立刻能定位问题
3. **#10 UI 参数编辑器**（~250 行）——把"改代码调参数"变成"弹窗调 + json 保存"
4. **#15 消息大纲/跳转**（~140 行）——"翻历史"的正解
5. **#16 完整 diff**（~100 行）
6. 其余（待办、Git、命令面板、书签、图片放大…）按需再加

理由：2 和 10 直接服务"这套 UI 本身的可维护性"，15/16 直接解决日常阅读痛点，其余是锦上添花。

---

## 6. 待定问题（开工前需拍板）

1. 第一批要不要先做 **#1 只读环境面板**，还是直接上 **#1+#2**（可改）？
2. **#10 参数编辑器**的配置文件位置/格式：`~/.pi/agent/ui-style.json`（推荐）？还是跟着扩展目录？
3. **#15 消息大纲**是否一起做（它依赖 fullscreen 的 `scrollToPrompt`，regular 模式只能"看"不能"跳"）？
4. 快捷键分配：`alt+i`（info）/ `alt+p`（params）/ `alt+o`（outline）/ `alt+d`（diff）/ `alt+c`（compat 自检）？
   是否同时提供同名 `/命令`（命令更好发现）？
5. 要不要 **#6 悬浮 HUD**（`nonCapturing`）——收益大但遮内容。

---

## 7. 已实现的相关能力（供参考，避免重复做）

| 能力 | 位置 | 说明 |
|---|---|---|
| 整轮结束后跳回回复开头 | `reading.ts` + `FEATURES.jumpToReplyStart` | `agent_settled` 时若"仍在跟随 + 回复 > 视口 70%"→ `tui.scrollToPrompt(-1)`；取不到视口高度时用 20 行兜底 |
| 助手消息 / 用户消息成为 `Ctrl+↑/↓` 落点 | `assistant.ts`（OSC133;A 留在第 0 列）、`user-message.ts` | 一跳一条消息 |
| 工具框/思考框尾窗（3 行 / 12 行）+ 无打字机 | `panels.ts`、`assistant.ts`、`core.ts` | 完成后定格尾部，不再收成一行 |
| 标题整行扫光（图标→工具名/思考中→时钟→耗时） | `panels.ts`、`assistant.ts` | `shimmerText()` |
| 会话统计（费用/缓存/上下文色条） | `statusline.ts` | 面板 #1 可直接复用这些计算 |
| 技能/扩展收集 | `startup.ts`：`collectStartupData()` | 面板 #4/#21 可直接复用 |

---

## 8. 参考资料（本机路径）

```
pi 包：/home/linuxbrew/.linuxbrew/Cellar/pi-coding-agent/1.5.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent
示例：
  examples/extensions/doom-overlay/index.ts     overlay + overlayOptions 用法
  examples/extensions/overlay-qa-tests.ts       handleInput / matchesKey / Input 用法
  examples/extensions/todo.ts                   appendEntry 持久化 + overlay
  examples/extensions/bookmark.ts               setLabel + 跳转
类型：
  dist/core/extensions/types.d.ts               ExtensionAPI / ExtensionContext / ExtensionUIContext
  node_modules/@earendil-works/pi-tui/dist/tui.d.ts            Component / OverlayOptions
  node_modules/@earendil-works/pi-tui/dist/components/scroll-view.d.ts
```

---

## 9. 待做的重构（2026-11-15 批次 4 未完成部分）

这些问题在评审里被指出，但本轮**只做了低风险部分**，剩下两项留待以后：

| 项 | 现状 | 为什么先不做 |
|---|---|---|
| **`ansi.ts` 拆分** | ANSI 剥离/清洗仍在 `core.ts`（`stripAnsi` / `cleanText` / `hasVisibleText` / `stripBom` / `OSC_CSI_SOURCE`）。`path-text.ts` 已经拆出去了 | 常量之间有引用关系，抽取时连续两次把 import 块改坏；等有稳定测试基线后一次性做 |
| **`TailWindowView` 合并** | `core.LiveTailView` 与 `assistant.ThinkingPreviewView` 各自维护"尾部 + ⎿ + 渐变 + 光标" | 两者差异比看起来大（思考块有渐变和 run 计时，工具框有 `LIVE_PANEL_LINES` 与光标），合并要重写两个类的缓存键，风险高于收益 |
| **`PANEL_FACTORIES` 收敛** | `write`/`edit`/`ls` 仍是特例工厂，其余走 `simplePanel` | 表驱动已经足够短，收敛只是省几行 |

已完成的拆分：`path-text.ts`（路径显示）、`levels.ts`（思考档位 + 配色）、`context-bar.ts`（色条 + 档位阈值）、
`session-stats.ts`（会话统计）；`info-panel.ts` 与 `statusline.ts` 的重复实现已删除，色条字形/颜色现在只有一套来源。
