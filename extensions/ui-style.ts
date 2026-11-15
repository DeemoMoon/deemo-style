/**
 * ui-style —— pi 界面样式自定义（入口）
 *
 * 实现在同目录的 ./ui-style.modules/ 下，按功能分区：
 *   core.ts（共享层/开关）、panels.ts、assistant.ts、skill-banner.ts、
 *   bash-exec.ts、user-message.ts、editor.ts、infobar.ts、statusline.ts、
 *   startup.ts、extension.ts（默认导出，按 FEATURES 注册一切）。
 *
 * ui-style.modules/ 里没有 index.ts / package.json，pi 的扩展发现不会把
 * 它当成第二个扩展加载（只认 extensions/*.ts 与 extensions/<dir>/index.ts）。
 *
 * 安装：<agent-dir>/extensions/ui-style.ts，然后 /reload 或重启 pi。
 */
export { default } from "./ui-style.modules/extension.ts";
