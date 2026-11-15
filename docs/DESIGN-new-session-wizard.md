# 设计：新建会话向导（new session wizard）

> 状态：**设计稿，未实现**。做之前需要拍板 §9 的几个问题。
> 编号对应 `TODO-overlays.md` 的 #13。

---

## 1. 目标 / 非目标

**目标**：一条命令（或快捷键）打开向导，一次填完"名称 + 模型 + 思考等级 + 首条 prompt"，回车后切到新会话并自动开始。

**现状痛点**：
- `/new` 只能"立刻新建"，名字没法设（`--name` 是启动参数，会话内**没有** `/name` 命令）；
- 新建后模型/思考等级会**跳回 settings 默认值**（见 §4，这点很多人不知道）；
- 想"换个模型试同一件事"要 `/new` → `/model` → 重新输入 prompt，三步以上。

**非目标**（各用现成功能）：
| 需求 | 用 |
|---|---|
| 复制当前会话 | `/clone` |
| 从某条消息分叉 | `/fork` |
| 换工作目录 | pi 没有会话内切目录的 API（`ctx.cwd` 只读），新会话继承当前 cwd |
| 恢复旧会话 | `/resume` |

---

## 2. UX 形态（两选一）

### W2 · 串行对话框（推荐先做）
用内置对话框，零自绘、零键盘处理，风格和 pi 一致：

```
/new 向导
 1. 名称      ctx.ui.input("会话名称", "留空自动生成")
 2. 模型      ctx.ui.select("模型", ["当前：xxx", "provider/id (200k) ▶", ...])
 3. 思考等级  ctx.ui.select("思考等级", ["off","minimal","low","medium","high","xhigh","max"])
 4. 首条消息  ctx.ui.input("首条消息（可留空）", "预填编辑器里已输入的内容")
 5. 确认      ctx.ui.confirm("新建会话", "模型 X · 思考 Y · 名称 Z" + "首条消息：前 40 字…")
```

- 每步 `Esc` = 整轮取消（返回 `undefined` → 直接退出，什么都不做）。
- 第 4 步默认值取 `ctx.ui.getEditorText()`：用户在输入框里已经写好的东西直接带进去。
- 成本 **~180 行**。

### W1 · 单页 overlay 表单（好看，成本高）
一个弹窗四行字段：`名称 / 模型 / 思考 / 首条消息`，`Tab`·`↑↓` 换字段，`←→` 改选项，`Enter` 提交，`Esc` 取消，`Ctrl+G` 恢复默认。

- 依赖 `overlay.ts` 基建（见 `TODO-overlays.md` §3）+ `Input` 组件焦点管理；
- 成本 **~200 行（在 W2 之上叠加）**，且弹窗内多行 prompt 编辑体验要额外打磨。

> 建议：**先做 W2**，对外接口保持 `runNewSessionWizard(ctx, ui)` 不变，以后想漂亮再换 W1。

---

## 3. 字段定义

| 字段 | 控件 | 默认值 | 校验 / 说明 |
|---|---|---|---|
| **名称** | 文本 | 空 → 用首条 prompt 首行截 40 字 → 再空则 `新会话 MM-DD HH:mm` | `trim()`、去换行、上限 80 字；重名允许（会话 id 才唯一） |
| **模型** | 列表 | 当前模型（`ctx.model`），无则列表首项 | 数据源：有 `ctx.scopedModels` 时先列作用域模型，再列 `ctx.modelRegistry.getAvailable()`；显示 `provider/id`、`contextWindow`（`200k`）、`reasoning` 时加 `⚡`；按 provider 分组排序；分组头用不可选项 |
| **思考等级** | 列表 | 当前等级（`pi.getThinkingLevel()`），并按新模型修正 | 7 档：`off / minimal / low / medium / high / xhigh / max`；用 `model.thinkingLevelMap?.[level] === null` 过滤该模型不支持的档位；`setThinkingLevel` 内部也会 clamp，双保险 |
| **首条消息** | 多行文本 | `ctx.ui.getEditorText()` | 留空 = 只建会话不发送；非空 = 建完后 `sendUserMessage(prompt, { expandPromptTemplates: true })` |

---

## 4. 执行时序（关键，已核对 1.5.2 源码）

```ts
export async function runNewSessionWizard(ctx, ui) {
    const cfg = await collectFields(ctx, ui);      // §2，用户取消则 return
    if (!cfg) return;

    if (!ctx.isIdle()) {                           // 正在生成
        const go = await ui.confirm("还在生成中", "现在新建会打断当前回复，继续？");
        if (!go) return;
        await ctx.waitForIdle();                   // 命令上下文有 waitForIdle
    }

    const { cancelled } = await ctx.newSession({
        setup: async (sessionManager) => {
            if (cfg.name) sessionManager.appendSessionInfo(cfg.name);
        },
        withSession: async (nc) => {
            // 顺序不能反：setModel 内部会按新模型的 per-model 设置重算思考等级
            const ok = await pi.setModel(cfg.model);
            if (!ok) {
                // 没有该 provider 的 key：pi.setModel 返回 false（不抛）
                ui.notify(`${cfg.model.provider} 未配置凭据，模型未切换`, "warning");
            } else {
                pi.setThinkingLevel(cfg.level);     // 内部自动 clamp 到模型支持的档位
            }
            if (cfg.prompt) await nc.sendUserMessage(cfg.prompt, { expandPromptTemplates: true });
        },
    });
    if (!cancelled) ui.notify(`已新建会话${cfg.name ? `「${cfg.name}」` : ""}`, "info");
}
```

**为什么这么写（四条源码依据）**：

1. `AgentSessionRuntime.newSession()` 的顺序是：
   `emit session_before_switch` → teardown 旧会话 → **建新 runtime** → `setup(新 sessionManager)` → `refreshContext()` → `finishSessionReplacement(withSession)`。
   所以 `setup` 里写名字是安全的，`withSession` 里能拿到 `sendUserMessage`。
2. **新会话不继承当前模型/思考等级**：`createAgentSession()` 里 `hasExistingSession = messages.length > 0` 为 false 时，
   model 走 `findInitialModel()`（settings 的 default provider/model），thinking 走 per-model 或 default。
   → **不显式设置就会静默回落到默认值**，这是本向导最大的价值点。
3. `session.setModel()` 末尾会调 `_getThinkingLevelForModelSwitch(model)` 再 `setThinkingLevel()` ——
   → **必须先 `setModel` 再 `setThinkingLevel`**，反了会被覆盖。
4. `pi.setModel()` 在 runner 里是 `if (!hasConfiguredAuth(provider)) return false; await this.setModel(model);` ——
   无凭据时 **返回 false 而不是抛错**，所以要检查返回值。

---

## 5. 持久化（重要取舍）

`pi.setModel()` / `pi.setThinkingLevel()` 走的是 `setModel(model)`（**没有** `persist: true`），
所以向导里的选择**只对本次会话有效**；下次 `/new` 仍回到 settings 的默认模型。

三个选择：
| 方案 | 说明 | 建议 |
|---|---|---|
| A. 只本次 | 不改任何文件，按钮旁注明"仅本次会话" | **首版采用** |
| B. 记住为默认 | 需要自己写 `~/.pi/agent/settings.json`（`SettingsManager` 不对扩展开放）：备份 + 合并写 + 失败回滚 | 以后再说，风险高于收益 |
| C. 提示用户 | 提交页加一行"想固定默认模型：用 `/model` 里设为默认，或启动参数 `--model`" | 首版顺带加这句提示 |

---

## 6. 边界情况

| 情况 | 处理 |
|---|---|
| 没有可用模型（全无 auth） | 第 2 步直接提示"没有可用模型，请先 `/login`"，中止向导 |
| `pi.setModel` 返回 false | `notify` 警告，会话照建（用默认模型），**不静默** |
| 用户正在流式生成 | 默认先确认；确认后 `await ctx.waitForIdle()`，若仍不空闲则放弃（`ctx.isIdle()` 再查一次） |
| 用户在任意一步取消 | 直接 return，**不产生任何副作用**（不要"已经建了会话但没设置"的半截状态） |
| 名称含换行 / 超长 | `trim()` + 去换行 + 截 80 字 |
| 首条消息含 `/命令` | `expandPromptTemplates: true` 会展开；如需原样发送，加一个"不展开模板"的开关（默认展开，与输入框行为一致） |
| 会话创建后扩展重新 init | `session_start(reason="new")` 会再次触发我们的处理器：**必须重置模块级状态**（`assistant.ts` 的 `lastRenderedLines`、`reading.ts` 的 `sharedTui`、infobar 的会话统计） |
| 向导开着时执行 newSession | **先 `done()` 关掉 overlay 再调 `newSession`**，否则 TUI teardown 会留下悬空的 done 回调 |

---

## 7. 代码结构

```
ui-style.modules/
  new-session.ts        # 字段收集 + 执行 + 兜底（~180 行）
  overlay.ts            # 仅 W1 需要（通用弹窗壳，~120 行）
  tests/
    behavior.test.ts    # 用例 5 个（~80 行）
```

对外接口：

```ts
export function setupNewSessionWizard(pi: ExtensionAPI): void;      // 注册命令/快捷键
export async function runNewSessionWizard(ctx, ui, deps): Promise<boolean>; // 返回是否真的新建了
export function buildModelChoices(...)   // 纯函数，好测
export function buildLevelChoices(...)   // 纯函数，好测
```

接入 `extension.ts`：

```ts
if (FEATURES.newSessionWizard) setupNewSessionWizard(pi);
```

---

## 8. 入口与命名

| 项 | 建议 | 理由 |
|---|---|---|
| 命令 | `/neww`（或 `/session-new`），描述 `新建会话向导（名称/模型/思考/首条消息）` | **不要**覆盖内置 `/new`：内置"立即新建"是肌肉记忆，覆盖会让习惯失效 |
| 快捷键 | `alt+n`（可关） | 默认键位里没占用；`alt+*` 偶有终端吞键，所以以命令为主 |
| 开关 | `FEATURES.newSessionWizard` | 与其他功能一致 |

---

## 9. 成本与待定

| 项 | 量 |
|---|---|
| W2（串行对话框）+ 测试 | ~180 + ~80 行 |
| W1（单页 overlay）叠加 | +~200 行 |
| 自检 / 冒烟 | 现有 `tests/run.sh` 加 5 个用例（字段构造纯函数、可选档位过滤、取消无副作用、忙碌分支、失败分支） |

**待定（需要你拍板）**：
1. **W2 还是 W1**？（建议 W2 先行）
2. 命令名用 `/neww` 可以吗？还是你想要 `/new` 覆盖内置（我不建议）？
3. 要不要做"记住为默认"（写 settings.json，方案 B）？
4. 首条消息默认取编辑器内容（`ui.getEditorText()`）这个行为要不要？（建议要）
5. 建完会话是否自动发送首条消息（建议：非空就发，且首条消息即为用户的真实提问，能保留在 transcript 里）
