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
 * 把 home 目录缩写成 `~`（大小写不敏感，Windows 友好）。
 * rest 必须为空或以路径分隔符开头：home 为 `C:\Users\x` 时不能把
 * `C:\Users\x2` 误缩成 `~/2`（formatCwd / 启动页共用）。
 */
export function shortenHome(path: string): string {
	if (!HOME) return path;
	if (!path.toLowerCase().startsWith(HOME.toLowerCase())) return path;
	const rest = path.slice(HOME.length);
	return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}

/** 把 home 目录缩写成 `~`，并统一成 `/`，让路径短一些（状态栏/信息面板共用）。 */
export function formatCwd(cwd: string): string {
	const short = shortenHome(cwd);
	// 不在 home 下也统一成 `/`：Windows 上正/反斜杠混用会让路径看起来比实际更长。
	if (short === cwd) return cwd.replace(/\\/g, "/");
	const rest = short.slice(1).replace(/^[\\/]+/, "").replace(/\\/g, "/");
	return rest ? `~/${rest}` : "~";
}

/** 目录太长时从左边砍，保住末尾的项目名；连末尾都塞不下才硬截断。 */
export function shortenPathLine(path: string, budget: number): string {
	if (budget <= 0) return "";
	if (visibleWidth(path) <= budget) return path;

	const segments = path.split("/").filter(Boolean);
	// 从多保留到少保留，找到第一个塞得下的
	for (let keep = segments.length - 1; keep >= 1; keep--) {
		const candidate = `…/${segments.slice(-keep).join("/")}`;
		if (visibleWidth(candidate) <= budget) return candidate;
	}
	return truncateToWidth(path, budget, "...");
}

