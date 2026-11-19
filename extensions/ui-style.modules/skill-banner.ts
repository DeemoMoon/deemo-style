/**
 * 六、技能调用横幅样式（原型补丁：无背景 + 图标标题 + ⎿ 预览）
 */

import {
	MouseRegion,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	ACCENT_BLUE,
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	collapsePreviewLines,
	headLinesOfTexts,
	ICON_SKILL,
	moreLinesNoun,
	MUTED,
	patchPrototypeSlots,
	PREVIEW_CONNECTOR_GAP,
	RESET_FG,
	sgr,
	SKILL_PREVIEW_LINES,
	UI_INDENT_WIDTH,
	unpatchPrototypeSlots,
} from "./core.ts";

interface SkillBlockLike {
	name?: string;
	content?: string;
}

interface SkillBannerPrototype {
	expanded: boolean;
	skillBlock: SkillBlockLike;
	clear(): void;
	addChild(component: Component): void;
	setBgFn(bgFn?: (text: string) => string): void;
	setPaddingX(padding: number): void;
	setExpanded(expanded: boolean): void;
	updateDisplay(): void;
	[key: `ui-style:${string}`]: unknown;
}

/** 技能横幅标题里图标与技能名之间的分隔符。 */
const SKILL_TITLE_SEPARATOR = " · ";
/** 技能横幅正文的起始列 = 图标(1) + 分隔符，⎿ 预览对齐到技能名首字。 */
const SKILL_BODY_COLUMN = 1 + SKILL_TITLE_SEPARATOR.length;
/** 技能预览首行/续行前缀：首行把 ⎿ 放在正文列上，续行把正文对齐到同一列。 */
const SKILL_PREVIEW_FIRST = `${" ".repeat(SKILL_BODY_COLUMN)}⎿${PREVIEW_CONNECTOR_GAP}`;
const SKILL_PREVIEW_REST = " ".repeat(
	SKILL_BODY_COLUMN + 1 + PREVIEW_CONNECTOR_GAP.length,
);

/** 第一行标题：图标 · 技能名 · 已加载（蓝色，技能名加粗）。 */
function skillHeader(name: string): string {
	const accent = sgr(ACCENT_BLUE);
	return (
		`${accent}${ICON_SKILL}${SKILL_TITLE_SEPARATOR}` +
		`${BOLD_ON}${name}${BOLD_OFF}${SKILL_TITLE_SEPARATOR}已加载${RESET_FG}`
	);
}

/**
 * 折叠态的横幅视图：第一行标题，随后用与思考块相同的 ⎿ 连接线
 * 显示技能内容的前 4 行，更多折叠进"点击展开"提示。
 */
class SkillPreviewView extends CachedView {
	private readonly name: string;
	private readonly body: string;

	constructor(name: string, body: string) {
		super();
		this.name = name;
		this.body = body;
	}

	protected renderLines(width: number): string[] {
		const header = truncateToWidth(skillHeader(this.name), Math.max(0, width), "…");
		if (width < 9) return [header];

		// ⎿ 对齐技能名首字：图标(1) + " · "(3) = 4 列，再空 2 列后接正文。
		const firstPrefix = SKILL_PREVIEW_FIRST;
		const nextPrefix = SKILL_PREVIEW_REST;
		const contentWidth = Math.max(1, width - firstPrefix.length);
		const lines: string[] = [header];
		const body = collapsePreviewLines(
			headLinesOfTexts([this.body], SKILL_PREVIEW_LINES + 1),
			SKILL_PREVIEW_LINES,
			contentWidth,
			(line) => line,
		);
		body.lines.forEach((segment, index) => {
			const prefix = index === 0 ? firstPrefix : nextPrefix;
			lines.push(`${prefix}${MUTED}${segment}${RESET_FG}`);
		});
		if (body.remaining > 0) {
			// 提示行也要按宽度换行：固定文本 + 中文字形在窄终端下会超宽（pi 会报错）。
			for (const segment of wrapTextWithAnsi(
				`${MUTED}... (${body.remaining} more ${moreLinesNoun(body.remaining)}, 点击展开)${RESET_FG}`,
				contentWidth,
			)) {
				lines.push(`${nextPrefix}${segment}`);
			}
		}
		return lines;
	}
}

export function patchSkillBanner(): void {
	const proto = SkillInvocationMessageComponent.prototype as unknown as SkillBannerPrototype;
	// 先捕获原方法：patchPrototypeSlots 内部会做一次恢复再重打（幂等）。
	const originalUpdateDisplay = proto.updateDisplay;
	const originalSetPaddingX = proto.setPaddingX;

	// 强制缩进在每次重建时生效：pi 创建组件后不一定调用 setPaddingX，
	// 只补丁方法不主动触发的话缩进不会生效。
	const patchedSetPaddingX = function (this: SkillBannerPrototype, _padding: number): void {
		originalSetPaddingX.call(this, UI_INDENT_WIDTH);
	};

	const patchedUpdateDisplay = function (this: SkillBannerPrototype): void {
		this.setPaddingX(UI_INDENT_WIDTH);
		originalUpdateDisplay.call(this);
		// 去掉整条紫色背景（展开态同样生效）。
		this.setBgFn(undefined);
		// 展开态保留 pi 原样（[skill] 标签 + 完整 SKILL.md，仅无背景）。
		if (this.expanded) return;

		// 折叠态：重建为“图标 · 技能名 · 已加载 + ⎿ 4 行预览”。
		// pi 改了内部结构时宁可退回原样，也不要把这块整个打没。
		try {
			const name = this.skillBlock.name ?? "";
			const body = this.skillBlock.content ?? "";
			this.clear();
			this.addChild(
				new MouseRegion(
					new SkillPreviewView(name, body) as unknown as Component,
					(event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.setExpanded(!this.expanded);
						return { handled: true };
					},
				),
			);
		} catch {
			this.clear();
			originalUpdateDisplay.call(this);
		}
	};
	patchPrototypeSlots(proto, "ui-style:skill", {
		updateDisplay: patchedUpdateDisplay,
		setPaddingX: patchedSetPaddingX,
	});
}

/** 恢复 pi 原来的渲染方法；删除扩展或重启时使用。 */
export function unpatchSkillBanner(): void {
	const proto = SkillInvocationMessageComponent.prototype as unknown as SkillBannerPrototype;
	unpatchPrototypeSlots(proto, "ui-style:skill", ["updateDisplay", "setPaddingX"]);
}

