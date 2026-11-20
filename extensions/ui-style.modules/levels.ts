/**
 * 思考档位（共享层）
 *
 * 之前这套东西在状态栏和信息面板各写了一份，颜色还漂了（同一个 high 一边是
 * 天蓝、一边是黄）。统一到这里：档位顺序、模型能力过滤、配色都只有一份。
 */

import { fg24 } from "./core.ts";
import type { Rgb } from "./core.ts";

/** 从低到高的全部档位（pi 的定义顺序）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** 档位 → 颜色（状态栏、信息面板、思考块共用一套观感）。 */
export const THINKING_COLORS: Record<string, Rgb> = {
	off: [110, 110, 110],
	minimal: [120, 120, 120],
	low: [95, 135, 215],
	medium: [79, 179, 217],
	high: [125, 211, 252],
	xhigh: [234, 182, 93],
	max: [228, 138, 122],
};

/** 档位的着色文本（未知档位走调用方给的 fallback）。 */
export function thinkingText(level: string, fallback: (text: string) => string): string {
	const rgb = THINKING_COLORS[level];
	return rgb ? fg24(rgb, level) : fallback(level);
}

/** 模型能力的形状（只要有这两个字段就够判档位）。 */
export interface ThinkingModelLike {
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, unknown> | null;
}

/**
 * 模型支持的思考档位（与 pi-ai 的 `getSupportedThinkingLevels` 同一规则）：
 * 非推理模型只有 off；`thinkingLevelMap[level] === null` 表示不支持；
 * xhigh / max 必须显式映射才可用。
 *
 * ⚠ 这是**规则副本**：pi 没有从包里导出 `getSupportedThinkingLevels`（只导出
 * `scopedModels` / `getAvailableModels` 之类的接口），所以只能自己实现。
 * 对照版本：pi-coding-agent **1.5.2**（`dist/core/model-runtime.js` 的
 * `getSupportedThinkingLevels`）。升级 pi 时如果"思考档位列表"行为变了，先看这里。
 */
export function supportedThinkingLevels(model: ThinkingModelLike | undefined): string[] {
	if (!model?.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}
