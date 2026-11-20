/**
 * 主题层：功能开关、配色 / 图标 / 对齐常量、标题扫光。
 *
 * 从 `core.ts` 拆出来的第一层（无本地依赖，其它层都只从它取"视觉原料"）。
 * `core.ts` 仍原样 re-export，外部 import 不用改。
 */

// ---- 一、功能开关 ------------------------------------------------------------

/** 想临时停用某个功能块，把对应项改成 false（或注释掉）即可。 */
export const FEATURES = {
	/** 助手消息样式（\uE22C 缩进 / 去背景 / 思考块折叠预览）。 */
	assistantStyle: true,
	/** 用户消息样式（黄色加粗 + \uE370 图标 + 左移一列）。 */
	userMessage: true,
	/** 助手消息的三级及更深标题改写成 ▸ 前缀，绕开 pi 原样保留 "###" 的规则。 */
	headingRewrite: true,
	/** 圆角输入框与输入符号。 */
	roundedEditor: true,
	/** 输入框上方信息条。 */
	infoBar: true,
	/** 输入框下方状态栏。 */
	statusline: true,
	/** 启动页资源清单。 */
	startupHeader: true,
	/** 技能调用横幅样式。 */
	skillBanner: true,
	/** `!` 内联命令的绿色圆角边框。 */
	bashExecBox: true,
	/** bash/codemode/read/write/edit/grep/find/ls/powershell 工具面板。 */
	toolPanels: true,
	/** subagent 工具面板（单个/并行/链式统一视觉）。 */
	subagentPanel: true,
	/** 压缩摘要 / 分支摘要块（统一视觉 + 压缩中指示）。 */
	summaryBlocks: true,
	/** 整轮结束后把视口带回回复开头（长回复 + 原来在跟随时）。 */
	jumpToReplyStart: true,
	/** 运行中块的标题扫光（图标 + 工具名 / 思考中 / `!` 短命令）。 */
	shimmerTitle: true,
	/** 会话信息面板（`alt+i` / `/info`）：模型/token/费用/上下文/用时/目录。 */
	sessionInfoPanel: true,
} as const;

// ---- 二、共享常量（对齐系统 / 配色 / 图标 / 预览宽度） ----------------------

export type Rgb = readonly [number, number, number];

/** 24-bit 前景色转义前缀。 */
export const sgr = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
/** 用 24-bit 前景色渲染一段文字。 */
export const fg24 = (rgb: Rgb, text: string): string => `${sgr(rgb)}${text}\x1b[39m`;

// ---- 标题扫光（运行中的块） ------------------------------------------------
//
// 不新开定时器：相位是「时间戳 + 字符位置」的纯函数，在每次 render 时现算，
// 靠 pi 本来就有的帧（working spinner 80ms / 信息条 tick 200ms / `!` 的 loader
// 与输出推送）带动。这和耗时数字的跳动方式完全一致（见文件头的 BlockClock 说明）。

/**
 * 扫光往返周期（毫秒）：左 → 右 → 左。
 *
 * 调慢过一次（1400 → 2800）：1.4s 一个来回在 10fps 的帧下像"闪"，慢下来才读得出
 * "光带在移动"。这是全局旋钮，标题 / 工具面板 / `!` 命令 / 思考块共用。
 */
export const SHIMMER_PERIOD_MS = 2800;
/** 高亮带宽度（字符数）：越大越柔和。 */
const SHIMMER_BAND = 2.5;
/** 高亮处向白色混合的最大比例（只提亮，不换色相）。 */
const SHIMMER_MIX = 0.78;
/** 高亮色：纯白。 */
const SHIMMER_HIGHLIGHT: Rgb = [255, 255, 255];
/**
 * 缓存键用的相位粒度（毫秒）。比 pi 的 80ms 帧细，动画不会因缓存漏帧，
 * 同时避免每帧都重算同一个键。
 */
const SHIMMER_FRAME_MS = 40;

/** 两个颜色按 t（0~1）线性混合。 */
export function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return [
		Math.round(from[0] + (to[0] - from[0]) * clamped),
		Math.round(from[1] + (to[1] - from[1]) * clamped),
		Math.round(from[2] + (to[2] - from[2]) * clamped),
	];
}

/** 相位（0~1）：三角波，0 = 高亮带在最左，1 = 在最右。 */
export function shimmerPosition(startedAt: number, now = Date.now()): number {
	const phase = ((now - startedAt) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
	// JS 的 % 对负数返回负数，先归一化回 [0,1)
	const wrapped = phase < 0 ? phase + 1 : phase;
	return wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;
}

/** 扫光缓存键（帧序号）：相位变了标题就得重画，否则动画会停在缓存里。 */
export function shimmerFrame(startedAt: number | undefined, now = Date.now()): number {
	if (startedAt === undefined) return 0;
	return Math.floor((now - startedAt) / SHIMMER_FRAME_MS);
}

/**
 * 扫光用的 SGR 缓存：`base 色 + 量化后的混合比例 → 转义串`。
 *
 * 每帧每个字符都要一条 SGR；比例是连续值，但肉眼分辨不到 1/64 的差别，所以量化到
 * 64 档做缓存。缓存上限很小（base 只有几种颜色 × 64 档），可以放心常驻进程。
 */
const SHIMMER_SGR_STEPS = 64;
const shimmerSgrCache = new Map<string, string>();

function shimmerSgr(base: Rgb, t: number): string {
	const step = Math.round(Math.max(0, Math.min(1, t)) * SHIMMER_SGR_STEPS);
	const key = `${base[0]},${base[1]},${base[2]}|${step}`;
	const cached = shimmerSgrCache.get(key);
	if (cached !== undefined) return cached;
	const mixed = mixRgb(base, SHIMMER_HIGHLIGHT, step / SHIMMER_SGR_STEPS);
	const value = sgr(mixed);
	if (shimmerSgrCache.size < 512) shimmerSgrCache.set(key, value);
	return value;
}

/**
 * 文本扫光：每个字符按到高亮带中心的距离从 base 混向白色，带中心左右往返。
 *
 * SGR 是零宽转义，因此 visibleWidth 与原文本一致，后面的 truncateToWidth 不受影响；
 * `startedAt` 缺失（历史块 / 已结束）时退化成单色，不闪烁。
 */
export function shimmerText(
	text: string,
	base: Rgb,
	startedAt: number | undefined,
	now = Date.now(),
): string {
	if (!FEATURES.shimmerTitle || startedAt === undefined || text.length === 0) {
		return `${sgr(base)}${text}${RESET_FG}`;
	}

	const chars = Array.from(text);
	const center = shimmerPosition(startedAt, now) * Math.max(0, chars.length - 1);
	let out = "";
	for (let index = 0; index < chars.length; index++) {
		const distance = Math.abs(index - center);
		// 平滑衰减的高亮带：带中心最亮，带外回到原色。
		const weight = distance >= SHIMMER_BAND ? 0 : (1 - distance / SHIMMER_BAND) ** 2;
		out += `${shimmerSgr(base, weight * SHIMMER_MIX)}${chars[index]}`;
	}
	return `${out}${RESET_FG}`;
}


// ---- 对齐系统（全文件唯一出处） -------------------------------------------
//
// 屏幕上只有两套左边缘，其余缩进/内边距全部由下面两个数字派生，改一处即全局一致：
//
//   消息族（用户消息 / 助手正文）：图标占第 0 列 + 1 个空格，正文悬挂缩进到
//     第 MESSAGE_ICON_WIDTH 列；
//   块族（思考块 / 工具面板 / 技能横幅 / `!` 命令框 / 信息条 / 状态栏 / 输入符号）：
//     统一从第 BLOCK_INDENT_WIDTH 列开始，正好落在消息族图标右侧一列。
//
// 两族唯一的纽带就是「块族首列 = 消息族图标右侧」这句话；下面的 GUTTER /
// UI_INDENT / CHROME_PAD / USER_PAD_SHIFT / PROMPT_WIDTH 都是派生值，不要单独改。

/** 消息族：图标 + 其后 1 个空格的宽度（用户 \uE370 与助手 \uE22C 共用）。 */
export const MESSAGE_ICON_WIDTH = 2;
/** 块族：统一左缩进列数（= 消息族图标右侧一列）。 */
export const BLOCK_INDENT_WIDTH = 1;

/** pi 的 Markdown / Text 默认左内边距（outputPad）：用户消息靠减掉它左移。 */
export const PI_OUTPUT_PAD = 1;

/** 助手正文 / 用户消息正文的悬挂缩进 = 图标 + 空格。 */
export const GUTTER = MESSAGE_ICON_WIDTH;
/** 块族缩进字符串。 */
export const UI_INDENT_WIDTH = BLOCK_INDENT_WIDTH;
export const UI_INDENT = " ".repeat(BLOCK_INDENT_WIDTH);

/** 信息条 / 状态栏缩进：与输入框内的输入符号同列，即块族首列。 */
export const CHROME_LEFT_PAD = BLOCK_INDENT_WIDTH;
export const CHROME_PAD = " ".repeat(BLOCK_INDENT_WIDTH);

export const BOLD_ON = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";
export const RESET_FG = "\x1b[39m";

/** 工具面板与各处状态色（24-bit）。 */
export const ACCENT_BLUE: Rgb = [95, 135, 215]; // bash / powershell / 技能横幅
export const ACCENT_CYAN: Rgb = [95, 215, 215]; // read
export const ACCENT_GREEN: Rgb = [95, 191, 127]; // write / ls / `!` 命令框
export const ACCENT_VIOLET: Rgb = [177, 142, 250]; // edit / grep / find
/** 状态档位色（ctx 色条 / diff / 错误 / 警告）。 */
export const OK_GREEN: Rgb = [63, 185, 80];
export const WARN_YELLOW: Rgb = [227, 179, 65];
export const BAD_RED: Rgb = [248, 81, 73];
/** 预览内容 / 分隔符的暗灰。 */
export const MUTED = "\x1b[38;2;128;128;128m";
/** 更暗一档的灰：未占用格子 / `!!` 边框。 */
export const DIM_GRAY = "\x1b[38;2;110;110;110m";
/** 天青（速度图标低档色 / 编辑器命令符号）；Rgb 原值单独导出，动画需要它。 */
export const SKY_BLUE_RGB: Rgb = [125, 211, 252];
export const SKY_BLUE = sgr(SKY_BLUE_RGB);
/** 思考块的淡黄色（扫光要 Rgb 原值，SGR 交给 sgr() 生成，别写成两份常量）。 */
export const THINKING_YELLOW_RGB: Rgb = [240, 216, 130];
export const THINKING_YELLOW = sgr(THINKING_YELLOW_RGB);
/** pi logo 的珊瑚色（输入符号 ❯）。 */
export const CORAL = "\x1b[38;2;228;138;122m";

/** 组装「信息条 / 状态栏」那种整行：统一缩进 + 整行加粗（两处共用）。 */
export function chromeLine(content: string): string {
	return `${CHROME_PAD}${BOLD_ON}${content}${BOLD_OFF}`;
}

// ---- 原型补丁助手（assistant / skill-banner / bash-exec / user-message 共用） ----
//
// 四份「保存原方法 → 打补丁 → 所有权校验恢复」的骨架原本各抄一遍，哨兵语义
// 还各不相同（有的 unpatch 失权路径忘清标志）。统一到这里：
//   - patchPrototypeSlots 幂等（已持有全部槽位时直接返回，重复 patch 是 no-op）；
//   - unpatchPrototypeSlots 只恢复"当前槽位上仍是我们的函数"的那些，且任何
//     return 路径都会把 originals/patched 标志清干净，/reload 不会残留旧闭包。

type ProtoRecord = Record<PropertyKey, unknown>;

const slotKey = (prefix: string, name: string): string => `${prefix}:${name}`;
const originalKey = (prefix: string, name: string): string => `${prefix}:original:${name}`;
const patchedKey = (prefix: string, name: string): string => `${prefix}:patched:${name}`;

export function patchPrototypeSlots<P extends ProtoRecord>(
	proto: P,
	prefix: string,
	impls: Partial<Record<keyof P, (...args: never[]) => unknown>>,
): void {
	const record = proto as Record<string, unknown>;
	const allOwned = Object.keys(impls).every(
		(name) => record[slotKey(prefix, name)] === true &&
			record[name] === record[patchedKey(prefix, name)],
	);
	if (allOwned) return;
	// 先完全恢复（不重打的话新旧闭包会混在同一原型上，互相吃掉对方的状态）
	unpatchPrototypeSlots(proto, prefix, Object.keys(impls));
	for (const [name, impl] of Object.entries(impls)) {
		record[originalKey(prefix, name)] = proto[name as keyof P];
		record[name] = impl;
		record[patchedKey(prefix, name)] = impl;
		record[slotKey(prefix, name)] = true;
	}
}

/** 恢复槽位（只动仍归我们所有的）；返回是否收回过至少一个槽位。 */
export function unpatchPrototypeSlots<P extends ProtoRecord>(
	proto: P,
	prefix: string,
	names: readonly (keyof P & string)[],
): boolean {
	const record = proto as Record<string, unknown>;
	let restored = false;
	for (const name of names) {
		const patched = record[patchedKey(prefix, name)];
		const owns = patched !== undefined && record[name] === patched;
		if (owns) {
			const original = record[originalKey(prefix, name)];
			if (original === undefined) delete record[name];
			else record[name] = original;
			restored = true;
		}
		delete record[originalKey(prefix, name)];
		delete record[patchedKey(prefix, name)];
		delete record[slotKey(prefix, name)];
	}
	return restored;
}

/** Nerd Font 图标（宽度均为 1 列；图标 + 空格 = 2 列，与缩进计算配套）。 */
export const ICON_BASH = "\uF489";
export const ICON_READ = "\uDB80\uDE1E"; // Plane 15，代理对
export const ICON_WRITE = "\uEE3C";
export const ICON_EDIT = "\uDB83\uDDC9"; // Plane 15，代理对
export const ICON_SEARCH = "\uEBC4"; // grep/find/powershell/ls/`!` 命令
export const ICON_CLOCK = "\uE382"; // 各面板与思考块的耗时
export const ICON_THINKING = "\uEC59"; // 思考块
export const ICON_SKILL = "\uE947"; // 技能横幅

/** 工具面板折叠预览行数。 */
export const PANEL_PREVIEW_LINES = 2;
/** `!` 命令框折叠预览行数（与 pi 原行为一致）。 */
export const EXEC_PREVIEW_LINES = 20;
/** 技能横幅折叠预览行数。 */
export const SKILL_PREVIEW_LINES = 4;
/**
 * 折叠预览的 ⎿ 连接符（工具面板 / 思考块 / 技能横幅共用；ls 框无连接符）：
 * 块缩进之后空 2 列接 ⎿，⎿ 之后再空 2 列接正文，因此正文可用宽度 =
 * 区域宽度 - PREVIEW_CONNECTOR_WIDTH。
 */
export const PREVIEW_CONNECTOR_LEAD = "  ";
export const PREVIEW_CONNECTOR_GAP = "  ";
/** 连接符占用的总列数（前导空格 + ⎿ + 后置空格）。 */
export const PREVIEW_CONNECTOR_WIDTH = PREVIEW_CONNECTOR_LEAD.length + 1 + PREVIEW_CONNECTOR_GAP.length;
export const PREVIEW_CONNECTOR_FIRST = `${PREVIEW_CONNECTOR_LEAD}⎿${PREVIEW_CONNECTOR_GAP}`;
export const PREVIEW_CONNECTOR_REST = " ".repeat(PREVIEW_CONNECTOR_WIDTH);


export interface ThemeLike {
	fg(token: string, text: string): string;
}
