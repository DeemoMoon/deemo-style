/**
 * 十、输入框上方信息条（tokens / 速度 / 首字延迟 / 耗时）
 *
 * 所有数字都来自事件与统一节拍 tick；render 只读缓存，不做 O(会话规模)
 * 的查询（getContextUsage 走 core 的共享缓存）。
 */

import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
} from "node:path";
import {
	BAD_RED,
	CHROME_LEFT_PAD,
	chromeLine,
	contextUsageCached,
	formatDuration,
	formatPanelDuration,
	formatTokens,
	mixRgb,
	promptTokens,
	resetContextUsageCache,
	RESET_FG,
	sgr,
	SKY_BLUE_RGB,
	subscribeAnimationTick,
	WARN_YELLOW,
} from "./core.ts";
import type { InfoMessageLike, Rgb, ThinkingContentLike, UsageLike } from "./core.ts";

/** 信息条在 pi 内部的键，session_shutdown / reload 时用来清掉。 */
const WIDGET_KEY = "input-info-bar";

/**
 * 信息条的刷新节拍：不自己开定时器，跟工作文案呼吸、沙漏轮转共用
 * core 的统一节拍（ANIMATION_TICK_MS，见 core.ts）。
 *
 * 以前这里是 120ms 的独立 interval，加上呼吸 60ms、spinner 180ms，
 * 任务期间会有好几条 timer 各自 requestRender（虽然 pi 会在 16ms 窗口内合并，
 * 但仍然把帧率推到了 20+）。合并后任务期间约 10 帧/秒 + spinner 帧。
 */
/** 流式重绘节流（毫秒），避免每个 token 都重排整行。 */
const RENDER_THROTTLE_MS = 100;

/** 信息条图标（Nerd Font 私有区字形；Plane 15 码位写成代理对）。 */
const INFO_ICON_IN = "\uf176";
const INFO_ICON_OUT = "\uf175";
const INFO_ICON_LATENCY = "\uDB80\uDD52"; // U+F0152
const INFO_ICON_TIME = "\udb81\udd1f"; // U+F051F

/**
 * 速度图标：按 tok/s 分三档（字形 + 颜色），档内做**平滑呼吸**（亮度渐变）。
 *
 * 分档（含边界）：≤60 天青 / 61~150 黄 / ≥151 红。
 * 呼吸周期也按档走：低档 6s（慢而稳）、中档 4s、高档 2s（越急越躁）。
 * 只调亮度、不换字形，且亮度只在 45%~100% 之间余弦往复——不熄灭、不跳变，
 * 所以没有“闪”的感觉，只有渐变。
 */
export interface SpeedTier {
	/** 该档的速度上限（tok/s）。 */
	max: number;
	glyph: string;
	/** 基色（亮度动画以它为 100%）。 */
	rgb: Rgb;
	/** 该档的呼吸周期（毫秒）。 */
	breathMs: number;
}

/** 变暗时向黑色混合（保持色相）。 */
const BLACK: Rgb = [0, 0, 0];

const SPEED_TIERS: readonly SpeedTier[] = [
	{ max: 60, glyph: "\udb83\udf86", rgb: SKY_BLUE_RGB, breathMs: 6000 }, // U+F0F86 速度表(慢) 天青
	{ max: 150, glyph: "\udb83\udf85", rgb: WARN_YELLOW, breathMs: 4000 }, // U+F0F85 速度表(中) 黄
	{ max: Number.POSITIVE_INFINITY, glyph: "\udb81\udcc5", rgb: BAD_RED, breathMs: 2000 }, // U+F04C5 速度表 红
];
/** 呼吸的两端：最暗 45%（仍然看得清），最亮 100%。 */
const SPEED_INTENSITY_MIN = 0.45;
const SPEED_INTENSITY_MAX = 1;
/** 空闲（不在任务中）时的固定亮度：取呼吸中位，不闪也不暗。 */
const SPEED_IDLE_INTENSITY = (SPEED_INTENSITY_MIN + SPEED_INTENSITY_MAX) / 2;

/**
 * 计时图标：4 个沙漏形态轮转（󰔟 → 󱦟 → 󰚭 → 󰞌），固定颜色。
 *
 * 曾经做过“亮度包络”（换字点压暗）想掩盖字形硬跳，实际观感更像闪烁，
 * 已经去掉；现在只是单纯的 4 帧轮转，每帧 HOURGLASS_FRAME_MS，
 * 一轮 = 4 × 1200 = 4.8s。
 */
const HOURGLASS_FRAME_MS = 1200;
const HOURGLASS_FRAMES = [
	INFO_ICON_TIME, // U+F051F nf-md-timer_sand
	"\udb86\udd9f", // U+F199F
	"\udb81\udead", // U+F06AD nf-md-timer_sand_empty
	"\udb81\udf8c", // U+F078C nf-md-timer_sand_full
] as const;
/** 沙漏固定色（不再随帧变亮度）。 */
const HOURGLASS_COLOR = "\x1b[38;2;169;228;245m";

/** 当前该画的沙漏字形（纯函数：只吃 elapsed，不持有状态/定时器）。 */
function hourglassGlyph(elapsedMs: number): string {
	const index = Math.floor(elapsedMs / HOURGLASS_FRAME_MS) % HOURGLASS_FRAMES.length;
	return HOURGLASS_FRAMES[index] ?? HOURGLASS_FRAMES[0]!;
}

const SPEED_UNIT = "tok/s";
const TOKEN_UNIT = "tok";
/** 分隔符：圆点两侧各留两个空格，让各项之间的距离宽松一些。 */
const INFO_SEP = "  •  ";

/** 实时输出速度的估算状态。 */
interface TpsTracker {
	startedAt: number | undefined;
	outputTokens: number;
	estimatedChars: number;
	tokensPerChar: number;
	last: number | undefined;
}

/** 一个“任务”的计时：agent_start -> agent_settled。 */
interface TaskTimer {
	startedAt: number | undefined;
	endedAt: number | undefined;
	running: boolean;
}

/** 本轮（一次 agent 运行）的 token 统计。 */
interface TurnStats {
	input: number;
	output: number;
	hasUsage: boolean;
}

const DEFAULT_TOKENS_PER_CHAR = 0.3;
const MIN_TOKENS_PER_CHAR = 0.12;
const MAX_TOKENS_PER_CHAR = 1.4;

/**
 * 只用于校准 tokens/char 比例，量级对就够：超长字符串在 stringify 时截断，
 * 避免一条大文件写入的参数在 message_end 时整段序列化（几 MB 的复制）。
 */
const ESTIMATE_STRING_LIMIT = 4000;

function safeJsonLengthBounded(value: unknown): number {
	try {
		const length = JSON.stringify(value, (_key, val: unknown) =>
			typeof val === "string" && val.length > ESTIMATE_STRING_LIMIT
				? val.slice(0, ESTIMATE_STRING_LIMIT)
				: val,
		)?.length;
		return length ?? 0;
	} catch {
		return 0;
	}
}

/** 统计助手消息内容里的字符数：文本 + 思考 + 工具参数（校准基准）。 */
function estimateContentChars(content: string | ThinkingContentLike[] | undefined): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	// 块级预算：单块内 safeJsonLengthBounded 只截超长字符串，大数组/深嵌套的
	// 结构本身仍会被全量遍历，所以再加一道总量闸门，超预算就不再往下扫。
	// 校准是渐进的，少采一块无妨。
	let budget = 8192;
	for (const block of content) {
		if (budget <= 0) break;
		if (!block || typeof block !== "object") continue;
		let blockChars = 0;
		if (block.type === "text") blockChars = (block as { text?: string }).text?.length ?? 0;
		else if (block.type === "thinking") blockChars = block.thinking?.length ?? 0;
		else blockChars = safeJsonLengthBounded(block);
		chars += blockChars;
		budget -= blockChars;
	}
	return chars;
}

/** 速度档：≤60 天青 / 61~150 黄 / ≥151 红（未如速度也算最低档）。 */
export function speedTier(speed: number | undefined): SpeedTier {
	const value = speed ?? 0;
	for (const tier of SPEED_TIERS) if (value <= tier.max) return tier;
	return SPEED_TIERS[SPEED_TIERS.length - 1]!;
}

/** 一帧速度图标：档位字形 + 按亮度插值的档位颜色 + 亮度 + 该档呼吸周期。 */
export interface SpeedFrame {
	glyph: string;
	color: string;
	/** 0 = 最暗，1 = 最亮（呼吸两端）。 */
	intensity: number;
	/** 该档的呼吸周期（毫秒），方便调用方/测试知道节奏。 */
	breathMs: number;
}

/** 档位基色 × 亮度（向黑色混合，保持色相）。 */
function tint(rgb: Rgb, intensity: number): string {
	return sgr(mixRgb(mixRgb(rgb, BLACK, 0.7), rgb, intensity));
}

/**
 * 当前该画的速度图标（纯函数：只吃 elapsed 与速度）。
 *
 * 亮度走余弦：0 → 1 → 0 的平滑往复（不是方波，所以是渐变而不是闪），
 * 周期取该档的 breathMs（6s / 4s / 2s）；亮度钳在 45%~100%，永远不会熄灭。
 */
export function speedFrame(elapsedMs: number, speed: number | undefined): SpeedFrame {
	const tier = speedTier(speed);
	const phase = (((elapsedMs % tier.breathMs) + tier.breathMs) % tier.breathMs) / tier.breathMs;
	const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
	const intensity =
		SPEED_INTENSITY_MIN + (SPEED_INTENSITY_MAX - SPEED_INTENSITY_MIN) * wave;
	return {
		glyph: tier.glyph,
		color: tint(tier.rgb, intensity),
		intensity,
		breathMs: tier.breathMs,
	};
}

/** 空闲时的一帧：字形/颜色按档位，亮度固定在中位（不呼吸、不闪）。 */
export function speedIdleFrame(speed: number | undefined): SpeedFrame {
	const tier = speedTier(speed);
	return {
		glyph: tier.glyph,
		color: tint(tier.rgb, SPEED_IDLE_INTENSITY),
		intensity: SPEED_IDLE_INTENSITY,
		breathMs: tier.breathMs,
	};
}

class InfoBarWidget implements Component {
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly tps: TpsTracker,
		private readonly task: TaskTimer,
		private readonly turn: TurnStats,
		/** 本轮还没有真实 usage 时，用来顶上的“当前上下文大小”估算。 */
		private readonly getEstimatedInput: () => number | undefined,
		/** 最近一轮的首字延迟（毫秒）；本轮还没出首字 / 尚无记录时为 undefined。 */
		private readonly getTtft: () => number | undefined,
	) {}

	invalidate(): void {}

	dispose(): void {}

	/** 本轮流式中、还没落账的输出 token 估算值。 */
	private liveOutput(): number {
		return this.tps.startedAt !== undefined ? this.tps.outputTokens : 0;
	}

	/**
	 * 输入那一格的文案：有真实 usage 显示最近一次调用的 prompt；
	 * 还没拿到时先用当前上下文大小顶上，不会长时间空白、最后突然跳出终值。
	 */
	private inputText(): string {
		if (this.turn.hasUsage) return formatTokens(this.turn.input);
		if (this.task.running) {
			const estimate = this.getEstimatedInput();
			if (typeof estimate === "number" && estimate > 0) return formatTokens(estimate);
		}
		return "--";
	}

	/** 当前速度的数值（tok/s）；流式中不足 0.5s 且没有上一次的速度时为 undefined。 */
	private speedValue(): number | undefined {
		const { startedAt, outputTokens, last } = this.tps;
		if (startedAt !== undefined && outputTokens > 0) {
			const elapsed = (Date.now() - startedAt) / 1000;
			if (elapsed >= 0.5) return outputTokens / elapsed;
		}
		return last;
	}

	private currentSpeed(): string {
		const speed = this.speedValue();
		return speed !== undefined ? speed.toFixed(1) : "--";
	}

	/** 首字延迟一格的文案。 */
	private ttftText(): string {
		const ttft = this.getTtft();
		return ttft !== undefined ? formatPanelDuration(ttft) : "--";
	}

	private currentElapsed(): string {
		const { startedAt, endedAt, running } = this.task;
		if (startedAt === undefined) return "--";
		return formatDuration((running ? Date.now() : (endedAt ?? Date.now())) - startedAt);
	}

	render(width: number): string[] {
		const outputTotal = this.turn.output + this.liveOutput();
		const hasOutput = this.turn.hasUsage || outputTotal > 0;

		// 只有 agent 正在跑或正在流式输出时，沙漏/速度图标才动；空闲时静止。
		const animating = this.task.running || this.tps.startedAt !== undefined;
		const animationStart = this.task.startedAt ?? this.tps.startedAt;
		const elapsed =
			animating && animationStart !== undefined ? Math.max(0, Date.now() - animationStart) : 0;
		// 速度图标：字形+颜色按速度分三档；任务中按档位周期做平滑呼吸，空闲固定中位亮度。
		const speed = this.speedValue();
		const speedIcon = animating ? speedFrame(elapsed, speed) : speedIdleFrame(speed);
		// 图标 + 后面那个空格一同染色：PUA 字形可能被终端按 2 列渲染，
		// 空格也染上色，第 2 个填充格就不会露出默认前景色（宽度不变）。
		const speedPart = `${speedIcon.color}${speedIcon.glyph} ${RESET_FG}`;
		// 空闲时停在第一帧；跑起来就轮转（颜色始终固定，不闪）。
		const hourglass = animating ? hourglassGlyph(elapsed) : HOURGLASS_FRAMES[0]!;

		// 整条信息默认用终端正常白色；只有速度图标和沙漏图标带颜色。
		const parts = [
			`${INFO_ICON_IN} ${this.inputText()} ${TOKEN_UNIT}`,
			`${INFO_ICON_OUT} ${hasOutput ? formatTokens(outputTotal) : "--"} ${TOKEN_UNIT}`,
			`${speedPart}${this.currentSpeed()} ${SPEED_UNIT}`,
			`${INFO_ICON_LATENCY} ${this.ttftText()}`,
			// 同理：沙漏后面那个空格也在染色范围内
			`${HOURGLASS_COLOR}${hourglass} ${RESET_FG}${this.currentElapsed()}`,
		];

		const line = parts.join(INFO_SEP);

		// 右侧要留出缩进的列数，保证整条只占一行、不换行。
		const available = Math.max(1, width - CHROME_LEFT_PAD);
		const body = visibleWidth(line) > available ? truncateToWidth(line, available, "...") : line;
		// 整条加粗：行内的图标色序列只含前景复位（39），不会关掉加粗。
		return [chromeLine(body)];
	}
}

export function setupInfoBar(pi: ExtensionAPI): void {
	const tps: TpsTracker = {
		startedAt: undefined,
		outputTokens: 0,
		estimatedChars: 0,
		tokensPerChar: DEFAULT_TOKENS_PER_CHAR,
		last: undefined,
	};
	const task: TaskTimer = { startedAt: undefined, endedAt: undefined, running: false };
	const turn: TurnStats = { input: 0, output: 0, hasUsage: false };

	/** 校准用的累计值：真实 output token 与内容字符数。 */
	let realTokens = 0;
	let contentChars = 0;

	/** 最近一轮的首字延迟（毫秒）：本轮从 agent_start 到第一个 token 到达。 */
	let ttftMs: number | undefined;

	let tui: TUI | undefined;
	/** 统一动画节拍的退订函数（见 core.subscribeAnimationTick）。 */
	let unsubscribeTick: (() => void) | undefined;
	let lastRenderAt = 0;
	/** tick 空转去重：上次触发重渲染时的廉价显示快照。 */
	let lastTickSnapshot = "";

	/**
	 * 当前上下文大小（token）：本轮第一条消息结束前，用它顶上输入那一格。
	 * 只在 refresh 时真正调 pi 的 getContextUsage()——它每次都会重建整个会话
	 * 投影（O(会话规模)），不能放在 render 的每帧路径上。
	 */
	let contextTokens: number | undefined;
	let refreshContextTokens: () => void = () => {};

	/** 清零信息条状态：切会话后不应残留上一个会话的数字。 */
	const resetStats = () => {
		tps.startedAt = undefined;
		tps.outputTokens = 0;
		tps.estimatedChars = 0;
		tps.last = undefined;
		task.startedAt = undefined;
		task.endedAt = undefined;
		task.running = false;
		turn.input = 0;
		turn.output = 0;
		turn.hasUsage = false;
		realTokens = 0;
		contentChars = 0;
		ttftMs = undefined;
		contextTokens = undefined;
		lastTickSnapshot = "";
	};

	/** 只有在“任务进行中”或“正在流式”时才需要定时跳动。 */
	const needsLiveUpdates = () => task.running || tps.startedAt !== undefined;

	const startLiveUpdates = () => {
		if (unsubscribeTick) return;
		unsubscribeTick = subscribeAnimationTick("input-info-bar", () => {
			// 显示值没变就不请求整屏重渲染（pi 的 ScrollView 无视口裁剪，一次就是一帧）
			const snapshot = `${Math.round(tps.outputTokens)}|${Math.floor(((task.running ? Date.now() : (task.endedAt ?? 0)) - (task.startedAt ?? 0)) / 1000)}`;
			if (snapshot === lastTickSnapshot) return;
			lastTickSnapshot = snapshot;
			tui?.requestRender();
		});
	};

	const stopLiveUpdates = () => {
		unsubscribeTick?.();
		unsubscribeTick = undefined;
	};

	const requestLiveRender = () => {
		if (needsLiveUpdates()) startLiveUpdates();
		else stopLiveUpdates();

		const now = Date.now();
		if (now - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastRenderAt = now;
		tui?.requestRender();
	};

	const calibrate = (output: number, chars: number) => {
		if (output <= 0 || chars < 40) return;
		realTokens += output;
		contentChars += chars;
		const ratio = realTokens / contentChars;
		tps.tokensPerChar = Math.min(MAX_TOKENS_PER_CHAR, Math.max(MIN_TOKENS_PER_CHAR, ratio));
	};

	/**
	 * 用最新的 usage 更新输入那一格（覆盖而非累加：usage 在 start/update/end
	 * 各来一次，工具往返后显示最新一轮的 prompt，不会越滚越大）。
	 */
	const syncPrompt = (usage: UsageLike | undefined) => {
		const prompt = promptTokens(usage);
		// 不在此处检查 task.running：message_start/message_update 的调用点
		// 要求 usage 到了就显示（不依赖 agent_start 先到达的事件顺序）；
		// message_end 落账 output 时才要求 running（避免历史回放污染），
		// prompt 显示不设防。
		if (prompt <= 0) return;
		turn.input = prompt;
		turn.hasUsage = true;
	};

	pi.on("message_start", (event) => {
		const message = event.message as unknown as InfoMessageLike;
		if (message.role !== "assistant") return;
		tps.startedAt = Date.now();
		tps.outputTokens = message.usage?.output ?? 0;
		tps.estimatedChars = 0;
		tps.last = undefined;

		// Anthropic 这类 provider 在 message_start 就会带回 input_tokens / cache_*。
		syncPrompt(message.usage);

		requestLiveRender();
	});

	pi.on("message_update", (event) => {
		const message = event.message as unknown as InfoMessageLike;
		if (message.role !== "assistant" || tps.startedAt === undefined) return;

		// 部分 provider 中途就会给出真实 output，优先采用。
		const realOutput = message.usage?.output ?? 0;

		// 多数 provider 只在结束时才给 usage，这里按“已输出字符数 × 校准比例”实时估算。
		const streamEvent = event.assistantMessageEvent as unknown as {
			type?: string;
			delta?: string;
		};
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			tps.estimatedChars += streamEvent.delta?.length ?? 0;
			// 首字延迟：本轮第一个 token 到达的时刻减去 agent_start；
			// 只记第一份（后续工具往返的新消息不覆盖）。
			if (ttftMs === undefined) {
				ttftMs = Math.max(0, Date.now() - (task.startedAt ?? Date.now()));
			}
		}
		tps.outputTokens = Math.max(realOutput, tps.estimatedChars * tps.tokensPerChar);
		syncPrompt(message.usage);
		requestLiveRender();
	});

	pi.on("message_end", (event) => {
		const message = event.message as unknown as InfoMessageLike;
		if (message.role === "assistant" && tps.startedAt !== undefined) {
			const realOutput = message.usage?.output;
			const output =
				typeof realOutput === "number" && realOutput > 0 ? realOutput : tps.outputTokens;
			const elapsed = (Date.now() - tps.startedAt) / 1000;
			if (elapsed > 0.2 && output > 0) tps.last = output / elapsed;
			calibrate(realOutput ?? 0, estimateContentChars(message.content));

			// 只在“本轮 agent 运行中”才落账，避免历史回放污染数字。
			// provider 没回 output 时用上面算好的估算值兜底（output 变量）。
			syncPrompt(message.usage);
			if (task.running) turn.output += Math.round(output);

			tps.startedAt = undefined;
			tps.outputTokens = 0;
			tps.estimatedChars = 0;
		}
		refreshContextTokens();
		requestLiveRender();
	});

	pi.on("agent_start", () => {
		task.startedAt = Date.now();
		task.endedAt = undefined;
		task.running = true;

		// 新的一轮，输入/输出重新计数，首字延迟清零重测。
		turn.input = 0;
		turn.output = 0;
		turn.hasUsage = false;
		ttftMs = undefined;

		requestLiveRender();
	});

	const endTask = () => {
		if (!task.running) return;
		task.endedAt = Date.now();
		task.running = false;
		requestLiveRender();
	};

	pi.on("agent_end", endTask);
	pi.on("agent_settled", endTask);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// 换会话了：清掉上一会话的 token/耗时，避免信息条开局显示旧数字。
		resetStats();

		// 上下文大小只在 message_end / session_start 时算一次，render 只读缓存。
		refreshContextTokens = () => {
			const tokens = contextUsageCached(ctx)?.tokens;
			contextTokens = typeof tokens === "number" ? tokens : undefined;
		};
		refreshContextTokens();

		ctx.ui.setWidget(
			WIDGET_KEY,
			(ui, theme) => {
				tui = ui;
				return new InfoBarWidget(
					ui,
					theme,
					tps,
					task,
					turn,
					() => contextTokens,
					() => ttftMs,
				);
			},
			{ placement: "aboveEditor" },
		);
		requestLiveRender();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		stopLiveUpdates();
		tui = undefined;
		refreshContextTokens = () => {};
		resetStats();
		resetContextUsageCache();
	});
}
