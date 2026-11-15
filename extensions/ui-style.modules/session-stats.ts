/**
 * 会话统计（状态栏与信息面板共用一份口径）
 *
 * 统计范围 = **当前分支**（`getBranch()`），不是整份会话文件（`getEntries()`）：
 * 后者的 append-only 会把 `/tree` 切走的分支的计费也算进来。
 *
 * 计入 usage 的条目：
 *   - `type: "usage"`（如 cache_warm 之类的外部计费）
 *   - `message` 里 assistant / toolResult 的 usage
 *   - `branch_summary` / `compaction` 的 usage（摘要本身也是一次调用）
 *
 * 时间口径（两个不同的数，别混）：
 *   - `activeMs`：逐轮累加"用户提问 → 该轮最后一个条目"，即真正在生成/执行的时间；
 *   - `wallMs`：首条 → 最后一条的墙钟跨度，包含用户思考和中途离开。
 */

import { promptTokens, type InfoMessageLike, type UsageLike } from "./core.ts";

/** pi 的 usage 里多带一个 cost（美元）。 */
export interface StatUsageLike extends UsageLike {
	cost?: { total?: number };
}

/** 统计只关心的条目形状。 */
export interface StatEntryLike {
	type?: string;
	usage?: StatUsageLike;
	message?: InfoMessageLike;
	timestamp?: string;
}

export interface SessionStats {
	/** 累计花费（美元，展示时按汇率换算）。 */
	cost: number;
	/** cacheRead / (input + cacheRead + cacheWrite)，0~100。 */
	cacheHitRate: number | undefined;
	/** 会话里是否出现过缓存读写（没有就显示 `--`，避免误报 0%）。 */
	hasCache: boolean;
	/** input + output + cacheRead + cacheWrite。 */
	totalTokens: number;
	/** input + cacheRead + cacheWrite（所有 prompt 的总量）。 */
	promptTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** 助手消息 + 工具结果消息条数。 */
	messageCount: number;
	/** 用户提问轮数。 */
	turnCount: number;
	/** 生成/执行累计用时（毫秒）。 */
	activeMs: number;
	/** 首条 → 最后一条的墙钟跨度（毫秒）。 */
	wallMs: number;
}

/**
 * 最后一轮若还没有下一条用户消息来"收尾"，且距最后一个条目不超过 ACTIVE_TAIL_MS，
 * 就当作还在生成、用"到现在"补一点增长；超过这个间隔说明这轮早结束了，
 * 完全不计——答完之后你去泡咖啡的时间不该算进"累计用时"。
 */
const ACTIVE_TAIL_MS = 120_000;

export function emptyStats(): SessionStats {
	return {
		cost: 0,
		cacheHitRate: undefined,
		hasCache: false,
		totalTokens: 0,
		promptTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		messageCount: 0,
		turnCount: 0,
		activeMs: 0,
		wallMs: 0,
	};
}

export function addUsage(stats: SessionStats, usage: StatUsageLike | undefined): void {
	if (!usage) return;
	stats.cost += usage.cost?.total ?? 0;

	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;

	if (cacheRead > 0 || cacheWrite > 0) stats.hasCache = true;

	stats.cacheReadTokens += cacheRead;
	stats.cacheWriteTokens += cacheWrite;
	stats.inputTokens += input;
	stats.outputTokens += output;
	stats.promptTokens += promptTokens(usage);
	stats.totalTokens += input + output + cacheRead + cacheWrite;
}

export function addEntryStats(stats: SessionStats, entry: StatEntryLike): void {
	if (entry.type === "usage") {
		addUsage(stats, entry.usage);
		return;
	}
	if (entry.type === "message" && entry.message) {
		const role = entry.message.role;
		if (role === "assistant" || role === "toolResult") {
			addUsage(stats, entry.message.usage as StatUsageLike | undefined);
		}
		if (role === "assistant" || role === "toolResult") stats.messageCount += 1;
		else if (role === "user") stats.turnCount += 1;
		return;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") {
		addUsage(stats, entry.usage);
	}
}

/** 条目时间戳（ISO 字符串；取不到就当 0，不参与时间统计）。 */
function entryTime(entry: StatEntryLike): number {
	if (typeof entry.timestamp !== "string") return 0;
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** 累加完条目后算派生值（缓存命中率、累计用时）。 */
function finalizeStats(stats: SessionStats, entries: readonly StatEntryLike[], now: number): void {
	stats.cacheHitRate =
		stats.hasCache && stats.promptTokens > 0
			? (stats.cacheReadTokens / stats.promptTokens) * 100
			: undefined;

	let first = 0;
	let last = 0;
	let turnStart = 0;
	let turnEnd = 0;
	for (const entry of entries) {
		const time = entryTime(entry);
		if (time > 0) {
			if (first === 0) first = time;
			last = time;
		}
		if (entry.type !== "message") continue;
		if (entry.message?.role === "user") {
			// 上一轮到这里收尾
			if (turnStart > 0 && turnEnd >= turnStart) stats.activeMs += turnEnd - turnStart;
			turnStart = time || turnEnd || 0;
			turnEnd = turnStart;
			continue;
		}
		if (turnStart > 0 && time > 0) turnEnd = time;
	}

	// 最后一轮还没被下一条用户消息收尾：
	//   - 距最后一个条目很近（≤ ACTIVE_TAIL_MS）→ 当作还在生成，用"到现在"补；
	//   - 早就过去了 → 这一轮其实已经结束（助手消息就是收尾），不要补，
	//     否则"答完去泡杯咖啡"的时间会被算进累计用时。
	if (turnStart > 0 && turnEnd >= turnStart) {
		const gap = now - turnEnd;
		const tail = gap > 0 && gap <= ACTIVE_TAIL_MS ? gap : 0;
		stats.activeMs += turnEnd - turnStart + tail;
	}
	stats.wallMs = first > 0 && last >= first ? last - first : 0;
}

/** 一次性算完（条目数量是会话规模，调用方按"分支锚点变了"缓存结果）。 */
export function computeSessionStats(
	entries: readonly StatEntryLike[],
	now: number = Date.now(),
): SessionStats {
	const stats = emptyStats();
	for (const entry of entries) addEntryStats(stats, entry);
	finalizeStats(stats, entries, now);
	return stats;
}
