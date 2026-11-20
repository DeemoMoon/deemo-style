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
	BOLD_ON,
	CHROME_LEFT_PAD,
	chromeLine,
	contextUsageCached,
	fg24,
	fitToWidth,
	formatCwd,
	formatTokens,
	MUTED,
	ExtensionStatusText,
	resetContextUsageCache,
	RESET_FG,
	shortenPathLine,
} from "./core.ts";
import {
	createSessionStatsComputer,
	emptyStats,
	sessionCreatedAt,
	type SessionStats,
	type StatEntryLike,
} from "./session-stats.ts";
// 注意：缓存命中率是"越高越好"，用 hitRateText（levelOf 是"越高越糟"，别混）
import { LEVEL_MUTED, hitRateText, levelOf, renderContextBar } from "./context-bar.ts";
import { thinkingText as sharedThinkingText } from "./levels.ts";
import type {
	ContextUsageLike,
} from "./core.ts";

/** “Ctx 文案 + ▣ 色条”整体至少要留多少列才值得显示。 */
const MIN_CTX_ZONE = 12;
/** 色条最少要放下的格子数，少于这个数就只显示文字。 */
const MIN_BAR_CELLS = 3;

/**
 * git 状态的缓存时长：避免每帧都 fork 一个 git 进程。
 * 状态栏的渲染节拍来自统一 tick / spinner（80~100ms），4s 意味着任务期间
 * 每 4 秒 fork 一个 git；分支/改动本来就是给人看的低频信息，4s 足够实时。
 */
const GIT_STATUS_TTL_MS = 4000;
/** git status 失败/超时后的重试间隔（避免大仓库持续 fork+kill 循环）。 */
const GIT_STATUS_ERROR_TTL_MS = 15_000;

/**
 * pi 的 usage.cost 单位是美元；显示 ￥ 前按此近似汇率换算。
 * 这是固定值，会随真实汇率漂移，不用于对账；需要精确时可改成可配置。
 */
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
	// ▣ / □ / █ / ░ 都是单列宽，无需 cellWidth 抽象。
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
		if (barBudget < MIN_BAR_CELLS) continue;
		// 单列宽时 cells 恒等于 barBudget：右边缘对齐靠 zone 预算本身，gap 恒为 1。
		const cells = barBudget;
		const gap = 1;
		return `${label}${" ".repeat(gap)}${renderContextBar(percent, cells, "box")}`;
	}

	// 连“最短文案 + 最少格子”都放不下：从短到长挑一个能放下的文案。
	for (const label of [...candidates].reverse()) {
		if (zone >= visibleWidth(label)) return label;
	}
	if (zone <= 0) return undefined;
	return truncateToWidth(pctText, zone, "...");
}


class StatusLineFooter implements Component {
	private stats: SessionStats = emptyStats();
	/** 统计到的分支锚点（leaf id）：变了才重算，见 refresh()。 */
	private statsLeafId = "";
	/**
	 * 增量统计器：分支 append-only，所以只累加新增条目（Date.parse 也按对象缓存）。
	 * 一个 turn 内 leaf 会变好几次，全量扫整条分支在长会话下很贵。
	 */
	private readonly computeStats = createSessionStatsComputer();

	/**
	 * 每帧都要用的两个 O(会话规模) 查询。pi 的 getContextUsage() 每次都会重建
	 * 整个会话投影，getSessionName() 会反向遍历所有条目，因此只在 refresh()
	 * 里取，render() 只读缓存。
	 */
	private contextUsage: ContextUsageLike = undefined;
	private sessionName = "";

	/**
	 * cwd 的显示文本缓存（`formatCwd` + `shortenPathLine`）。
	 *
	 * 这两个函数每帧都要用，但 cwd 在一次会话里基本不变（`/cd` 才会变），
	 * 所以在 refresh() 里算一次，render 只读缓存。
	 */
	private cwdText: { raw: string; short: string; line: string } = { raw: "", short: "", line: "" };
	/** 上次计算目录行时的内宽（宽度变了才重算）。 */
	private cwdLineWidth = -1;

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
			this.stats = this.computeStats(
				manager.getBranch() as unknown as StatEntryLike[],
				Date.now(),
				sessionCreatedAt(manager),
			);
		}

		this.contextUsage = contextUsageCached(this.ctx);
		this.sessionName = manager.getSessionName() ?? "";
		const cwd = manager.getCwd();
		if (cwd !== this.cwdText.raw) {
			this.cwdText = { raw: cwd, short: formatCwd(cwd), line: "" };
		}

		if (render) this.tui.requestRender();
		this.revision += 1;
	}

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
			// 旧 cwd 的请求可能还在飞：它的回调会因为 cwd 不匹配而早退，
			// 如果不在这里清掉 pending，就再也没有机会发新请求了（永久卡住）。
			this.gitStatusPending = false;
		}

		const ttl = this.gitStatusFailed ? GIT_STATUS_ERROR_TTL_MS : GIT_STATUS_TTL_MS;
		const stale = this.gitStatusValue === undefined || now - this.gitStatusAt >= ttl;
		if (!this.gitStatusPending && stale) {
			this.gitStatusPending = true;
			// 闭包捕获发起时的 cwd，回调写入前比对（见下方校验）。
			const requestCwd = cwd;
			execFile(
				"git",
				["status", "--porcelain=v1", "-b"],
				{ cwd, encoding: "utf8", timeout: 1500, windowsHide: true },
				(error, stdout) => {
					// 写入前校验 cwd：git 回调回来时会话可能已切目录，
					// 过期结果直接丢弃（也不重绘，新 cwd 会重新发起请求）。
					if (this.gitStatusCwd !== requestCwd) {
						// 过期结果：丢掉，但 pending 必须复位（否则新 cwd 永远发不出请求）
						this.gitStatusPending = false;
						return;
					}
					this.gitStatusPending = false;
					this.gitStatusAt = Date.now();
					this.gitStatusFailed = Boolean(error);
					this.revision += 1;
					if (error) {
						this.gitStatusValue = null;
						// 失败时值没变，requestRender 纯属多一帧；成功才重绘。
						return;
					}
					this.gitStatusValue = parseGitStatus(stdout);
					this.revision += 1;
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

	/** 渲染缓存：数据只在 refresh / git 返回 / 4s TTL 时变。 */
	private cachedWidth = -1;
	private cachedKey = "";
	private cachedLines: string[] | undefined;
	/** 数据版本：refresh / git 状态变化时 +1。 */
	private revision = 0;

	private extensionStatusesText(statuses: ReadonlyMap<string, string>): string {
		return this.statuses.update(statuses);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const model = this.ctx.model;
		const thinking = this.getThinkingLevel();
		const statuses = this.footerData.getExtensionStatuses();
		const statusText = statuses.size > 0 ? this.extensionStatusesText(statuses) : "";
		const branch = this.footerData.getGitBranch() ?? "";
		// git 状态的 TTL 是 4s：把它放进 key，保证缓存不会让 git 轮询永久停住。
		const gitBucket = Math.floor(Date.now() / GIT_STATUS_TTL_MS);
		const cacheKey = [
			width,
			this.revision,
			model?.provider ?? "",
			model?.id ?? "",
			thinking,
			branch,
			statusText,
			gitBucket,
		].join("\u0000");
		if (this.cachedLines !== undefined && this.cachedKey === cacheKey && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// 内容文字用 text 色；分隔符用固定灰色（不用 theme dim 色——SGR 22 会关掉加粗）。
		const text = (value: string) => theme.fg("text", value);
		const separator = `${MUTED} • ${RESET_FG}`;
		// 缩进之后真正可用的列数，后面所有换行/对齐计算都用它。
		const innerWidth = Math.max(1, width - CHROME_LEFT_PAD);

		// ---- 第一行：模型名(供应商) • 思考强度 • 命中率 • 花费 • 总 tokens ----
		const modelName = model ? `${model.id}(${model.provider})` : "no-model";

		const totalTokens = text(`Total ${formatTokens(this.stats.totalTokens)}`);

		const rate = this.stats.hasCache ? this.stats.cacheHitRate : undefined;
		const cache =
			rate === undefined
				? text("Cache --")
				// 命中率越高越好 → 用 hitRateText（别用 levelOf，那是"越高越糟"）
				: text("Cache ") + hitRateText(rate);

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
		const known = typeof percent === "number" && Number.isFinite(percent);
		const percentText = known ? `${percent.toFixed(1)}%` : "?";

		// ---- 第二行：会话名 • [git 分支与状态 •] Ctx 文案 + ▣ 色条 ----
		const rawCwd = this.cwdText.raw;
		const line2Parts: string[] = [text(this.sessionName || "未命名会话")];

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

		const line2Left = line2Parts.join(separator);

		// 先给“Ctx 文案 + 色条”留出保底列数，剩下的给左侧；左侧实在塞不下才截断。
		// 用 truncateBold：pi-tui 的 truncateToWidth 会在中间插 \x1b[0m，
		// 把整行的 chromeLine 加粗从省略号处断掉。
		const left2Safe = truncateBold(
			line2Left,
			Math.max(0, target - sepWidth - MIN_CTX_ZONE),
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
		// 目录行按宽度截断，宽度变了才重算；cwd 本身取自 refresh() 的缓存。
		if (this.cwdText.line === "" || this.cwdLineWidth !== innerWidth) {
			this.cwdText.line = shortenPathLine(this.cwdText.short, innerWidth);
			this.cwdLineWidth = innerWidth;
		}
		lines.push(this.cwdText.line);

		// ---- 其他扩展通过 ctx.ui.setStatus() 设置的状态 ----
		if (statusText) {
			lines.push(truncateToWidth(text(statusText), innerWidth, "..."));
		}

		// 前两行右边缘严格对齐；整行加粗；最后统一加上左边缩进。
		const result = lines.map((entry, index) => {
			const fitted = fitToWidth(entry, index < 2 ? target : innerWidth);
			return chromeLine(fitted);
		});
		this.cachedWidth = width;
		this.cachedKey = cacheKey;
		this.cachedLines = result;
		return result;
	}
}

/**
 * 按宽度截断，且保证省略号之后仍然恢复加粗。
 * `truncateToWidth` 的 ANSI 路径会返回 `prefix + \x1b[0m + ... + \x1b[0m`，
 * 中间的 reset 会把 chromeLine 的 BOLD_ON 关掉。
 */
function truncateBold(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 3) return truncateToWidth(text, width, "...");
	return `${truncateToWidth(text, width - 3, "")}${BOLD_ON}...`;
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

