# Changelog

## [1.3.0] - 2026-11-19

### 新功能：子代理面板（subagent 工具）
把 pi 自带 subagent 扩展的「✓✗⏳ + ─── Step ───」默认渲染收进本扩展的统一视觉
（Nerd Font 图标 + 着色标题 + `⎿` 滚动窗口 + BlockClock 计时），支持单个 / 并行 /
链式三种模式。拆成三层：`subagent-data.ts`（纯函数）→ `subagent-block.ts`（块渲染）
→ `subagent-panel.ts`（窗口与入口）。

- **每个块 = 缩小版单个 agent**：块标题（`\uF4BE 名称 · ⏱ 耗时 · 状态标记`，运行中整行
  扫光）→ 黄色 `「任务」`（完整显示，含链式的 `{previous}`，段落空行压缩）→ 4 行滚动
  输出（运行中，末行 `▍`）或结论头 4 行 + `还有 N 行`（完成）→ 过程摘要/过程列表 →
  底行（token · 模型 · 思考强度 · 命中率）。`Ctrl+O` 展开全文与工具调用过程。
- **单个模式不做两级结构**：标题已含名称，不再来一层 `⎿ \uF4BE ⏳ 名称`。
- **并行**：固定窗口 3 个块 + 每 2.5s 轮播（环绕），`还有 N 个子代理` 提示；窗口内块
  等高补齐，轮播时整屏不跳。**不使用定时器**：相位由 `Date.now()` 算，搭 pi 自己的帧。
- **链式**：只显示当前这一步（有 running 显示它，否则第一个 pending，都结束显示最后
  一步），块标题保留 `1. / 2. / 3.` 编号。
- **进度点**：`●` 实心=有结果（绿成功、红失败）、`○` 空心=没结果（黄执行中、灰未开始）。
  全 1 列宽、非 emoji、点位固定。链式按 `args.chain.length` 一次画满（`details.results`
  是执行一步才长一个的）。
- **状态行**：块顶部一行兼做进度与汇总（`●●● 3/4 完成 · 1 失败 · in 5.4k · out 600 ·
  cache 80.0%`），命中率与底行同一套档位色；不再有独立的 `Total` 行。
- 修过的问题：`renderCall` 写死 running 导致结束后标题一直扫光、耗时一直涨；状态标记
  慢一帧（改为惰性读 `state.mark`）；等高补齐把链式补出一大片空白；轮播定时器导致
  8 任务时"屏幕闪一下"（已删除定时器）。

### 代码质量：原型补丁统一 + 一轮 bug 修复
- `core.ts` 新增 `patchPrototypeSlots` / `unpatchPrototypeSlots`（幂等 patch、按槽位
  所有权恢复、任何路径都清标志），assistant / skill-banner / bash-exec / user-message
  四处共用，删掉三套语义各异的哨兵逻辑。
- `core.ts`：`trimTrailingBlanks` 收敛两处尾部空行裁剪；新增 `chromeLine`；`tailVisualRows`
  改反向收集 + 一次 reverse；`LiveTailView` 新增 `indent` / `firstConnector` 选项。
- `panels.ts`：抽 `resetOnArgsChange`；diff 归一化提前到赋值时并缓存行；partial 输出从
  尾部累加（不再全量 join）；`cleanedTailText` 回扫限 40 字符。
- `info-panel.ts`：`withBusy()` 收敛三处 busy 拷贝；`attachListHandlers()` 收敛下拉回调。
- `session-stats.ts`：合并为单遍遍历（每条 entry 只 `Date.parse` 一次）。
- `editor.ts`：`BORDER_INSET` 常量消除三处硬编码。
- `infobar.ts`：tick 按"显示值快照"去重，没变不请求重绘；参数估算加 8KB 块级预算。
- `startup.ts`：技能递归同层并行、扩展入口探测短路、MCP 去重改 Set。

### 修复
- `panels.ts`：`hintOptions` 死代码导致自定义 `app.tools.expand` 键位提示不生效。
- `session-stats.ts`：无 timestamp 的 user 消息会把「上轮结束→现在」虚增进 `activeMs`。
- `info-panel.ts`：编辑态按 →/End/Ctrl+E/Delete 不清全选态；下拉鼠标转发 x 偏移少 2 列
  （漏 `ROW_PREFIX_WIDTH`）；`busy` 有微任务窗口导致连按 Enter 可重入并发 `setModel`。
- `edit-preview.ts`：FIFO/设备文件会让预览永久卡死（加 `info.isFile()`）；唯一性判断改
  单次扫描。
- `startup.ts`：非 git 目录下祖先 `.agents/skills` 被跳过；`~\foo` 展开残留反斜杠。
- `statusline.ts`：git 异步回调把旧 cwd 的结果写进新 cwd 的缓存槽；失败时多余的重绘。
- `user-message.ts`：`\uE370` 图标插在引用/标题/列表前缀之后，污染块结构。
- `path-text.ts`：`shortenHome` 在 Linux 上把 `/HOME/x` 误缩成 `~/x`；`toLowerCase()` 改变
  长度时 `slice` 错位。抽出纯函数 `stripHomePrefix(path, home, caseInsensitive)` 便于单测。
- `reading.ts`：跳回回复开头可能落到历史消息（同毫秒 timestamp / 历史重渲染）。
- `context-bar.ts`：填充格数与格子颜色档位错位（统一按中点口径）。
- `core.ts`：`LiveTailView.snapshot` 空文本边界判断不对称。

### 测试
- 97 → 120 个用例：原型补丁助手、`activeMs` 缺口、进度点颜色/间距、链式窗口选择、
  并行轮播相位、任务不丢字、任务区无空行、链式任务完整、等高补齐不产生空白等。
- `tests/static-check.mjs`：修展开运算符 `...name` 被误判成未使用的误报。

## [1.2.0] - 2026-11-17

### 会话信息面板改版（`alt+i`）
- 「概览」保留会话名 / 模型 / 思考强度（可改）+ 会话总时长 / 分支 / 目录；
  「加载」显示当前会话已启用的技能 / 扩展 / MCP（`startup.ts` 共享扫描）。
- 移除面板里的 token / 费用 / 上下文占用：这些数字由信息条与状态栏常驻显示，
  面板改为低频信息与资源清单。
- 修复鼠标命中：`‹ ›`、模型/思考值、会话名光标都补上了边框的 2 列偏移；
  点标题栏/底边框不再误触发内容行操作。
- 下拉打开时滚轮滚动下拉项，不再滚外层面板；下拉顶/中/底边框等宽。
- 底边框的成功/失败提示恢复颜色；切换模型 busy 时仍可用 Esc/q 关闭。
- 当前模型不在可切换列表时（`modelIndex = -1`），`←→` 不再跳过第一项。

### 修复
- **思考预览只显示最后一段**：`ThinkingPreviewView.cacheKey()` 不再调用会写状态的
  `snapshot()`，多段连续 thinking 在运行中会正确 join 并显示「上面还有内容」。
- **`!` 命令单条超长行**：修正字节上限对最后一行的豁免，并增加单行长度 +
  换行后可视行数封顶，折叠/展开都不会再爆出无界行数。
- **`bash-exec` 异常回退后的孤儿视图**：catch 分支清理 `__piExecView`，下次重新挂载。
- **`formatIndentedPreview` 忽略 `options.keyHint`**：自定义键位提示现在生效。
- **阅读辅助行数 key**：优先使用 pi-ai message 的数字 timestamp；历史消息也能记录，
  `resume`/重渲染后跳转不再依赖偶然的 key 0。
- **启动资源扫描**：
  - `promptOptions.contextFiles / skills` 为空数组时视为权威空结果，不再回退到扫盘；
  - 已有 promptOptions 时跳过对应磁盘扫描；
  - 启动页与信息面板共享 in-flight Promise，首次打开只扫一次；
  - 信息面板 `r` 用 `force` 真正重扫技能/扩展/MCP；
  - 扩展收集复用 Dirent 已得到的类型，避免二次全量 stat；
  - 新增技能后不带 force 仍读缓存，force 后才刷新。
- **用户消息 render 缓存**：按宽度/文本/padding 缓存行变换，并 patch `invalidate()`
  清缓存，长会话每帧不再重复跑逐行正则。
- **动画 tick 异常隔离**：单个 listener 抛错不再变成 uncaught exception。
- **上下文占用缓存 key** 增加 provider，避免同 id 不同 provider 命中错误缓存。
- `formatDuration` / `formatTokens` 边界修正（`59.96s`、`999999`）。
- 实时尾窗切片避开半个 ANSI 序列与代理对；`tailVisualRows` 切尾避开孤立 surrogate。

### 重构 / 清理
- 拆出 `edit-preview.ts`（参数归一、fuzzy/唯一/重叠匹配、unified diff），并补独立单测。
- 路径缩短统一为 `path-text.shortenPathLine()`，删除 `core.summarizePath` 与
  `info-panel.shortenForPanel`。
- 删除生产 dead code：`core.str` / `tailLines`、`context-bar.hitRateRgb`、
  `info-panel.centerIn` / `levelIndex` / `BuildOptions.message`。
- `RuntimePrototype.timestamp` 类型改为 `string | number`，并补 `__piAssistantStyleTimestamp`。
- `static-check.mjs` 增加「import 了但正文未使用」检查，并清掉全部未使用 import。
- edit 预览不再对每个 edit 重新 normalize 整个文件（O(edits × 文件大小) → O(文件大小)）。
- 文档同步：信息面板内容、`alt+i` 说明、测试数量、LIVE_TAIL_CHARS / git TTL / 汇率注释。

### 测试
- 85 个测试：新增多段 thinking 预览、`!` 超长行、下拉滚轮、keyHint 覆盖、
  鼠标左右箭头/标题栏/底边框、窄终端面板、promptOptions 空数组与 force 重扫、
  edit-preview 语义一致性等回归用例。


## [1.1.0] - 2026-11-15

### 打包方式变更：去掉 `package.json`
- **原因**：pi 安装 git 来源时，只要目录里有 `package.json` 就会跑包管理器安装依赖
  （本项目没有任何运行时依赖）。在没装 Node.js 的 Windows 机器上会直接失败：
  `'npm' is not recognized…` → `Error: spawn npm ENOENT`，且 pi 会删掉 clone 出来的目录。
- **现在**：仓库不含 `package.json`，pi 按约定目录 `extensions/*.ts` 发现扩展，
  `pi install git:` 不再触发 npm —— **只需要 git**。
- 代价：没有 `version` 字段（升级不弹 changelog，看本文件）、不在 pi.dev 画廊；
  版本改用 **git tag** 表达（`@v1.1.0` 仍可固定）。
- 本地目录安装 / `pi -e <目录>` / 下载 ZIP 三种方式都不受影响。


## [1.0.3] - 2026-11-15

### 加了一道静态检查（防 1.0.2 那类事故）
- `tests/static-check.mjs`：扫出「某个名字由别的模块 export、本文件用了却没 import」。
  判据很窄（只认真正的导出名），几乎不会误报；`tests/run.sh` 第一步就跑。
  负向验证：手动删掉 `hitRateMuted` 的 import → 立刻报错并退出 1。
- 顺带清掉 `path-text.ts` 里没人用、且引用了未导入 `str()` 的 `displayPath()`（潜在崩溃点）。
- 导入语句里不再夹注释（会干扰按 `,` 解析的工具）。


## [1.0.2] - 2026-11-15

### 修复
- **状态栏在有缓存数据时崩溃**（`ReferenceError: hitRateMuted is not defined`）：
  1.0.1 修缓存着色时只改了调用处，忘了把 `hitRateMuted` 加进 import；
  旧测试没覆盖"有缓存命中率"这一分支，所以没被发现。
- 补了一条回归测试：用真实 usage 数据渲染状态栏，断言不抛错且 90% 命中显示为绿色
  （把 import 删掉该测试会立刻失败）。


## [1.0.1] - 2026-11-15

### 修复
- 状态栏与会话信息面板里**缓存命中率着色方向反了**：99.2% 命中显示成红色。
  命中率是"越高越好"，与上下文占用率（越高越糟）方向相反，之前重构时误用了同一个档位函数。


## [1.0.0] - 2026-11-15

首个公开版本。

### 界面
- 助手消息：悬挂缩进、去背景、思考块折叠预览（带耗时、尾部窗口，无打字机效果）
- 用户消息：黄色加粗 + 图标 + 左移一列；三级以上标题改写为 `▸`
- 工具面板：bash / read / write / edit / grep / find / ls / powershell / codemode 统一视觉，运行中扫光、完成定格尾部 3 行
- `!` 内联命令：绿色圆角框 + 耗时 + 尾窗
- 输入框：圆角边框、输入符号、月相转圈 + 呼吸文案
- 信息条：输入/输出 token、速度档呼吸图标、首字延迟、耗时
- 状态栏：模型/思考/缓存/费用/总 token + 上下文色条 + 会话名与目录
- 启动页：logo + 上下文文件 / 技能 / 扩展清单（异步扫描）

### 会话信息面板（`alt+i`）
- 带边框居中的 overlay，会话名 / 模型 / 思考强度可直接改
- 模型与思考用 pi 自己的 `SelectList` 做内联下拉，支持 fuzzy 过滤
- 支持鼠标：点行聚焦、点值展开下拉、`‹ ›` 快切、双击改名、滚轮滚动
- 显示 token、缓存命中率、费用、上下文占用、累计用时、目录、会话 id

### 其它
- 长回复生成结束后视口自动回到回复开头
- 全部改动只走 pi 官方 API 与显示层补丁，不写配置文件、不联网
- 78 个测试（pi 真实加载器 + 行为断言）
