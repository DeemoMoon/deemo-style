/**
 * 九、圆角输入框 + 最左侧常驻输入符号 + 工作中呼吸文案
 */

import {
	Loader,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CustomEditor,
} from "@earendil-works/pi-coding-agent";
import {
	BOLD_OFF,
	BOLD_ON,
	CORAL,
	mixRgb,
	RESET_FG,
	sgr,
	SKY_BLUE,
	patchPrototypeSlots,
	subscribeAnimationTick,
	unpatchPrototypeSlots,
} from "./core.ts";
import type { Rgb } from "./core.ts";

/**
 * 输入框内左边距：输入符号占 1 列 + 其后 1 个空格，因此符号本身落在
 * BLOCK_INDENT_WIDTH 列（与信息条 / 状态栏 / 工具面板同列）。
 */
const PROMPT_GLYPH_WIDTH = 1;
const PROMPT_WIDTH = PROMPT_GLYPH_WIDTH + 1;

/** 圆角框左右边框各占的列数（render 加框与 handleMouse 坐标回换算共用）。 */
const BORDER_INSET = 1;

/**
 * 转圈符号：月相 8 帧一轮（🌕🌖🌗🌘🌑🌒🌓🌔）。
 *
 * 月相本身就是一轮“旋转”，比点阵盲文更贴话题；emoji 在终端里占 2 列，
 * pi-tui 的 visibleWidth 也算 2 列，所以边框宽度不会错位（已用
 * visibleWidth 逐帧验证）；且不再为帧着色（emoji 自带颜色，SGR 会破坏它）。
 */
const WORKING_FRAMES = ["🌕", "🌖", "🌗", "🌘", "🌑", "🌒", "🌓", "🌔"];
/**
 * 帧间隔（口味旋钮）：月亮转一圈 = 8 × WORKING_INTERVAL_MS。
 *
 * 这个值同时决定 spinner 驱动的整屏重渲染频率（spinner 每帧都会
 * requestRender）：80ms → 12.5 次/秒，180ms → 约 5.6 次/秒。
 */
const WORKING_INTERVAL_MS = 180;

/** 工作文案（无省略号：省略号会和后面的月相/计时挤在一起）。 */
const WORKING_TEXT = "工作中";

/**
 * 滚动呼吸：亮黄 ↔ 暗紫，左侧往右滚一段再滚回来（三角波往返）。
 *
 * 每个字符按“自己的横向位置 + 当前相位”取正弦值，在两种颜色之间插值，
 * 所以整行是一条会横移的渐变带；同一个周期里每个字符都会亮黄→暗紫→亮黄
 * 走一遍，这就是“呼吸”的观感。纯前景色，无背景色，宽度不变。
 *
 * 采样节拍不在这个文件：跟信息条/沙漏共用 core 的 ANIMATION_TICK_MS（见 core.ANIMATION_TICK_MS）。
 */
const BREATH_PERIOD_MS = 3400;
/** 亮黄（呼吸的一极）。 */
const BREATH_YELLOW: Rgb = [255, 214, 64];
/** 暗紫（另一极；不要太亮，否则与亮黄的对比不够活泼）。 */
const BREATH_PURPLE: Rgb = [96, 62, 156];
/** 整行跨度上的色带数：0.5 = 行首与行尾恰好是两极，看着最像“滚”。 */
const BREATH_TURNS = 0.5;

/** 三角波：0 → 1 → 0（左右往返）。 */
function breathRoll(elapsedMs: number): number {
	const phase = ((elapsedMs % BREATH_PERIOD_MS) + BREATH_PERIOD_MS) / BREATH_PERIOD_MS % 1;
	return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
}

/** 工作中文案：亮黄 ↔ 暗紫 左右滚动的呼吸换色（逐字符着色）。 */
export function workingMessage(elapsedMs: number, text = WORKING_TEXT): string {
	const chars = Array.from(text);
	const roll = breathRoll(elapsedMs);
	const span = Math.max(1, chars.length - 1);
	let out = BOLD_ON;
	for (let index = 0; index < chars.length; index++) {
		const phase = roll + (index / span) * BREATH_TURNS;
		const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
		out += `${sgr(mixRgb(BREATH_YELLOW, BREATH_PURPLE, wave))}${chars[index]}`;
	}
	return `${out}${BOLD_OFF}${RESET_FG}`;
}

/**
 * pi 的两个"元事件"指示器（分支摘要 / 上下文压缩）文案都是英文硬编码：
 *   - `BranchSummaryStatusIndicator`：`Summarizing branch... (esc to cancel)`
 *   - `CompactionStatusIndicator`：`Compacting context... (esc to cancel)`
 * 两个类都**没有从包里导出**，改不到实例。
 *
 * 所以补丁打在它们的基类 `Loader.prototype.updateDisplay` 上，只对
 * `kind` 命中的实例生效——文案换成我们「工作中」那套**呼吸文字**，spinner 换成
 * 月相、节拍换成 `WORKING_INTERVAL_MS`，与正常生成时完全一致。
 * 这两个指示器**不显示时钟/耗时**（压缩耗时另有摘要块在完成后展示）。
 * 其它 Loader（普通加载、重试倒计时等）原样不动。
 */
interface LoaderLike {
	kind?: string;
	message?: string;
	frames?: string[];
	intervalMs?: number;
	restartAnimation?(): void;
	updateDisplay(): void;
	__uiStyleStart?: number;
	__uiStylePatched?: boolean;
	[key: `ui-style:${string}`]: unknown;
}

/** 分支摘要时的文案。 */
export const BRANCH_SUMMARY_TEXT = "摘要生成中";
/** 上下文压缩时的文案。 */
export const COMPACTION_TEXT = "压缩上下文中";

/** 指示器标题色：与压缩/分支摘要块同一支紫色。 */
const STATUS_ACCENT: Rgb = [177, 142, 250];

/** kind → 文案（只处理这两种"元事件"指示器）。 */
const STATUS_TEXT_BY_KIND: Record<string, string> = {
	branchSummary: BRANCH_SUMMARY_TEXT,
	compaction: COMPACTION_TEXT,
};

/** 打补丁：分支摘要 + 上下文压缩的指示器文案/动画统一成「工作中」那套。 */
export function patchSummaryStatusIndicators(): void {
	const proto = Loader.prototype as unknown as LoaderLike;
	const originalUpdateDisplay = proto.updateDisplay;
	const patched = function (this: LoaderLike): void {
		const text = this.kind === undefined ? undefined : STATUS_TEXT_BY_KIND[this.kind];
		if (text !== undefined) {
			if (!this.__uiStylePatched) {
				this.__uiStylePatched = true;
				this.__uiStyleStart = Date.now();
				// 换成工作中的月相与节拍（构造函数里已 start 过一次，这里重启动画）。
				this.frames = [...WORKING_FRAMES];
				this.intervalMs = WORKING_INTERVAL_MS;
				this.restartAnimation?.();
			}
			const elapsed = Date.now() - (this.__uiStyleStart ?? Date.now());
			// 输入框里的指示**只保留月相 + 呼吸文案**（不带时钟/耗时）：这一行紧贴输入框，
			// 数字跳动会干扰打字；耗时由压缩块标题负责展示。
			this.message = workingMessage(elapsed, text);
		}
		originalUpdateDisplay.call(this);
	};
	patchPrototypeSlots(proto, "ui-style:loader-status", {
		updateDisplay: patched as unknown as () => void,
	});
}

/** 恢复 pi 原来的指示器文案。 */
export function unpatchSummaryStatusIndicators(): void {
	unpatchPrototypeSlots(
		Loader.prototype as unknown as LoaderLike,
		"ui-style:loader-status",
		["updateDisplay"],
	);
}

class RoundedEditor extends CustomEditor {
	/** 主题的普通边框色（borderMuted），固定不随思考等级变化。 */
	private readonly neutralBorder: (text: string) => string;
	/** bash 模式（! 开头）仍保留单独的颜色。 */
	private readonly paintBash: (text: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		paintBash: (text: string) => string,
	) {
		super(tui, theme, keybindings, { paddingX: PROMPT_WIDTH, embedWorkingStatus: true });
		this.neutralBorder = theme.borderColor;
		this.paintBash = paintBash;

		// 输入框边框固定为普通边框色；只有 bash 模式切成 bashMode。
		// pi 仍会按思考等级设置 borderColor，但这里的 setter 直接忽略。
		Object.defineProperty(this, "borderColor", {
			configurable: true,
			enumerable: true,
			get: () => (this.leadingChar() === "!" ? this.paintBash : this.neutralBorder),
			set: () => {},
		});

		// 命令菜单的选中箭头 → 用天青色；后面的命令名保持主题原来的强调色。
		// 打标记只包一次：同一个主题实例下反复 /new、/resume 会反复构造
		// RoundedEditor，不标记就会一层层累积闭包。
		const listTheme = theme.selectList as {
			selectedText: (text: string) => string;
			__piUiStylePatched?: boolean;
		};
		if (!listTheme.__piUiStylePatched) {
			const selectedText = listTheme.selectedText;
			listTheme.selectedText = (text: string): string =>
				text.startsWith("→ ")
					? `${SKY_BLUE}→ ${RESET_FG}` + selectedText(text.slice(2))
					: selectedText(text);
			listTheme.__piUiStylePatched = true;
		}
	}

	/** 防御性覆盖：pi-tui 当前直接读写 paddingX 字段、不经过这个方法；
	 * 若将来 pi 改为调用 setPaddingX(settings.editorPaddingX)，这里保证内边距不被改掉。 */
	override setPaddingX(_padding: number): void {
		super.setPaddingX(PROMPT_WIDTH);
	}

	/**
	 * 第一个非空白字符（`/`/`!`/其他）。
	 *
	 * 逐行扫描、找到就返回（可能跨行——用户把 `/` 敲在第二行也算命令模式），
	 * 不做 `getText().trimStart()`：后者会把整段输入（包括粘贴进来的几十 KB）
	 * 先 join 再复制一遍，而 render 每帧会问一次、borderColor 和 prompt 又各问一次。
	 */
	private leadingChar(): string {
		const lines = (this as unknown as { state?: { lines?: string[] } }).state?.lines;
		if (Array.isArray(lines)) {
			for (const line of lines) {
				for (let i = 0; i < line.length; i++) {
					const ch = line[i] ?? "";
					if (ch !== " " && ch !== "\t" && ch !== "\r") return ch;
				}
			}
			return "";
		}
		// 内部结构变化时的兼容路径。
		return this.getText().trimStart().slice(0, 1);
	}

	private prompt(): string {
		const lead = this.leadingChar();
		// 以 / 开头调出命令时用苹果菜单符号；以 ! 开头运行 bash 时用命令行符号，并跟边框同色
		if (lead === "/") return `${SKY_BLUE}⌘${RESET_FG}`;
		if (lead === "!") return this.paintBash("»");
		return `${CORAL}❯${RESET_FG}`;
	}

	private firstContentLine(line: string): string {
		const padding = " ".repeat(PROMPT_WIDTH);
		if (!line.startsWith(padding)) return line;
		return this.prompt() + " " + line.slice(PROMPT_WIDTH);
	}

	override render(width: number): string[] {
		if (width < 8) return super.render(width);

		const inner = super.render(width - BORDER_INSET * 2);
		const autoHeight =
			(this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight ?? 0;
		// [0] 上边框，[1..bottomIndex-1] 内容，[bottomIndex] 下边框，其后是自动补全列表
		const bottomIndex = Math.max(1, inner.length - 1 - autoHeight);
		const border = this.borderColor;
		const side = border("│");

		const lines: string[] = [];
		for (let i = 0; i < inner.length; i++) {
			const line = inner[i] ?? "";
			if (i === 0) {
				lines.push(border("╭") + line + border("╮"));
			} else if (i === bottomIndex) {
				lines.push(border("╰") + line + border("╯"));
			} else if (i < bottomIndex) {
				lines.push(side + (i === 1 ? this.firstContentLine(line) : line) + side);
			} else {
				// 自动补全列表保持在输入框下方；补 1 列缩进，与框内内容对齐
				lines.push(" ".repeat(BORDER_INSET) + line);
			}
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// render 给每行加了左右边框（内容整体右移 1 列），并且是用 width-2 调 super.render：
		// 传给 Editor 的坐标必须同步回“无边框”的空间，否则点正文会偏右一列、
		// 自动补全列表里的点击也会偏移，窄屏下 padding 上限还会算错。
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - BORDER_INSET),
			width: Math.max(1, event.width - BORDER_INSET * 2),
		});
	}
}

export function setupRoundedEditor(pi: ExtensionAPI): void {
	// 工厂期就打上：/tree 的摘要指示器随时可能出现。
	patchSummaryStatusIndicators();
	/** 统一动画节拍的退订函数（见 core.subscribeAnimationTick）。 */
	let unsubscribeBreath: (() => void) | undefined;
	let breathingStartedAt = 0;

	const stopBreathing = (): void => {
		unsubscribeBreath?.();
		unsubscribeBreath = undefined;
	};

	const startBreathing = (ctx: ExtensionContext): void => {
		stopBreathing();
		breathingStartedAt = Date.now();
		// 不自己开定时器：跟信息条、沙漏共用 core 里的统一节拍（见 core.ANIMATION_TICK_MS），
		// 这样任务期间的整屏重渲染次数不再叠加。
		const paint = (now: number): void => {
			ctx.ui.setWorkingMessage(workingMessage(now - breathingStartedAt));
		};
		paint(Date.now());
		unsubscribeBreath = subscribeAnimationTick("working-message", paint);
	};

	const applyWorkingStyle = (ctx: ExtensionContext): void => {
		ctx.ui.setWorkingIndicator({ frames: WORKING_FRAMES, intervalMs: WORKING_INTERVAL_MS });
		ctx.ui.setWorkingMessage(workingMessage(0));
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// shutdown 时会恢复原型，所以每个新会话都要重打（幂等）。
		patchSummaryStatusIndicators();
		stopBreathing();
		applyWorkingStyle(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new RoundedEditor(
				tui,
				theme,
				keybindings,
				(text) => ctx.ui.theme.fg("bashMode", text),
			),
		);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		startBreathing(ctx);
	});

	pi.on("agent_settled", () => {
		stopBreathing();
	});

	pi.on("session_shutdown", () => {
		stopBreathing();
		// 恢复 pi 自己的文案（/reload 时旧闭包不能留在 Loader 原型上）。
		unpatchSummaryStatusIndicators();
	});
}
