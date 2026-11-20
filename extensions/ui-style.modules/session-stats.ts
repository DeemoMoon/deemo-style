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
			stats.messageCount += 1;
		} else if (role === "user") {
			stats.turnCount += 1;
		}
		return;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") {
		addUsage(stats, entry.usage);
	}
}

/**
 * 条目时间戳（ISO 字符串；取不到就当 0，不参与时间统计）。
 *
 * `Date.parse` 是这里唯一的"贵"操作：状态栏每个 turn 会重算好几次整条分支，
 * 同一个 entry 对象每次都被解析一遍。用 WeakMap 按对象缓存，解析只发生一次。
 */
const entryTimeCache = new WeakMap<StatEntryLike, { ts: string | undefined; value: number }>();

function entryTime(entry: StatEntryLike): number {
	const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
	const cached = entryTimeCache.get(entry);
	// 同一对象的时间戳可能被原地改写（compaction / 测试 / 将来的会话编辑），
	// 所以缓存要连原始时间戳一起校验，不能只按对象身份命中。
	if (cached !== undefined && cached.ts === ts) return cached.value;
	let value = 0;
	if (ts !== undefined) {
		const parsed = Date.parse(ts);
		if (Number.isFinite(parsed)) value = parsed;
	}
	entryTimeCache.set(entry, { ts, value });
	return value;
}

/**
 * 主循环内联的时间累计：用户提问开启一轮，下一条用户消息把上一轮收尾；
 * turnStart/turnEnd 等状态由调用方持有（单遍遍历，每条 entry 只解析一次时间戳）。
 */
interface TurnTracker {
	first: number;
	last: number;
	turnStart: number;
	turnEnd: number;
	/** 最后一条 message 的角色：只有 user / toolResult 结尾才算“还在跑”。 */
	lastRole?: string;
}

/** 单条条目进时间累计（与 usage 统计同一次遍历）。 */
function trackEntryTime(stats: SessionStats, tracker: TurnTracker, entry: StatEntryLike): void {
	const time = entryTime(entry);
	if (time > 0) {
		if (tracker.first === 0) tracker.first = time;
		tracker.last = time;
	}
	if (entry.type !== "message") return;
	tracker.lastRole = entry.message?.role;
	if (entry.message?.role === "user") {
		// 上一轮到这里收尾
		if (tracker.turnStart > 0 && tracker.turnEnd >= tracker.turnStart) {
			stats.activeMs += tracker.turnEnd - tracker.turnStart;
		}
		// 缺时间戳的条目不参与时间统计（turnStart 归 0，而不是回退用上一轮
		// 的结束时间——否则会把「上一轮结束 → 现在」整段误计入 activeMs）
		tracker.turnStart = time > 0 ? time : 0;
		tracker.turnEnd = tracker.turnStart;
		return;
	}
	if (tracker.turnStart > 0 && time > 0) tracker.turnEnd = time;
}

/** 遍历完条目后收尾：最后一轮补尾 + 缓存命中率 + 墙钟跨度。 */
function finalizeStats(stats: SessionStats, tracker: TurnTracker, now: number): void {
	stats.cacheHitRate =
		stats.hasCache && stats.promptTokens > 0
			? (stats.cacheReadTokens / stats.promptTokens) * 100
			: undefined;

	// 最后一轮还没被下一条用户消息收尾：
	//   - 最后一条是 user / toolResult（真正还在生成或跑工具）且距现在 ≤ ACTIVE_TAIL_MS
	//     → 用 "到现在" 补；
	//   - 最后一条是 assistant（本轮已给出答案）时不再补，否则“答完去泡杯咖啡”
	//     的 2 分钟会被算进累计用时。
	if (tracker.turnStart > 0 && tracker.turnEnd >= tracker.turnStart) {
		const openTurn = tracker.lastRole === "user" || tracker.lastRole === "toolResult";
		const gap = now - tracker.turnEnd;
		const tail = openTurn && gap > 0 && gap <= ACTIVE_TAIL_MS ? gap : 0;
		stats.activeMs += tracker.turnEnd - tracker.turnStart + tail;
	}
	stats.wallMs = tracker.first > 0 && tracker.last >= tracker.first ? tracker.last - tracker.first : 0;
}

/** 一次性算完（条目数量是会话规模，调用方按"分支锚点变了"缓存结果）。 */
/**
 * 有状态的统计器：分支是 append-only 的，所以可以**只累加新增的条目**。
 *
 * 为什么需要：状态栏在 message_end / turn_end / agent_settled 等多个事件上刷新，
 * 而一个 turn 内 leaf id 会变化好几次。以前每次都从头扫整条分支（长会话下每条
 * 消息都要遍历几百上千条 entry）。这里缓存"已累加到的位置"，新分支只要是同一前缀
 * （`entries[已累加长度-1]` 还是同一个对象引用——分支数组每次新建，但 entry 对象
 * 是共享的），就只处理尾巴。
 *
 * 每次返回的都是**新对象**：调用方可以随意读，不会污染缓存里的累积值。
 */
export function createSessionStatsComputer(): (
	entries: readonly StatEntryLike[],
	now?: number,
) => SessionStats {
	let computedLength = 0;
	let lastEntry: StatEntryLike | undefined;
	let base = emptyStats();
	let tracker: TurnTracker = { first: 0, last: 0, turnStart: 0, turnEnd: 0 };
	/** 距上次全量重算调用了几次（防止就地改写历史 entry 后一直按旧值累加）。 */
	let sinceFullRecompute = 0;
	/** 全量重算间隔（调用次数）。 */
	const FULL_RECOMPUTE_EVERY = 20;

	return (entries: readonly StatEntryLike[], now: number = Date.now()): SessionStats => {
		sinceFullRecompute += 1;
		// 前缀续算只校验"最后一个已算条目还是同一个对象"，挡不住"历史条目被就地改写"
		// （compaction/会话编辑会改 timestamp）。周期性全量重算兜底，成本摊薄后无感。
		const forceFull = sinceFullRecompute >= FULL_RECOMPUTE_EVERY;
		const canExtend =
			!forceFull &&
			computedLength > 0 &&
			entries.length >= computedLength &&
			entries[computedLength - 1] === lastEntry;
		if (!canExtend) {
			base = emptyStats();
			tracker = { first: 0, last: 0, turnStart: 0, turnEnd: 0 };
			computedLength = 0;
			sinceFullRecompute = 0;
		}
		for (let i = computedLength; i < entries.length; i++) {
			const entry = entries[i]!;
			addEntryStats(base, entry);
			trackEntryTime(base, tracker, entry);
		}
		computedLength = entries.length;
		lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;

		// finalize 会改 stats（补最后一轮 + 派生值），所以作用在副本上，
		// 缓存里的 base 只保留"已完成条目"的累积。
		const stats: SessionStats = { ...base };
		finalizeStats(stats, tracker, now);
		return stats;
	};
}

export function computeSessionStats(
	entries: readonly StatEntryLike[],
	now: number = Date.now(),
): SessionStats {
	const stats = emptyStats();
	// 单遍遍历：usage 统计与时间累计共用同一条 entry（每条只 Date.parse 一次）。
	const tracker: TurnTracker = { first: 0, last: 0, turnStart: 0, turnEnd: 0 };
	for (const entry of entries) {
		addEntryStats(stats, entry);
		trackEntryTime(stats, tracker, entry);
	}
	finalizeStats(stats, tracker, now);
	return stats;
}
