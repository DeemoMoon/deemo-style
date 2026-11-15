# deemo-style

给 [pi](https://pi.dev) 用的一套界面样式扩展：重做助手/用户消息、工具面板、输入框、状态栏、启动页，另加一个会话信息面板（`alt+i`）。

只改显示层，不动会话内容，不联网、不写配置文件。

## 要求

- pi **1.5.x**（在 1.5.2 上开发和测试）
- 终端需支持 24-bit 颜色；图标用 Nerd Font（不装也能用，只是图标会显示成方框）
- 鼠标点击只在 **fullscreen（alt-screen）模式**下有效

## 安装

```bash
# 从 git 安装（推荐）
pi install git:github.com/<你的账号>/deemo-style

# 或试用一次，不写进设置
pi -e git:github.com/<你的账号>/deemo-style

# 本地开发时直接指向目录
pi install ./deemo-style
```

装完在 pi 里执行 `/reload`（或重启）。

> 注意：`pi install` 认 **git / npm / 目录** 三种来源；`.tgz` / `.zip` 这类压缩包不算包来源
> （会被当成"单个扩展文件"处理）。想发压缩包的话，让对方解压后把 `ui-style.ts` 和
> `ui-style.modules/` 一起放进 `~/.pi/agent/extensions/` 即可。

⚠️ **不要和手工复制的副本同时存在**。如果你之前把 `ui-style.ts` 直接放进 `~/.pi/agent/extensions/`，请先删掉
（`~/.pi/agent/extensions/ui-style.ts` 和 `ui-style.modules/`），否则两个实例会互相摘补丁。

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
| 会话信息面板 | `alt+i` 打开：会话名、模型、思考强度可直接改；token、缓存、费用、上下文、用时、目录一屏看完 |
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

## 发布（给自己看）

```bash
cd deemo-style
git remote add origin git@github.com:<你的账号>/deemo-style.git
git push -u origin main
git tag v1.0.0 && git push origin v1.0.0     # 之后可用 git:...@v1.0.0 固定版本
```

改完代码后：

```bash
bash scripts/smoke.sh          # 测试 + 干净环境安装 + 真实加载
# 更新 package.json 的 version 与 CHANGELOG.md（pi 会在更新后自动展示变更）
git commit -am "feat: ..." && git push
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
  tests/            78 个单测 + 行为测试
```

## 测试

```bash
bash extensions/ui-style.modules/tests/run.sh
```

测试用 pi 自带的 jiti 加载器真实加载扩展，并断言具体行为（面板行宽、补丁所有权、下拉交互、鼠标命中等）。

## 许可证

MIT
