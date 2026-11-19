/**
 * 路径显示工具（共享层）
 *
 * 只依赖字符串与可见宽度，抽出来后 core.ts 不再"什么都往里塞"。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/**
 * home 目录：只解析一次。Windows 上 Node 的 homedir() 每次调用都要读环境变量，
 * 而路径缩写会在每个工具面板的**每一帧**被用到。
 */
export const HOME = homedir();

/**
 * 大小写不敏感只在大小写不敏感的文件系统上启用（Windows / macOS 默认卷）。
 *
 * Linux 上 `/HOME/x` 是**另一个真实目录**，按 home 缩写会显示成 `~/x` 骗人。
 */
const CASE_INSENSITIVE_HOME = process.platform === "win32" || process.platform === "darwin";

/**
 * 去掉 home 前缀：命中返回 rest（可能为空串），不命中返回 undefined。
 *
 * 两个坑在这里一起堵住：
 *   1. **不能先 toLowerCase 再 startsWith**：`İ`.toLowerCase() 会变成 2 个码点，
 *      拿它做长度判断再用 `path.slice(HOME.length)` 截原串就会错位；
 *      这里改成「先按 HOME.length 切片，再比较切片本身」，长度天然对齐。
 *   2. **大小写只在对应平台忽略**（见 CASE_INSENSITIVE_HOME），Linux 上大小写
 *      不同就是不同目录。
 *
 * `caseInsensitive` 显式传入（而不是直接用常量）是为了两个分支都能单测。
 */
export function stripHomePrefix(
	path: string,
	home: string,
	caseInsensitive: boolean,
): string | undefined {
	if (!home) return undefined;
	// 去掉 home 末尾的分隔符（根目录 "/" 除外），否则 "/home/u/" 和 "/home/u" 表现不一致。
	const base = home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
	if (path.length < base.length) return undefined;
	const head = path.slice(0, base.length);
	const matched = caseInsensitive ? head.toLowerCase() === base.toLowerCase() : head === base;
	if (!matched) return undefined;
	const rest = path.slice(base.length);
	// home 是根目录时（base === "/"）rest 天然不带前导分隔符，直接放行。
	if (base === "/") return rest;
	// 其余情况 rest 必须为空或以分隔符开头：home 为 `C:\Users\x` 时不能把
	// `C:\Users\x2` 误缩成 `~/2`。
	return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? rest : undefined;
}

/**
 * 把 home 目录缩写成 `~`（Windows / macOS 大小写不敏感，Linux 敏感）。
 * `formatCwd` 与启动页共用。
 */
export function shortenHome(path: string): string {
	const rest = stripHomePrefix(path, HOME, CASE_INSENSITIVE_HOME);
	if (rest === undefined) return path;
	// home 是根目录时 rest 不带前导分隔符，补一个，保证缩写后仍是 `~/x` 形态。
	if (rest === "") return "~";
	return rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : `~/${rest}`;
}

/** 把 home 目录缩写成 `~`，并统一成 `/`，让路径短一些（状态栏/信息面板共用）。 */
export function formatCwd(cwd: string): string {
	const short = shortenHome(cwd);
	// 不在 home 下也统一成 `/`：Windows 上正/反斜杠混用会让路径看起来比实际更长。
	if (short === cwd) return cwd.replace(/\\/g, "/");
	const rest = short.slice(1).replace(/^[\\/]+/, "").replace(/\\/g, "/");
	return rest ? `~/${rest}` : "~";
}

/**
 * 目录太长时从左边砍，保住末尾的项目名；连末尾都塞不下才硬截断。
 * `ellipsis` 默认用单个 “…”（比 "..." 省列）；调用方需要 ASCII 时可覆盖。
 */
export function shortenPathLine(path: string, budget: number, ellipsis = "…"): string {
	if (budget <= 0) return "";
	if (visibleWidth(path) <= budget) return path;

	const segments = path.split("/").filter(Boolean);
	// 从多保留到少保留，找到第一个塞得下的
	for (let keep = segments.length - 1; keep >= 1; keep--) {
		const candidate = `${ellipsis}/${segments.slice(-keep).join("/")}`;
		if (visibleWidth(candidate) <= budget) return candidate;
	}
	return truncateToWidth(path, budget, ellipsis);
}

