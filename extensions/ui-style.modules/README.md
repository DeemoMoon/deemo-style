# ui-style.modules

`../ui-style.ts` 的实现代码。入口仍是 `extensions/ui-style.ts`（pi 只认
`extensions/*.ts` 和 `extensions/<dir>/index.ts`；本目录**故意**没有
`index.ts` / `package.json`，所以不会被当成第二个扩展加载）。

## 结构

| 文件 | 内容 |
|---|---|
| `core.ts` | **共享层入口（shim）**：只做 `export *`，把下面三层重新聚合成原来的出口，其它模块的 import 路径不用改 |
| `theme.ts` | `FEATURES` 开关、对齐系统与配色/图标常量、`⎿` 连接符、标题扫光（纯函数） |
| `text.ts` | 耗时/用量格式化、ANSI 清洗、折叠预览算法、上下文占用缓存、统一动画节拍 |
| `tail.ts` | `CachedView`（按宽度缓存 + 统一截宽）、`LiveTailView`（运行中的 tail -f 窗口）、`IndentedPreviewView` |
| `panels.ts` | 工具面板（bash / codemode / read / write / edit / grep / find / ls / powershell）；收起态统一 3 行尾窗，展开态 ls 用圆角框 |
| `subagent-data.ts` | 子代理面板的**数据层**：details 形状、图标常量、纯函数（状态标记 / 耗时 / 底行 / 标题 / display items / 结论折叠 / 过程摘要），可单测 |
| `subagent-block.ts` | **子代理块渲染**：`AgentBlockView`（块标题 → 黄色「任务」→ 滚动输出 / 结论头 4 行 → 过程摘要 → 底行）与行拼装助手；单个/并行/链式共用 |
| `subagent-panel.ts` | **子代理面板外壳**：`HeaderView`（call 区标题+任务）、进度点与状态行、窗口选择（并行 3 块轮播 / 链式只看当前步）、等高补齐、块渲染缓存、渲染器注册 |
| `edit-preview.ts` | edit 工具的**执行中 diff 预览**：参数归一、与 pi edit 同语义的精确/fuzzy 匹配、唯一命中/重叠检查、unified diff；独立成模块便于单测 |
| `assistant.ts` | 助手消息原型补丁（悬挂缩进 / 去背景 / 思考块折叠预览 / 鼠标坐标换算） |
| `skill-banner.ts` | 技能调用横幅原型补丁 |
| `bash-exec.ts` | `!` 内联命令的绿色圆角框（原型补丁） |
| `user-message.ts` | 用户消息样式 + markdown 变换（加粗/图标/h3~h6 改写） |
| `editor.ts` | 圆角输入框 + 输入符号 + 工作中呼吸文案 |
| `infobar.ts` | 输入框上方信息条 |
| `statusline.ts` | 输入框下方状态栏 |
| `levels.ts` | 思考档位（顺序 / 模型能力过滤 / 配色），状态栏与信息面板共用 |
| `context-bar.ts` | 上下文色条与档位阈值（`renderContextBar` / `levelOf`），两处共用 |
| `session-stats.ts` | **会话统计口径**（token / 费用 / 缓存命中率 / 轮次 / 用时），状态栏与信息面板共用 |
| `info-panel.ts` | **会话信息面板**（`alt+i`）：带边框居中的 overlay；改会话名 / 模型（下拉 + fuzzy 过滤）/ 思考强度，支持鼠标点击（行聚焦、点模型/思考的值展开下拉、`‹ ›` 快切、双击改名、点选下拉项、滚轮），并显示会话总时长 / 分支 / 目录与已加载的技能 / 扩展 / MCP 清单（startup.ts 共享扫描）；模型与思考是内联下拉 |
| `reading.ts` | 阅读辅助：整轮结束后把视口带回回复开头 |
| `startup.ts` | 启动页（异步扫描上下文/技能/扩展，in-flight 去重 + 按 cwd 缓存）；也是信息面板「加载」区的数据来源（`collectSessionResources()`，含 mcp.json 扫描；`force` 支持面板 `r` 重扫） |
| `extension.ts` | 默认导出：按 `FEATURES` 注册一切 |
| `tests/` | 单测 + 行为测试 |
| `TODO-overlays.md` | **待做**：overlay（弹窗）面板候选清单与结论（#1 信息面板已完成） |
| `DESIGN-new-session-wizard.md` | **设计稿**：新建会话向导（名称/模型/思考/首条消息，未实现） |

## 开关

`core.ts` 顶部的 `FEATURES`：把一个块改成 `false` 就整块停用（不用删代码）。
原型补丁类的块关闭后由 `extension.ts` 负责 `unpatch`，`/reload` 后不会残留旧闭包。

## 测试

```bash
bash ui-style.modules/tests/run.sh
```

脚本会在临时目录里搭一个只含符号链接的 `node_modules`（指向 pi 自带的
`@earendil-works/pi-tui` / `jiti` / `pi-coding-agent`），把本目录拷进去后用
`node --test` 跑。不会改动 `~/.pi/agent` 下的任何文件。

- `tests/pure.test.ts`：纯函数（格式化、折叠预览、ANSI 清洗、BlockClock…）。
- `tests/behavior.test.ts`：用 pi 自己的加载器（jiti）加载扩展，断言具体行为
  （OSC133 标记、thinking 折叠/展开、`!` 回放计时、edit 异步预览、极窄终端
  不输出超宽行、面板鼠标命中、超长行可视行封顶…）。
- `tests/static-check.mjs`：检查「用了别的模块导出却没 import」和「import 了但正文未使用」。

## 改 pi 内部实现时的注意点

这几个地方深度依赖 pi 的私有结构，`pi` 升级后优先检查：

1. `assistant.ts`：`contentContainer` / `mouseLayout` / `thinkingVisibilityOverrides`
   / `outputPad` / `isStreaming` / `setHideThinkingBlock`，以及 render 里
   OSC133 标记的位置（`renderStyled` 有 try/catch 回退到原生渲染）。
2. `bash-exec.ts`：**完全替换**了 `BashExecutionComponent.updateDisplay`，
   并复用 `outputLines` / `status` / `exitCode` / `loader` / `truncationResult` /
   `fullOutputPath` / `colorKey`（失败时会退回 pi 自己的 `updateDisplay`）。
3. `skill-banner.ts`：`setPaddingX` / `setBgFn` / `expand` / `skillBlock`。
4. `panels.ts`：`renderShell: "self"` 的渲染上下文（`state` / `lastComponent` /
   `durationMs` / `invalidate()`）。
   **`renderCall` 拿不到 `details`**（只有 args），实时数据只走 partial 的
   `renderResult`——所以「运行中块」必须在 `renderResult` 的 `isPartial` 分支画。
5. `subagent-panel.ts`：依赖 subagent 工具的 `details` 形状
   （`mode` / `results[].status|messages|usage|model|step|errorMessage`）。
   `renderResult` 的 partial 阶段才有这些数据；`renderCall` 只从 args 推标题。
6. `statusline.ts`：`footerData.getGitBranch()` / `getExtensionStatuses()`，
   `sessionManager.getBranch()` / `getLeafId()`。

## 设计要点（别改回去）

- **计时不用定时器**：`BlockClock` 只存 `startedAt`/`endedAt`，耗时在每次
  `render` 时现算，靠 pi 本来就有的帧（spinner 80ms / 信息条 200ms / bash
  partial result）带动。定时器方案会让 `updateDisplay()` 每 100ms 重建整棵
  组件树 + 全量重渲染 transcript，长会话明显卡顿，而且 pi 在某些路径不再回调
  `renderResult`，定时器停不下来。
- **回放不伪造耗时**：历史块没有本地时间戳（思考块 `unknown`、工具块用
  `toolResult.durationMs`）；`!` 回放时时钟只跨一帧，`execClockText` 会当成
  无数据（`MIN_EXEC_CLOCK_MS`）。
- **运行时动画全是纯函数**：标题扫光、工作中月相/呼吸都按“时间戳 + 位置”现算，不新开定时器。
  统一节拍是 `core.ts` 的 `ANIMATION_TICK_MS`（100ms）；月相帧间隔 `WORKING_INTERVAL_MS`
  与呼吸周期 `BREATH_PERIOD_MS` 在 `editor.ts` 顶部。**别把节拍调小**：它就是任务期间
  每秒全 transcript 重渲染的次数。
- **每帧都要缓存**：pi 的 ScrollView 无视口裁剪，`requestRender` 会重渲染整个
  transcript，所以每个自绘组件都走 `CachedView` / 宽度缓存。
- **绝不输出超宽行**：所有行最后都过 `truncateToWidth`（`CachedView` 统一做）；
  pi 遇到宽于终端的行会直接报错停掉 TUI。
- **对齐只有两个数字**：`MESSAGE_ICON_WIDTH` / `BLOCK_INDENT_WIDTH`，其余
  （`GUTTER` / `UI_INDENT` / `CHROME_PAD` / `PROMPT_WIDTH`）都是派生值。
