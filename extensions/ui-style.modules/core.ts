/**
 * 共享层入口（shim）：把拆开的三个模块重新聚合成原来的 `core.ts` 出口。
 *
 * 代码分别住在：
 *   - `theme.ts`：FEATURES / 配色 / 图标 / 对齐 / 连接符 / 标题扫光
 *   - `text.ts` ：耗时与用量格式化、ANSI 清洗、折叠预览、上下文缓存、动画节拍
 *   - `tail.ts` ：CachedView / LiveTailView / IndentedPreviewView
 *   - `path-text.ts`：路径显示（原本就单独）
 *
 * 其它模块继续 `import ... from "./core.ts"` 即可，不用改 import 路径。
 */

export * from "./theme.ts";
export * from "./text.ts";
export * from "./tail.ts";
export * from "./path-text.ts";
