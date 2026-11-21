# deemo-style

给 [pi](https://pi.dev) 用的一套界面样式扩展：重做助手/用户消息、工具面板、输入框、状态栏、启动页，另加一个会话信息面板（`alt+i`）。

仓库：<https://github.com/DeemoMoon/deemo-style>

只改显示层，不动会话内容，不联网、不写配置文件。

## 要求

- pi **1.5.x**（在 1.5.2 上开发和测试）
- 终端需支持 24-bit 颜色；图标用 Nerd Font（不装也能用，只是图标会显示成方框）
- 鼠标点击只在 **fullscreen（alt-screen）模式**下有效

## 安装

```bash
# 1) 从 git 安装（推荐）
pi install git:github.com/DeemoMoon/deemo-style

#    固定到某个版本（tag 仍然可用）
pi install git:github.com/DeemoMoon/deemo-style@v1.2.0

# 2) 已经 clone 到本地
pi install /path/to/deemo-style     # 从任意目录指向包目录
pi install .                        # 已经在仓库里

# 3) 只想试一次、不写进设置（-e 加载完即忘）
pi -e /path/to/deemo-style
```

装完在 pi 里执行 `/reload`（或重启）。

### 本仓库没有 `package.json`（有意为之）

pi 安装 **git 来源**时的流程是：`git clone` → **如果目录里有 `package.json`** → 跑包管理器安装依赖
（npm / pnpm / bun）。本扩展没有任何运行时依赖，却会因为存在 `package.json` 而被要求先装好 npm；
在没装 Node.js 的 Windows 机器上就会直接失败：

```
'npm' is not recognized as an internal or external command
Error: spawn npm ENOENT
```

所以这里**故意不放 `package.json`**：pi 按约定目录 `extensions/*.ts` 发现扩展，`git clone` 之后不会触发
npm，只需要 `git` 就能安装。代价是没有 `version` 字段（升级时不弹 changelog，看本文件即可）、
也不在 pi.dev 画廊里。

> 如果你以后加回了 `package.json`，请想清楚：Windows 用户会需要先安装 Node.js 才能用 `pi install git:`。
> 想同时提供元数据与免 npm 安装，只能走 npm 发布（`pi install npm:…` 仍然需要 npm），或者让大家用
> 「下载 ZIP → `pi install <目录>`」这条路。

### Windows / 没有 npm 的方法

上面第 1 条只需要 **git**。如果连 git 都不想装：

```powershell
# a. 页面上 Code → Download ZIP，解压后让 pi 指向目录（本地来源完全不会调包管理器）
pi install C:\Users\<你>\Downloads\deemo-style

# b. 或者手动放到扩展目录（两个都要放，别只拷 ui-style.ts）
#    <agent-dir>\extensions\ui-style.ts
#    <agent-dir>\extensions\ui-style.modules\
```

几条实测过的注意点（pi **1.6.0**）：

- **`-e` 只接受"文件 / 目录路径"**，`pi -e git:…`、`pi -e npm:…` 这种包来源在 1.5.2 里不生效（会被当成一个不存在的路径而**静默跳过**，不报错）。
- **支持** `git:github.com/DeemoMoon/deemo-style`、`https://github.com/DeemoMoon/deemo-style`；
  **不支持** scp 形式 `git@github.com:DeemoMoon/deemo-style.git`（`parseGitUrl` 解析不出来，会被当成本地路径）。
  也就是说：`git clone` 用 SSH 没问题，但 `pi install` 要写成 `git:github.com/DeemoMoon/deemo-style`。
- 本地目录安装是**就地加载**（不复制文件），改完代码 `/reload` 即可生效。
- **只读 render（pi 1.6 起的硬约束）**：`Component.render()` 返回 `readonly string[]`，
  容器在子组件未变时会**复用同一个数组**（`renderChildLines` 用 `sameLines` 判断，
  `a === b` 走快路径）。所以：
  - 拿到别人的 `render()` 结果**一律当只读**，要改先 `[...lines]` 复制；
  - 自己的缓存命中时可以返回**同一个数组实例**（这正是 pi 想要的），但绝不原地改内容；
  - 内容一变就必须**换新数组**，否则 pi 认为"没变"，画面会冻住。
  本扩展的 `CachedView`（`tail.ts`）遵守这条约定；补丁点（用户消息 / 助手消息 /
  `!` 命令框）也有对应的回归测试。

⚠️ **不要和手工复制的副本同时存在**。如果你之前把 `ui-style.ts` 直接放进 `<agent-dir>/extensions/`，请先删掉
（`ui-style.ts` 和 `ui-style.modules/`），否则两个实例会互相摘补丁。

## 它做了什么

| 区域 | 效果 |
|---|---|
| 助手消息 | 悬挂缩进 + 去背景 + 思考块折叠预览（带耗时、尾部窗口） |
| 用户消息 | 黄色加粗 + 图标 + 整体左移一列；`###` 以上的标题改写成 `▸` |
| 工具面板 | bash / read / write / edit / grep / find / ls / powershell / codemode 统一视觉：图标 + 工具名 + `⏱ 耗时` + `· N 行`；运行中扫光，完成后定格显示尾部 3 行 |
| `!` 命令 | 绿色圆角框整块包裹，同样有耗时与尾窗 |
| 输入框 | 圆角边框 + `❯`/`⌘`/`»` 输入符号；工作中月相转圈 + 呼吸文案 |
| 信息条（输入框上方） | 输入/输出 token、速度档图标（呼吸）、首字延迟、耗时 |
| 状态栏（输入框下方） | 模型/思考强度/缓存命中率/费用/总 token + 上下文色条 + 会话名/git/目录 |
| 启动页 | logo + 上下文文件 / 技能 / 扩展清单（异步扫描，不卡首帧） |
| 会话信息面板 | `alt+i` 打开：会话名、模型、思考强度可直接改；会话总时长、分支、目录与已加载的技能/扩展/MCP 一屏看完 |
| 阅读辅助 | 长回复生成结束后，视口自动回到这条回复的开头（不再停在末尾） |

## 键位

| 键 | 作用 |
|---|---|
| `alt+i` | 打开/关闭会话信息面板 |
| 面板内 `Tab` / `↑↓` | 切换焦点行（会话名 / 模型 / 思考强度） |
| 面板内 `Enter` | 会话名 → 改名；模型/思考 → 打开下拉列表 |
| 面板内 `←→` | 快速切换模型 / 思考档位 |
| 面板内 `r` | 重新取一次数据快照 |
| 面板内 `Esc` | 关闭（下拉打开时先收起下拉） |
| 面板内鼠标 | 点行聚焦、点模型/思考的值展开下拉、点 `‹ ›` 快切、双击会话名改名、滚轮滚动 |

面板里的修改只用 pi 的官方 setter（`setModel` / `setThinkingLevel` / `setSessionName`），**只对当前会话生效**，不会改 `settings.json`。

## 开关

功能开关在 `extensions/ui-style.modules/core.ts` 顶部的 `FEATURES`，把某项改成 `false` 再 `/reload` 即可整块停用：

```ts
export const FEATURES = {
  assistantStyle: true,
  userMessage: true,
  headingRewrite: true,
  roundedEditor: true,
  infoBar: true,
  statusline: true,
  startupHeader: true,
  skillBanner: true,
  bashExecBox: true,
  toolPanels: true,
  jumpToReplyStart: true,
  shimmerTitle: true,
  sessionInfoPanel: true,
} as const;
```

## 已知限制

- 扩展会给 pi 的 `AssistantMessageComponent` / `UserMessageComponent` / `SkillInvocationMessageComponent` /
  `BashExecutionComponent` 打原型补丁。pi 大版本升级后如果内部结构变了，样式会**静默退回原生渲染**（不会炸 TUI），
  此时更新本扩展即可。
- 信息面板的模型/思考改动**不会持久化**（pi 的扩展 API 没有 `persist`）。
- 鼠标在 tmux / zellij 下不上报"纯移动"，但点击和滚轮正常。
- 本扩展默认折叠思考块；pi 设置里的 `hideThinkingBlock: false` 在扩展启用期间会被默认折叠覆盖，
  按一次 `Ctrl+T` 之后以用户选择为准。

## 发布（给自己看）

```bash
cd deemo-style
git push                                     # remote: git@github.com:DeemoMoon/deemo-style.git（默认分支 master）
git tag v1.2.0 && git push origin v1.2.0     # 之后可用 git:…@v1.2.0 固定版本
```

没有 `package.json` 就没有 `version` 字段，所以版本靠 **git tag** 表达，更新说明写在本文件与 `CHANGELOG.md`。

改完代码后：

```bash
bash scripts/smoke.sh          # 测试 + 静态检查 + 干净环境安装 + 真实加载
# 更新 CHANGELOG.md，然后提交；版本用 git tag 表达（本仓库没有 package.json）
git commit -am "feat: ..." && git push
git tag v1.2.0 && git push origin v1.2.0
```

## 目录结构

```
extensions/ui-style.ts                入口（14 行）
extensions/ui-style.modules/
  core.ts           共享层：FEATURES / 对齐 / 配色 / 块计时 / 预览格式化 / 缓存基类
  path-text.ts      路径显示（home 缩写、从左侧截断）
  levels.ts         思考档位（顺序 / 模型能力过滤 / 配色）
  context-bar.ts    上下文色条 + 档位阈值
  session-stats.ts  会话统计口径（token / 费用 / 缓存 / 用时）
  panels.ts         工具面板
  edit-preview.ts   edit 工具的执行中 diff 预览（与 pi edit 语义对齐）
  assistant.ts      助手消息（原型补丁）
  user-message.ts   用户消息（原型补丁 + markdown 变换）
  skill-banner.ts   技能横幅（原型补丁）
  bash-exec.ts      `!` 命令框（原型补丁）
  editor.ts         输入框 + 工作中动画
  infobar.ts        输入框上方信息条
  statusline.ts     输入框下方状态栏
  startup.ts        启动页
  info-panel.ts     会话信息面板（alt+i）
  reading.ts        长回复结束后跳回开头
  tests/            154 个单测 + 行为测试
```

## 测试

```bash
bash extensions/ui-style.modules/tests/run.sh
```

测试用 pi 自带的 jiti 加载器真实加载扩展，并断言具体行为（面板行宽、补丁所有权、下拉交互、鼠标命中、超长行封顶等）。`static-check.mjs` 同时检查缺失/未使用的 import。

## 许可证

MIT
