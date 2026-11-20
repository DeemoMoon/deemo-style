# Changelog

## [1.3.10] - 2026-11-19

### 复盘（第二轮）修复
- **`thinkingTimings` 淘汰死循环**：Map 里全是"正在计时"的记录时一条也删不掉、越过 500
  上限后无限增长（每条还拖着 `ThinkingPreviewView`）。现在找不到可淘汰的就兜底删最早一条。
- **`compactionRecord` 回退**：id 未命中时不再回退"最近一次压缩"，否则重放历史会话会让
  老块显示新一次的耗时（与"历史显示 `--`，绝不编造"矛盾）。
- **压缩原文未释放**：`finish()` 里清空 `source`（长会话可达数百 KB）。
- **精确模式匹配语义**：`+path` / `-path` 改为按 pi 的 `matchesAnyExactPattern` 语义比对
  相对路径 / 绝对路径 / SKILL.md 的父目录，**不再按 basename/技能名比对**——
  以前 `-commit` 会误伤任意目录下同名技能。
- **块缓存签名补 `model`**：pi 若在消息之后补写 `details.model`，底行不会永久缺模型名。
- **会话统计周期兜底**：增量续算只校验最后一个 entry，挡不住历史条目被就地改写；
  每 20 次调用做一次全量重算。
- `levels.supportedThinkingLevels` 加版本锚点注释（pi 未导出该规则，1.5.2 对照）。

### 性能
- `shimmerText` 的 SGR 按「色 + 量化比例(64 档)」缓存（实测 2000 次调用 ~6ms）。
- `branchTitle` 的 `estimateTokens` 按内容指纹缓存。
- `LsBoxView` 直接收源行数组，去掉每帧 `join("\n")` → `split("\n")` 往返。
- `ThinkingPreviewView` 的 `slice/map/join` 按 150ms 刷新槽缓存。
- `shortenPathLine` 改为从右向左**单次**累加宽度（原来每轮 slice+join 是 O(n²)）。
- `statusline` 的 `formatCwd` / 目录行按 cwd 与宽度缓存（原来每帧重算）。
- `startup` 的技能/扩展 root 扫描改为并行。
- 抽出 `shouldHideEarlyMs()`，三处「首帧 <16ms 不显示」共用。
- 命中率文案统一为 `hitRateText()`（原来块底行与状态行各写一份）。

## [1.3.9] - 2026-11-19

### 压缩文案按触发原因区分（手动 / 阈值自动 / 溢出恢复）
pi 的三条压缩路径共用同一套渲染与事件，只是 `reason` 不同。现在文案跟着走：

| reason | 进行中 | 完成 |
|---|---|---|
| `manual` | `压缩上下文中` | `压缩完成` |
| `threshold`（阈值触发） | `自动压缩中` | `自动压缩完成` |
| `overflow`（溢出恢复） | `溢出恢复中` | `溢出恢复完成` |

- 压缩块标题、块标题（完成后）、输入框指示三处统一按 `reason` 出文案；
  对比信息与耗时不变：`\uF0CFF 自动压缩完成 · 12k → 4k tokens（-68%） · ⏱ 1.8s`。
- `CompactionReason` / `compactionLabel()` / 当前 reason 的共享状态放在 `core`（text 层）：
  `summary-blocks` 在事件里写，`editor` 的 `Loader` 补丁读（它拿不到结构化 reason）。
- 历史回放（没有本地记录）仍按手动文案显示，不编造来源。

## [1.3.8] - 2026-11-19

### 输入框内的压缩/摘要指示去掉时钟与耗时
- 输入框那一行只保留 **月相 + 呼吸文案**（`🌕 压缩上下文中` / `🌕 摘要生成中`）：
  它紧贴输入框，数字跳动会干扰打字。
- 耗时只在**压缩块标题**上展示：`\uF0CFF 压缩中 · ⏱ 1.8s`（紫色 + 整行扫光）。

## [1.3.7] - 2026-11-19

### 压缩的两处计时统一配色与动画
- 抽出 `core.liveTitle(icon, label, accent, startedAt, elapsedMs)`：图标 + 文案 +
  行尾 `⏱ 耗时`，**整行一起扫光**（耗时也在扫光带里），首帧 <16ms 不拼耗时。
- 压缩块标题与输入框状态指示都改用它，因此两处是**同一支紫色 + 同一套扫光**：
  - `\uF0CFF 压缩中 · ⏱ 1.8s`
  - `🌕 压缩上下文中 · ⏱ 1.8s`
- 之前输入框那处用灰色（`MUTED`）且耗时不在动画里，看着像贴上去的一截；现已统一。

## [1.3.6] - 2026-11-19

### 压缩执行时也显示时钟与耗时
- 压缩中的两处指示都补上行尾 `⏱ 耗时`（首帧 <16ms 不显示，避免闪一下 "0ms"，
  与 `liveClockText` 同口径）：
  - transcript/输入框上方的压缩块：`\uF0CFF 压缩中 · ⏱ 1.8s`（标题扫光，耗时在扫光外）
  - 输入框内的状态指示：`🌕 压缩上下文中 · ⏱ 2.6s`（月相 + 呼吸 + 耗时）

## [1.3.5] - 2026-11-19

### 压缩指示器也换成「压缩上下文中」（同款月相 + 呼吸）
- 上一版只处理了 `/tree` 的分支摘要指示器；压缩时 pi 的 `CompactionStatusIndicator`
  仍是英文 `Compacting context... (esc to cancel)`。现在两者共用同一套补丁
  （`patchSummaryStatusIndicators`）：
  - `kind === "branchSummary"` → `🌕 摘要生成中`
  - `kind === "compaction"` → `🌕 压缩上下文中`
- 这两个指示器**不显示时钟/耗时**（动画只有月相 + 呼吸文字）；耗时只出现在
  压缩完成后的摘要块里。
- 其它 Loader（普通加载、重试倒计时）不受影响。

## [1.3.4] - 2026-11-19

### `/tree` 分支摘要指示器：换成「摘要生成中」+ 工作中同款动画
- pi 生成分支摘要时挂的 `BranchSummaryStatusIndicator` 文案固定是
  `Summarizing branch... (esc to cancel)`，且该类**没有导出**，改不到实例。
  改为在它的基类 `Loader.prototype.updateDisplay` 上打补丁：只对
  `kind === "branchSummary"` 的实例生效——文案换成我们「工作中」那套**呼吸文字**
  （`摘要生成中`），spinner 换成月相、节拍换成 `WORKING_INTERVAL_MS`，与正常生成
  时完全一致。其它 Loader（普通加载、压缩指示）原样不动。
- 补丁在工厂期与每个 `session_start` 重打（幂等），`session_shutdown` 恢复原型
  ——否则 `/reload` 时旧闭包会一直挂在 `Loader` 上。

## [1.3.3] - 2026-11-19

### 摘要块：耗时、滚动原文、前后对比
- **压缩块标题始终带时钟**：测到就显示真实耗时，历史回放显示 `--`（pi 的
  `CompactionEntry` 不落盘耗时，只能在本进程内用 `session_before_compact` /
  `session_compact` 现场测并**按 entry id** 记录）。
- **压缩完成显示前后大小对比**：`12k → 4.1k tokens（-67%）`。压缩前取
  `tokensBefore`；压缩后用 pi 的 `estimateTokens` 对压缩后的会话投影求和
  （与 pi 内部 `estimatedTokensAfter` 同口径），拿不到就只显示压缩前。
- **压缩中的 5 行窗口自动下滚**：原文来自 `preparation.messagesToSummarize`，
  窗口每 350ms 下滚一行（`SUMMARY_SCROLL_MS`），滚到底停在尾部；上下都有
  `… 上面还有 N 行` / `… 下面还有 N 行` 提示且不占窗口额度。
- **压缩块标题色改成紫**（与分支摘要统一，都是"上下文被改写"的元事件），不再用蓝。
- **分支摘要去掉时钟**，改成显示摘要大小：`\uF4CA 分支摘要 · from 3c9c3f06 · 摘要 13 tokens`。
  注意 pi-ai 的 `estimateTokens` 对 assistant 只认 block 数组的 content
  （传字符串会得 0），已显式包成 text 块并加测试防止回归。

## [1.3.2] - 2026-11-19

### 新功能：压缩摘要 / 分支摘要块统一视觉
- 给 pi 的 `CompactionSummaryMessageComponent` / `BranchSummaryMessageComponent` 打原型补丁
  （`summary-blocks.ts`），去掉默认的整块背景与 `[compaction]` / `[branch]` 标签：
  - 压缩：`\uF0CFF 压缩完成 · 压缩前 12k tokens · ⏱ 1.8s`
  - 分支：`\uF4CA 分支摘要 · from a1b2c3d4`
  - 正文用 `⎿` 连接、**固定 5 行窗口**（看头部，超出提示 `还有 N 行（Ctrl+O 展开）`），
    展开态给全文并按宽度折行；点击块同样可切换。
- 压缩**进行中**补一个同款标题的指示（widget 挂在输入框上方，`压缩中` + 扫光 + 耗时），
  由 `session_before_compact` / `session_compact` / `session_compact_failed` 驱动。
  **限制**：pi 在压缩期间只显示 "Compacting context..." 的 spinner，既不暴露组件也不
  暴露流式摘要文本（内部 `streamFn(...).result()` 一次拿完），所以"压缩中"只能给标题，
  摘要正文要等完成态。

### 测试
- 125 → 127：摘要块的图标/标题/5 行窗口/展开全文/无默认标签/窄终端不超宽，
  以及压缩中指示的事件接线。

## [1.3.1] - 2026-11-19

### 修复（复盘发现的边界 bug）
- **并行同名 agent 的计时/尾窗互相覆盖**：`childKey` 原来是 `step ?? agent`，并行传两个
  同名 agent（如两个 scout）时 key 相同，`state.clocks` / `state.windows` 共享——第一个
  结束后第二个的耗时被定格、两块显示同一份滚动输出。改为**按结果数组下标**做键。
- **折叠预览的「还有 N 行」会丢**：`headLinesOfTexts` 在 head 被 maxLines 截断时仍会
  裁掉尾部空行（那是文本**中间**的空行）并扣减 total，实测 8 行文本第 5 行是空行时
  `remaining` 从 4 变成 0。现在只有 head 覆盖全文时才裁。
- **展开态长行被 `…` 永久截断**：`conclusionLines` 展开态只 `split("\n")` 不折行，长结论/
  失败证据超过终端宽度就被 `truncateToWidth` 切掉。改为按 contentWidth 折行（失败证据同样）。
- **单行超长输出末尾带换行时尾窗变空**：`cleanedTailText` 的切点落在末尾换行之后，
  返回空串 → 面板明明有输出却显示「执行中...」。
- **`git status` 的 pending 可能永久卡住**：cwd 变化时没清 `pending`，旧请求的回调又
  早退不清，之后不再发新请求。
- **`!` 命令运行中首帧显示 `0ms`**：抽出 `core.liveClockText()`（<16ms 且未结束不显示），
  `bash-exec` 与子代理块共用。
- **`assistant` 空消息未记录行数**：`renderStyled` 的 0 行分支没有 `recordRenderedLines`，
  空回复时 `lastAssistantRenderLines()` 会留着上一条的行数，「跳回回复开头」可能误跳。
- **信息面板下拉可能落到视口外**：`revealFocus` 只看焦点行，不看它后面的内联下拉。

### 性能
- **子代理块每帧重复全量遍历**：`childActivityText` 按 `messages` 引用 + 长度 + 末条消息
  缓存；块渲染结果按内容签名缓存（`state.blockCache`），8 个任务时不再每帧重渲全部块。
- **状态栏统计**：`createSessionStatsComputer()` 只累加新增条目（分支 append-only），
  `Date.parse` 按 entry 对象 + 时间戳字符串缓存；长会话下每次刷新的成本从 O(全部条目)
  降到 O(新增条目)。
- 其余：`fitToWidth` 统一状态栏/信息面板的行对齐；`normalizeNewlines` 统一三处换行归一。

### 清理
- 删掉 4 个空 `import { } from "node:path"`。
- 删掉只剩测试在用的死导出（`statusIcon` / `childHeaderPlain` / `childHeaderText` /
  `panelTitle` / `parallelStatusText` / `ICON_THINK` / `ICON_CACHE` / `RESULT_TASK_ITEMS`），
  并把对应测试改成验证仍在用的 `statusMark` / `conclusionHead` / `childFinalOutput` 等。
- `PANEL_SPECS` 与 `PANEL_FACTORIES` 去重：只有 write/edit/ls 登记为特殊面板，其余自动生成。
- `info-panel` 的模型 key 统一走 `modelKey()`；删掉 `BarStyle` 的备用字形分支；
  删掉 `mark as never` 与几个一行包装函数；清掉孤儿注释。

### 结构
- `core.ts`（1263 行）拆成 `theme.ts`（配色/图标/对齐/扫光）、`text.ts`（格式化/ANSI/
  折叠预览/上下文缓存/动画节拍）、`tail.ts`（CachedView / LiveTailView /
  IndentedPreviewView）；`core.ts` 只做 `export *`，其它模块 import 路径不变。
  `path-text.ts` 只由 `core.ts` 聚合一次（拆分时曾在 `theme.ts` 里重复 re-export）。

### 文档
- 测试数同步为 124（仓库 README 与 `ui-style.modules/README.md`）。
- `ExtensionStatusText` 类注释与实现对齐（基线存插入序、只对输出副本排序）。

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
