/**
 * 十一、输入框下方状态栏（模型(供应商) / 思考强度 / 缓存 / 费用 / Total + ▣□ 上下文色条）
 *
 * 统计口径 = 当前分支（getBranch）；每帧渲染只读缓存，重算只发生在
 * message_end / turn_end / session_* 等事件上。
 */

import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
	join,
} from "node:path";
import {
	BOLD_OFF,
	BOLD_ON,
	CHROME_LEFT_PAD,
	CHROME_PAD,
	contextUsageCached,
	fg24,
	formatCwd,
	formatTokens,
	MUTED,
	ExtensionStatusText,
	resetContextUsageCache,
	RESET_FG,
	shortenPathLine,
} from "./core.ts";
import { computeSessionStats, emptyStats, type SessionStats, type StatEntryLike } from "./session-stats.ts";
import {
	LEVEL_MUTED,
	levelOf,
	renderContextBar,
} from "./context-bar.ts";
import { thinkingText as sharedThinkingText } from "./levels.ts";
import type {
	ContextUsageLike,
} from "./core.ts";

/** 是否显示第二行的 “会话名 • git 分支” 和第三行的 “当前工作目录”。 */
const SHOW_CWD_LINE = true;

/** “Ctx 文案 + ▣ 色条”整体至少要留多少列才值得显示。 */
const MIN_CTX_ZONE = 12;
/** 色条最少要放下的格子数，少于这个数就只显示文字。 */
const MIN_BAR_CELLS = 3;

/**
 * git 状态的缓存时长：避免每帧都 fork 一个 git 进程。
 * 状态栏的渲染节拍来自统一 tick / spinner（80~100ms），4s 意味着任务期间
 * 每秒都要 fork 一个 git；分支/改动本来就是给人看的低频信息，4s 足够实时。
 */
const GIT_STATUS_TTL_MS = 4000;
/** git status 失败/超时后的重试间隔（避免大仓库持续 fork+kill 循环）。 */
const GIT_STATUS_ERROR_TTL_MS = 15_000;

/** pi 的 usage.cost 单位是美元；显示 ￥ 前按此汇率换算。 */
const USD_TO_CNY = 7.2;

interface GitStatus {
	changed: number;
	ahead: number;
	behind: number;
}

function parseGitStatus(output: string): GitStatus {
	const lines = output.split(/\r?\n/);
	const header = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
	const changed = lines.slice(1).filter((line) => line.trim() !== "").length;
	const ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
	const behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
	return { changed, ahead, behind };
}

/**
 * 组装 “Ctx 文案 + ▣▣□□ 连排色条”，宽度恰好填满 zone 列（右边缘严格对齐）。
 * 百分比数字按占用档位着色（与 Cache 一致）。文案放不下逐级丢信息，
 * 色条格子数按剩余宽度动态算（至少 MIN_BAR_CELLS 格），零头并进间隙。
 */
function ctxSegment(
	theme: Theme,
	percent: number | null | undefined,
	percentText: string,
	usedText: string,
	windowText: string,
	zone: number,
): string | undefined {
	const cellWidth = 1; // ▣ / □ / █ / ░ 都是单列宽
	// 百分比已知时按档位上色（降饱和柔色）；未知（"?"）保持普通文字色。
	const known = typeof percent === "number" && Number.isFinite(percent);
	const pctText = known
		? fg24(LEVEL_MUTED[levelOf(Math.max(0, Math.min(100, percent)))], percentText)
		: percentText;
	const candidates = [
		`Ctx ${usedText}/${windowText} (${pctText})`,
		`${usedText}/${windowText} (${pctText})`,
		pctText,
	];

	for (const label of candidates) {
		const barBudget = zone - visibleWidth(label) - 1;
		if (barBudget < MIN_BAR_CELLS * cellWidth) continue;
		const cells = Math.floor(barBudget / cellWidth);
		const gap = 1 + (barBudget - cells * cellWidth);
		return `${label}${" ".repeat(gap)}${renderContextBar(percent, cells, "box")}`;
	}

	// 连“最短文案 + 最少格子”都放不下：从短到长挑一个能放下的文案。
	for (const label of [...candidates].reverse()) {
		if (zone >= visibleWidth(label)) return label;
	}
	if (zone <= 0) return undefined;
	return truncateToWidth(pctText, zone, "...");
}

/**
 * 把每一行补齐到终端宽度：不会因多 1 列而自动换行，
 * 数字变长变短时行宽稳定，不会出现残字或左右抖动。
 */
function fitLine(line: string, width: number): string {
	const current = visibleWidth(line);
	if (current === width) return line;
	const fitted = current > width ? truncateToWidth(line, width, "") : line;
	const fittedWidth = visibleWidth(fitted);
	return fittedWidth < width ? fitted + " ".repeat(width - fittedWidth) : fitted;
}

class StatusLineFooter implements Component {
	private stats: SessionStats = emptyStats();
	/** 统计到的分支锚点（leaf id）：变了才重算，见 refresh()。 */
	private statsLeafId = "";

	/**
	 * 每帧都要用的两个 O(会话规模) 查询。pi 的 getContextUsage() 每次都会重建
	 * 整个会话投影，getSessionName() 会反向遍历所有条目，因此只在 refresh()
	 * 里取，render() 只读缓存。
	 */
	private contextUsage: ContextUsageLike = undefined;
	private sessionName = "";

	/** git 状态缓存（undefined = 还没拿到）。 */
	private gitStatusValue: GitStatus | null | undefined;
	private gitStatusCwd: string | undefined;
	private gitStatusAt = 0;
	private gitStatusPending = false;
	/** 上一次 git status 是否失败/超时：失败后用更长的重试间隔。 */
	private gitStatusFailed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly footerData: ReadonlyFooterDataProvider,
		private readonly ctx: ExtensionContext,
		private readonly getThinkingLevel: () => string,
		private readonly unsubscribeBranch: () => void,
	) {
		this.refresh(false);
	}

	/** 重新统计会话的费用、token、缓存命中率，并刷新上下文占用与会话名。 */
	refresh(render = true): void {
		const manager = this.ctx.sessionManager;
		const leafId = manager.getLeafId() ?? "";

		// 统计口径 = 当前分支（getBranch）。getEntries() 是整份会话文件（append-only），
		// 会把被 /tree 切走的分支的计费也算进来。分支锚点变了（新条目 / 切分支 /
		// compaction）才重算；否则连整表浅拷贝都省掉。
		if (leafId !== this.statsLeafId) {
			this.statsLeafId = leafId;
			this.stats = computeSessionStats(manager.getBranch() as unknown as StatEntryLike[]);
		}

		this.contextUsage = contextUsageCached(this.ctx);
		this.sessionName = manager.getSessionName() ?? "";

		if (render) this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribeBranch();
	}

	/**
	 * 异步读取 `git status`，最多每 GIT_STATUS_TTL_MS 刷新一次；
	 * 失败/超时后退避到 GIT_STATUS_ERROR_TTL_MS。
	 */
	private gitStatus(cwd: string): GitStatus | null | undefined {
		const now = Date.now();
		if (this.gitStatusCwd !== cwd) {
			this.gitStatusCwd = cwd;
			this.gitStatusValue = undefined;
			this.gitStatusAt = 0;
		}

		const ttl = this.gitStatusFailed ? GIT_STATUS_ERROR_TTL_MS : GIT_STATUS_TTL_MS;
		const stale = this.gitStatusValue === undefined || now - this.gitStatusAt >= ttl;
		if (!this.gitStatusPending && stale) {
			this.gitStatusPending = true;
			execFile(
				"git",
				["status", "--porcelain=v1", "-b"],
				{ cwd, encoding: "utf8", timeout: 1500, windowsHide: true },
				(error, stdout) => {
					this.gitStatusPending = false;
					this.gitStatusAt = Date.now();
					this.gitStatusFailed = Boolean(error);
					this.gitStatusValue = error ? null : parseGitStatus(stdout);
					this.tui.requestRender();
				},
			);
		}

		return this.gitStatusValue;
	}

	/**
	 * 扩展状态文本（每帧都会用到）。
	 *
	 * `getExtensionStatuses()` 返回的是同一个会被就地修改的 Map，拿不到
	 * “变了没有”的信号；而排序 + 正则清洗 + join 是每帧都重复的纯计算。
	 * 这里用上一次的条目逐项比对，没变就直接用上次结果。
	 */
	private readonly statuses = new ExtensionStatusText();

	private extensionStatusesText(statuses: ReadonlyMap<string, string>): string {
		return this.statuses.update(statuses);
	}

	render(width: number): string[] {
		const theme = this.theme;
		// 内容文字用 text 色；分隔符用固定灰色（不用 theme dim 色——SGR 22 会关掉加粗）。
		const text = (value: string) => theme.fg("text", value);
		const separator = `${MUTED} • ${RESET_FG}`;
		// 缩进之后真正可用的列数，后面所有换行/对齐计算都用它。
		const innerWidth = Math.max(1, width - CHROME_LEFT_PAD);

		// ---- 第一行：模型名(供应商) • 思考强度 • 命中率 • 花费 • 总 tokens ----
		const model = this.ctx.model;
		const modelName = model ? `${model.id}(${model.provider})` : "no-model";
		const thinking = this.getThinkingLevel();

		const totalTokens = text(`Total ${formatTokens(this.stats.totalTokens)}`);

		const rate = this.stats.hasCache ? this.stats.cacheHitRate : undefined;
		const cache =
			rate === undefined || rate === null
				? text("Cache --")
				: text("Cache ") + fg24(LEVEL_MUTED[levelOf(rate)], `${rate.toFixed(1)}%`);

		const cost = text(`Cost ￥${(this.stats.cost * USD_TO_CNY).toFixed(2)}`);

		const left = [text(modelName), sharedThinkingText(thinking, (value) => theme.fg("text", value)), cache, cost, totalTokens].join(
			separator,
		);

		// ---- 第二行整体要严格对齐到第一行 “Total xxx” 的末尾 ----
		const target = Math.min(visibleWidth(left), innerWidth);
		const sepWidth = visibleWidth(separator);

		// ---- 第二行要用到的上下文数据（refresh 时算好，这里只读缓存） ----
		const usage = this.contextUsage;
		const contextWindow = usage?.contextWindow ?? this.ctx.model?.contextWindow ?? 0;
		const usedText =
			usage?.tokens === null || usage?.tokens === undefined ? "?" : formatTokens(usage.tokens);
		const windowText = contextWindow > 0 ? formatTokens(contextWindow) : "?";

		const percent = usage?.percent;
		const known = percent !== null && percent !== undefined;
		const percentText = known ? `${percent.toFixed(1)}%` : "?";

		// ---- 第二行：会话名 • [git 分支与状态 •] Ctx 文案 + ▣ 色条 ----
		const rawCwd = SHOW_CWD_LINE ? this.ctx.sessionManager.getCwd() : "";
		const line2Parts: string[] = [];

		if (SHOW_CWD_LINE) {
			line2Parts.push(text(this.sessionName || "未命名会话"));

			const branch = this.footerData.getGitBranch();
			if (branch) {
				let git = branch;
				const status = this.gitStatus(rawCwd);
				if (status) {
					if (status.ahead > 0) git += ` ↑${status.ahead}`;
					if (status.behind > 0) git += ` ↓${status.behind}`;
					if (status.changed > 0) git += " *";
				}
				line2Parts.push(text(git));
			}
		}

		const line2Left = line2Parts.join(separator);

		// 先给“Ctx 文案 + 色条”留出保底列数，剩下的给左侧；左侧实在塞不下才截断。
		const left2Safe = truncateToWidth(
			line2Left,
			Math.max(0, target - sepWidth - MIN_CTX_ZONE),
			"...",
		);
		const ctxZone = Math.max(
			0,
			target - visibleWidth(left2Safe) - (left2Safe ? sepWidth : 0),
		);

		const right = ctxSegment(theme, percent, percentText, usedText, windowText, ctxZone);
		const line2 =
			right !== undefined
				? left2Safe
					? `${left2Safe}${separator}${right}`
					: right
				: left2Safe;

		const lines = [left, line2];

		// ---- 第三行：当前工作目录独占一行 ----
		if (SHOW_CWD_LINE) lines.push(shortenPathLine(formatCwd(rawCwd), innerWidth));

		// ---- 其他扩展通过 ctx.ui.setStatus() 设置的状态 ----
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			lines.push(truncateToWidth(text(this.extensionStatusesText(statuses)), innerWidth, "..."));
		}

		// 前两行右边缘严格对齐；整行加粗；最后统一加上左边缩进。
		return lines.map((entry, index) => {
			const fitted = fitLine(entry, index < 2 ? target : innerWidth);
			return `${CHROME_PAD}${BOLD_ON}${fitted}${BOLD_OFF}`;
		});
	}
}

export function setupStatusline(pi: ExtensionAPI): void {
	let footer: StatusLineFooter | undefined;

	const refresh = () => footer?.refresh();

	// 费用 / token / 缓存统计在这些时机重算，避免每帧扫描会话。
	pi.on("message_end", refresh);
	pi.on("turn_end", refresh);
	pi.on("session_compact", refresh);
	pi.on("session_tree", refresh);
	pi.on("agent_settled", refresh);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footer = new StatusLineFooter(
				tui,
				theme,
				footerData,
				ctx,
				() => pi.getThinkingLevel(),
				footerData.onBranchChange(() => tui.requestRender()),
			);
			return footer;
		});
	});

	pi.on("session_shutdown", () => {
		footer = undefined;
		resetContextUsageCache();
	});
}

