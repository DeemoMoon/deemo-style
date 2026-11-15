/**
 * 上下文占用色条 + 档位阈值（共享层）
 *
 * 之前状态栏和信息面板各画一套：字形不同（▣□ vs █░）、空槽颜色也不同
 * （[110,110,110] vs [74,74,74]），阈值还各自硬编码。统一到这里。
 */

import { BAD_RED, OK_GREEN, sgr, WARN_YELLOW, RESET_FG } from "./core.ts";
import type { Rgb } from "./core.ts";

/** 占用率/命中率的三档。 */
export type Level = "ok" | "warn" | "bad";

/** 档位阈值：≤50 绿、≤80 黄、其余红。 */
export const LEVEL_OK_AT = 50;
export const LEVEL_WARN_AT = 80;

/** 上下文占用：越高越糟（≥81 红）。 */
export function levelOf(percent: number | null | undefined): Level {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "ok";
	const clamped = Math.max(0, Math.min(100, percent));
	if (clamped <= LEVEL_OK_AT) return "ok";
	if (clamped <= LEVEL_WARN_AT) return "warn";
	return "bad";
}

/** 档位 → 色条填充色。 */
export const LEVEL_BAR_FILL: Record<Level, Rgb> = {
	ok: OK_GREEN,
	warn: WARN_YELLOW,
	bad: BAD_RED,
};

/**
 * 百分比数字专用的降饱和档位色：高饱和原色在深底上抗锯齿边缘对比强，
 * 笔画视觉上偏粗（显粗不是真的加粗）；数字用柔色，色条保持原饱和度。
 */
export const LEVEL_MUTED: Record<Level, Rgb> = {
	ok: [126, 180, 120],
	warn: [208, 178, 116],
	bad: [228, 122, 110],
};

/**
 * 缓存命中率：**越高越好**（≤50 红、≤80 黄、其余绿）。
 *
 * 注意别和 `levelOf()` 混用：那个是"上下文占用率"，越高越糟。
 * 两者阈值相同、方向相反，写反了就会出现"99.2% 缓存命中显示成红色"。
 */
export function hitRateLevel(rate: number | null | undefined): Level {
	if (typeof rate !== "number" || !Number.isFinite(rate)) return "ok";
	if (rate <= LEVEL_OK_AT) return "bad";
	if (rate <= LEVEL_WARN_AT) return "warn";
	return "ok";
}

/** 档位 → 色条填充色（按百分比取档位）。 */
export function levelRgb(percent: number | null | undefined): Rgb {
	return LEVEL_BAR_FILL[levelOf(percent)];
}

/** 缓存命中率 → 颜色（数字与色条用同一套）。 */
export function hitRateRgb(rate: number | null | undefined): Rgb {
	return LEVEL_BAR_FILL[hitRateLevel(rate)];
}

/** 缓存命中率 → 降饱和数字色。 */
export function hitRateMuted(rate: number | null | undefined): Rgb {
	return LEVEL_MUTED[hitRateLevel(rate)];
}

/** 色条字形：状态栏用 ▣□（细），信息面板用 █░（粗）。 */
export type BarStyle = "box" | "block";

const BAR_GLYPHS: Record<BarStyle, { filled: string; empty: string }> = {
	box: { filled: "\u25A3", empty: "\u25A1" },
	block: { filled: "\u2588", empty: "\u2591" },
};

/** 未占用格子的颜色（统一暗灰）。 */
const BAR_EMPTY_RGB: Rgb = [90, 90, 90];

/**
 * 渲染占用率色条：已占用格子按"该格子中点"取档位色，未占用为暗灰空心。
 * 全程只用前景色，不引入背景色。
 */
export function renderContextBar(
	percent: number | null | undefined,
	cells: number,
	style: BarStyle = "box",
): string {
	if (cells <= 0) return "";
	const glyphs = BAR_GLYPHS[style];
	const known = typeof percent === "number" && Number.isFinite(percent);
	const clamped = known ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = known ? Math.round((clamped / 100) * cells) : 0;

	const parts: string[] = [];
	for (let i = 0; i < cells; i++) {
		const midpoint = ((i + 0.5) / cells) * 100;
		const isFilled = i < filled;
		const rgb = isFilled ? levelRgb(midpoint) : BAR_EMPTY_RGB;
		parts.push(`${sgr(rgb)}${isFilled ? glyphs.filled : glyphs.empty}${RESET_FG}`);
	}
	return parts.join("");
}
