/**
 * 十二、启动页（logo + 上下文 / 技能 / 扩展资源清单）
 *
 * 这里只做「发现 + 展示」。所有文件系统访问都是**异步**的：启动页在
 * session_start 里就要挂上，同步递归扫描（skills 深度 8 + cwd 各级父目录）
 * 会让第一帧卡住几百毫秒，所以先渲染「扫描中」骨架，扫描完成后再填数据。
 *
 * 除启动页外，会话信息面板（info-panel.ts）的「加载」区也从这里取数据：
 * `collectSessionResources()` 复用同一份按 cwd 的扫描缓存，另外现读
 * 用户级/项目级 mcp.json 得到 MCP 名单。
 */

import { readFile as readFileAsync, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import {
	BOLD_OFF,
	BOLD_ON,
	CachedView,
	HOME,
	RESET_FG,
	shortenHome,
	shortenTail,
	type ThemeLike,
} from "./core.ts";

// ---- 常量与数据结构 --------------------------------------------------------

/** 与图片一致的暖金色（pi 主题里的 YELLOW2），用于边框、标题与版本号。 */
const GOLD = "\x1b[38;2;234;182;93m";
/** pi 默认 logo 的颜色（与内置 pi-logo 完全一致）。 */
const LOGO_CORAL = "\x1b[38;2;228;138;122m";
const LOGO_BLUE = "\x1b[38;2;79;142;179m";
const LOGO_BLUE_BG = "\x1b[48;2;79;142;179m";
const LOGO_YELLOW = "\x1b[38;2;234;182;93m";
const RESET = "\x1b[0m";

/** 默认的两行 logo：第一行珊瑚色 + 蓝色背景，第二行蓝/黄。 */
const LOGO_TOP = `${LOGO_CORAL}${LOGO_BLUE_BG}▀${RESET}${LOGO_CORAL}▀█${RESET} `;
const LOGO_BOTTOM = `${LOGO_BLUE}█▀${RESET} ${LOGO_YELLOW}█${RESET}`;
const LOGO_GAP = "  ";

/** 第一行快捷键提示与第二行说明文字。 */
const HINT_TEXT =
	"按Esc中断任务 · ctrl + c 退出程序 · / 调出命令菜单 · !bash 执行bash指令";
const TIP_TEXT =
	"Pi可以阅读使用手册和说明可以直接进行提问，例如：我能修改你哪些设置？";

/** 三个分区图标（Nerd Font）。 */
const ICON_CONTEXT = "󰆼";
const ICON_SKILLS = "󰒓";
const ICON_EXTENSIONS = "󰐱";

/** 太窄时退化成无边框布局，避免把内容挤出屏幕。 */
const MIN_BOX_WIDTH = 24;
/** 列表项的前缀宽度（"  ╰─ "）。 */
const ITEM_PREFIX_WIDTH = 5;

/** 上下文文件名，优先级从高到低（同一目录里 override 优先）。 */
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** 扩展文件名后缀。 */
const EXTENSION_FILE_RE = /\.(?:ts|js|mjs|cjs|mts|cts)$/i;
/** 扩展目录的入口文件（与 pi 的发现规则一致）。 */
const EXTENSION_ENTRY_FILES = ["index.ts", "index.js", "index.mjs", "index.cjs", "package.json"];
/** 递归查找 SKILL.md 的最大深度：防止异常庞大的目录树拖慢启动。 */
const MAX_SKILL_SCAN_DEPTH = 8;

interface SkillEntry {
	name: string;
	file: string;
	enabled: boolean;
}

interface ExtensionEntry {
	name: string;
	file: string;
	enabled: boolean;
}

interface StartupData {
	context: string[];
	skills: SkillEntry[];
	extensions: ExtensionEntry[];
}

interface ResourceSettings {
	skills: string[];
	extensions: string[];
}

interface SettingsPair {
	user: ResourceSettings;
	project: ResourceSettings;
}

// ---- 异步文件系统小工具 ----------------------------------------------------

/** 路径类型；不存在或不可访问时为 undefined。 */
type PathKind = "file" | "dir";

/** 全局 fs 并发闸门：递归扫描每层都开 8 个 worker，必须再有一道总量上限。 */
const MAX_CONCURRENT_FS = 32;
let activeFs = 0;
const fsWaiters: Array<() => void> = [];
async function withFsSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (activeFs >= MAX_CONCURRENT_FS) await new Promise<void>((resolve) => fsWaiters.push(resolve));
	activeFs += 1;
	try {
		return await fn();
	} finally {
		activeFs -= 1;
		fsWaiters.shift()?.();
	}
}

async function statKindAsync(path: string): Promise<PathKind | undefined> {
	try {
		const stats = await withFsSlot(() => stat(path));
		if (stats.isFile()) return "file";
		if (stats.isDirectory()) return "dir";
	} catch {
		// 不存在 / 权限不足 / 悬空符号链接
	}
	return undefined;
}

/**
 * 目录项的类型。符号链接要跟随一次 stat（Dirent 看不穿链接），
 * 其余情况零成本。
 */
async function entryKind(entry: Dirent, full: string): Promise<PathKind | undefined> {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "dir";
	if (!entry.isSymbolicLink()) return undefined;
	return statKindAsync(full);
}

/** 读目录（跳过隐藏项与 node_modules，与 pi 的发现规则一致）；读不到返回 []。 */
async function readEntries(dir: string): Promise<Dirent[]> {
	try {
		const entries = await withFsSlot(() => readdir(dir, { withFileTypes: true }));
		return entries.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules");
	} catch {
		return [];
	}
}

/** 有并发上限的 map：避免大目录树 / 多 root 时瞬间发出上千个 stat。 */
async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

/** 读文本文件（顺带去掉 BOM）；读不到返回 undefined。 */
async function readTextFile(path: string): Promise<string | undefined> {
	try {
		const text = await readFileAsync(path, "utf8");
		return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	} catch {
		return undefined;
	}
}

/** pi 的用户级配置目录：优先 PI_CODING_AGENT_DIR。 */
function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!fromEnv) return join(HOME, ".pi", "agent");
	// `~` 不是 join 能展开的；否则 PI_CODING_AGENT_DIR=~/x 会去找字面量 "~/x"。
	if (fromEnv === "~") return HOME;
	if (fromEnv.startsWith("~/") || fromEnv.startsWith("~\\")) {
		return join(HOME, fromEnv.slice(2));
	}
	return fromEnv;
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

/** 路径大小写是否不敏感（Windows / macOS 默认卷）；Linux 上区分大小写。 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/** 去重用的键：大小写不敏感的平台统一小写化，避免把两个不同路径并成一个。 */
function pathKey(path: string): string {
	const resolved = resolve(path);
	return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const key = pathKey(path);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(path);
	}
	return result;
}

// ---- settings.json 里的资源条目 --------------------------------------------

/**
 * 读取一个 settings.json 里的 skills / extensions 两个数组。
 * 一个文件只读 + JSON.parse 一次。
 */
async function readResourceFile(file: string): Promise<ResourceSettings> {
	const empty: ResourceSettings = { skills: [], extensions: [] };
	const raw = await readTextFile(file);
	if (raw === undefined) return empty;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const strings = (value: unknown): string[] =>
			Array.isArray(value)
				? value.filter((item): item is string => typeof item === "string")
				: [];
		return { skills: strings(parsed.skills), extensions: strings(parsed.extensions) };
	} catch {
		return empty;
	}
}

/** 读取用户级 + 项目级 settings.json 里的资源条目（并行）。 */
async function readResourceSettings(cwd: string): Promise<SettingsPair> {
	const [user, project] = await Promise.all([
		readResourceFile(join(agentDir(), "settings.json")),
		readResourceFile(join(cwd, ".pi", "settings.json")),
	]);
	return { user, project };
}

/** 通配符正则缓存：同一 pattern 会被多个资源反复测试，避免重复编译。 */
const wildcardCache = new Map<string, RegExp>();

/** 把 `*` / `**` / `?` 通配符转成正则，大小写不敏感（Windows 友好）。 */
function wildcardRegExp(pattern: string): RegExp {
	const cached = wildcardCache.get(pattern);
	if (cached) return cached;

	const escaped = normalizeSlashes(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const body = escaped
		.replace(/\*\*+/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	const regex = new RegExp(`^${body}$`, "i");
	if (wildcardCache.size >= 128) wildcardCache.clear();
	wildcardCache.set(pattern, regex);
	return regex;
}

/** 参与通配符匹配的候选串（每个资源算一次，而不是每条 pattern 算一次）。 */
function patternCandidates(
	file: string,
	baseDir: string,
	name: string,
	extraNames: string[],
): string[] {
	return [
		normalizeSlashes(relative(baseDir, file)),
		name,
		...extraNames,
		normalizeSlashes(file),
		basename(file),
	].filter((candidate) => candidate.length > 0);
}

/** 候选串里是否有命中。候选里已包含 basename(file)，不必再对每个候选取 basename。 */
function matchesAny(regex: RegExp, candidates: readonly string[]): boolean {
	for (const candidate of candidates) {
		if (regex.test(candidate)) return true;
	}
	return false;
}

/**
 * 按 pi 的覆盖规则判断资源是否启用：
 * `!pattern` 排除 → `+pattern` 强制包含 → `-pattern` 强制排除。
 *
 * 三段规则有先后顺序，不能合成一趟；但候选串只准备一次（旧实现每条
 * pattern、每一趟都要重算 5 个候选串）。
 */
export function isEnabledByPatterns(
	patterns: string[],
	file: string,
	baseDir: string,
	name: string,
	extraNames: string[],
): boolean {
	if (patterns.length === 0) return true;
	const candidates = patternCandidates(file, baseDir, name, extraNames);
	// `!pattern` 走 glob；`+path` / `-path` 是**精确路径**（pi 用 matchesAnyExactPattern）。
	const matchedGlob = (pattern: string): boolean =>
		matchesAny(wildcardRegExp(pattern.slice(1)), candidates);
	// 与 pi 的 matchesAnyExactPattern 同语义：把 pattern 归一化后**直接比对**
	// 相对路径 / basename / SKILL.md 的父目录相对路径，**不做 resolve**。
	// 以前用 `resolve(baseDir, candidate)` 比较，会把 basename 当成"baseDir 下的
	// 同名条目"，于是 `-commit` 会误伤任意目录里叫 commit 的 skill。
	const normalizedPatternCache = new Map<string, string>();
	const normalizedPattern = (raw: string): string => {
		const cached = normalizedPatternCache.get(raw);
		if (cached !== undefined) return cached;
		const value = normalizeSlashes(raw).replace(/^\.\//, "").replace(/\/+$/, "");
		normalizedPatternCache.set(raw, value);
		return value;
	};
	const matchedExact = (pattern: string): boolean => {
		const target = normalizedPattern(pattern.slice(1));
		const rel = normalizeSlashes(relative(baseDir, file));
		if (target === rel || target === normalizeSlashes(file)) return true;
		// SKILL.md 还允许用技能目录名匹配，且也接受绝对路径形式。
		if (basename(file) === "SKILL.md") {
			const parentRel = normalizeSlashes(relative(baseDir, dirname(file)));
			if (target === parentRel || target === normalizeSlashes(dirname(file))) return true;
		}
		// 故意**不**比对 basename / 技能名：pi 的精确模式只认路径（rel / 绝对 / 技能目录），
		// 用 basename 会把 `-commit` 误伤到任意目录下同名条目。
		return false;
	};

	let enabled = true;
	for (const pattern of patterns) {
		if (pattern.startsWith("!") && matchedGlob(pattern)) enabled = false;
	}
	for (const pattern of patterns) {
		if (pattern.startsWith("+") && matchedExact(pattern)) enabled = true;
	}
	for (const pattern of patterns) {
		if (pattern.startsWith("-") && matchedExact(pattern)) enabled = false;
	}
	return enabled;
}

/** 把 settings 里的资源条目解析成绝对路径（跳过通配符与排除项）。 */
function resolveConfiguredPaths(entries: string[], baseDir: string): string[] {
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.startsWith("!") || entry.startsWith("-")) continue;
		const raw = entry.startsWith("+") ? entry.slice(1) : entry;
		if (raw.includes("*") || raw.includes("?")) continue;
		// raw.slice(1) 对 `~/foo` 会留下前导 `/`（Node 碰巧能拼对），但对 Windows 风格
		// `~\foo` 会在 normalizeSlashes 之前残留反斜杠；先剥掉所有前导分隔符再 join。
		paths.push(
			raw.startsWith("~") ? join(HOME, raw.slice(1).replace(/^[\\/]+/, "")) : resolve(baseDir, raw),
		);
	}
	return paths;
}

// ---- 上下文文件 ------------------------------------------------------------

async function firstContextFile(dir: string): Promise<string | undefined> {
	for (const name of CONTEXT_NAMES) {
		const full = join(dir, name);
		if ((await statKindAsync(full)) === "file") return full;
	}
	return undefined;
}

/** 收集上下文文件：<agent-dir> 与工作目录各级父目录。 */
async function collectContextFiles(cwd: string): Promise<string[]> {
	const found: string[] = [];
	const addIfFile = async (file: string): Promise<void> => {
		if ((await statKindAsync(file)) === "file") found.push(file);
	};

	const agent = agentDir();
	// firstContextFile 已经 stat 过命中文件，直接复用，不要再全量 stat 一遍。
	const agentContext = await firstContextFile(agent);
	if (agentContext !== undefined) found.push(agentContext);
	await addIfFile(join(agent, "APPEND_SYSTEM.md"));

	let dir = resolve(cwd);
	while (true) {
		const contextFile = await firstContextFile(dir);
		if (contextFile !== undefined) found.push(contextFile);
		await addIfFile(join(dir, ".pi", "APPEND_SYSTEM.md"));

		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return uniquePaths(found);
}

/** 向上查找 git 仓库根目录，用于限制祖先目录扫描。 */
async function findGitRoot(start: string): Promise<string | undefined> {
	let dir = resolve(start);
	while (true) {
		if ((await statKindAsync(join(dir, ".git"))) !== undefined) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

// ---- 技能 ------------------------------------------------------------------

/**
 * 递归查找 SKILL.md（与 pi 一致）：一个目录里有 SKILL.md 就当成技能目录、
 * 不再往下钻；否则只往子目录里找（隐藏项与 node_modules 已被 readEntries 过滤）。
 */
async function collectSkillFilesIn(dir: string, out: string[], depth = 0): Promise<void> {
	if (depth >= MAX_SKILL_SCAN_DEPTH) return;
	if ((await statKindAsync(dir)) !== "dir") return;

	const entries = await readEntries(dir);
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		if ((await entryKind(entry, join(dir, "SKILL.md"))) === "file") {
			out.push(join(dir, "SKILL.md"));
			return;
		}
	}
	// 同层子目录并行递归（串行 await 在深层树上会成倍放大启动延迟）。
	// 但并发要有上限：符号链接或大目录树不能瞬间发出上千个 stat。
	await mapLimit(entries, 8, async (entry) => {
		const full = join(dir, entry.name);
		if ((await entryKind(entry, full)) === "dir") {
			await collectSkillFilesIn(full, out, depth + 1);
		}
	});
}

/** 收集所有技能的 SKILL.md。 */
async function collectSkillFiles(cwd: string, settings: SettingsPair): Promise<string[]> {
	const roots: string[] = [
		join(agentDir(), "skills"),
		join(HOME, ".agents", "skills"),
		join(cwd, ".pi", "skills"),
		join(cwd, ".agents", "skills"),
	];

	// 找到 git 根就以它为界（不扫仓库外的祖先）；找不到时一路扫到文件系统根——
	// 否则非 git 目录下第一轮就 break，祖先目录的 .agents/skills 完全漏掉。
	// 取舍：多扫几层目录换来不丢技能，目录层级本身很浅，开销可接受。
	const gitRoot = await findGitRoot(cwd);
	let dir = resolve(cwd);
	while (true) {
		roots.push(join(dir, ".agents", "skills"));
		if (gitRoot !== undefined && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	roots.push(...resolveConfiguredPaths(settings.user.skills, agentDir()));
	roots.push(...resolveConfiguredPaths(settings.project.skills, join(cwd, ".pi")));

	// 各 root 的 stat/递归互不依赖：并行跑（大 home / 多 root 时启动更快）。
	const perRoot = await Promise.all(
		uniquePaths(roots).map(async (root) => {
			const found: string[] = [];
			const kind = await statKindAsync(root);
			if (kind === "file") {
				if (basename(root) === "SKILL.md") found.push(root);
			} else if (kind === "dir") {
				await collectSkillFilesIn(root, found);
			}
			return found;
		}),
	);
	return uniquePaths(perRoot.flat());
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

/** 读取 SKILL.md frontmatter 里的 name 与 disable-model-invocation。 */
async function parseSkill(file: string): Promise<{ name: string; modelInvocation: boolean }> {
	const content = (await readTextFile(file)) ?? "";

	const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	const block = frontmatter?.[1] ?? "";
	const nameMatch = /^name\s*:\s*(.+?)\s*$/im.exec(block);
	const name = nameMatch ? unquote(nameMatch[1].trim()) : basename(dirname(file));
	const disabled =
		/^(?:disable-model-invocation|disableModelInvocation)\s*:\s*(?:true|yes|on)\s*$/im.test(
			block,
		);

	return { name, modelInvocation: !disabled };
}

async function collectSkills(cwd: string, settings: SettingsPair): Promise<SkillEntry[]> {
	const files = await collectSkillFiles(cwd, settings);
	const skills = await mapLimit(files, 8, async (file) => {
		const { name, modelInvocation } = await parseSkill(file);
		const skillDirName = basename(dirname(file));
		const userEnabled = isEnabledByPatterns(settings.user.skills, file, agentDir(), name, [
			skillDirName,
		]);
		const projectEnabled = isEnabledByPatterns(
			settings.project.skills,
			file,
			join(cwd, ".pi"),
			name,
			[skillDirName],
		);
		return { name, file, enabled: modelInvocation && userEnabled && projectEnabled };
	});
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- 扩展 ------------------------------------------------------------------

/**
 * 收集一个扩展目录里的扩展文件与扩展目录（与 pi 的发现规则一致，只看一层）。
 *
 * 不再回传"文件 / 目录"类型：显示名一律用 basename（见下方注释），
 * 那个 Map 就成了纯开销。
 */
async function collectExtensionFilesIn(dir: string, out: string[]): Promise<void> {
	if ((await statKindAsync(dir)) !== "dir") return;

	for (const entry of await readEntries(dir)) {
		const full = join(dir, entry.name);
		const kind = await entryKind(entry, full);

		if (kind === "dir") {
			// 串行检查入口文件：找到一个就足够判定是扩展目录，短路掉后面的 syscall。
			for (const entryFile of EXTENSION_ENTRY_FILES) {
				if ((await statKindAsync(join(full, entryFile))) === "file") {
					out.push(full);
					break;
				}
			}
			continue;
		}

		if (
			kind === "file" &&
			EXTENSION_FILE_RE.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
}

async function collectExtensions(
	cwd: string,
	settings: SettingsPair,
): Promise<ExtensionEntry[]> {
	const roots: string[] = [join(agentDir(), "extensions"), join(cwd, ".pi", "extensions")];
	roots.push(...resolveConfiguredPaths(settings.user.extensions, agentDir()));
	roots.push(...resolveConfiguredPaths(settings.project.extensions, join(cwd, ".pi")));

	// 各 root 并行扫（root 之间没有共享状态，只有各自的局部数组），并发同样设上限。
	const files: string[] = [];
	const perRoot = await mapLimit(uniquePaths(roots), 8, async (root) => {
		const found: string[] = [];
		const kind = await statKindAsync(root);
		if (kind === "dir") {
			await collectExtensionFilesIn(root, found);
		} else if (kind === "file") {
			found.push(root);
		}
		return found;
	});
	for (const found of perRoot) files.push(...found);

	const unique = uniquePaths(files);

	return unique
		.map((file) => {
			// 扩展名一律用 basename：pi 自己也不区分"单文件 / 目录（index.ts）"两种布局，
			// 给目录加 `/` 只会让 `subagent/` 和 `ui-style.ts` 看起来像两类东西。
			const name = basename(file);
			const userEnabled = isEnabledByPatterns(
				settings.user.extensions,
				file,
				agentDir(),
				name,
				[basename(file)],
			);
			const projectEnabled = isEnabledByPatterns(
				settings.project.extensions,
				file,
				join(cwd, ".pi"),
				name,
				[basename(file)],
			);
			return { name, file, enabled: userEnabled && projectEnabled };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- MCP ------------------------------------------------------------------

/** mcp.json 里的服务器条目（这里只关心名字与启用状态）。 */
interface McpEntry {
	name: string;
	enabled: boolean;
}

/** 读一份 mcp.json 的 `mcpServers`（名字 → 启用状态）；读不到 / 坏 JSON → 空。 */
async function readMcpFile(file: string): Promise<Map<string, boolean>> {
	const servers = new Map<string, boolean>();
	const raw = await readTextFile(file);
	if (raw === undefined) return servers;
	try {
		const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
		const entries = parsed.mcpServers;
		if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return servers;
		for (const [name, entry] of Object.entries(entries)) {
			const enabled = !(
				entry !== null &&
				typeof entry === "object" &&
				(entry as { enabled?: unknown }).enabled === false
			);
			servers.set(name, enabled);
		}
	} catch {
		// 坏 JSON 就当没有这个文件
	}
	return servers;
}

/** 用户级 + 项目级 mcp.json（项目条目按名字覆盖用户级，与 pi 的规则一致）。 */
async function collectMcpServers(cwd: string): Promise<McpEntry[]> {
	const [user, project] = await Promise.all([
		readMcpFile(join(agentDir(), "mcp.json")),
		readMcpFile(join(cwd, ".pi", "mcp.json")),
	]);
	const merged = new Map(user);
	for (const [name, enabled] of project) merged.set(name, enabled);
	return [...merged]
		.map(([name, enabled]) => ({ name, enabled }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** 收集启动页要展示的全部信息（并行扫描三个来源）。 */
async function collectStartupData(cwd: string): Promise<StartupData> {
	const settings = await readResourceSettings(cwd);
	const [context, skills, extensions] = await Promise.all([
		collectContextFiles(cwd),
		collectSkills(cwd, settings),
		collectExtensions(cwd, settings),
	]);
	return { context, skills, extensions };
}

// ---- 渲染 ------------------------------------------------------------------

/** 给一整行补足到内宽，保证右边框对齐。 */
function boxLine(content: string, innerWidth: number): string {
	let text = content;
	if (visibleWidth(text) > innerWidth) {
		text = truncateToWidth(text, innerWidth, "…");
	}
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
	return `${GOLD}│${RESET_FG} ${text}${padding} ${GOLD}│${RESET_FG}`;
}

const gold = (text: string): string => `${GOLD}${text}${RESET_FG}`;
const goldBold = (text: string): string => `${GOLD}${BOLD_ON}${text}${BOLD_OFF}${RESET_FG}`;
const colored = (color: string, text: string): string => `${color}${text}${RESET_FG}`;
const coloredBold = (color: string, text: string): string =>
	`${color}${BOLD_ON}${text}${BOLD_OFF}${RESET_FG}`;

function sectionHeading(icon: string, title: string, color: string, innerWidth: number): string {
	return boxLine(`${colored(color, icon)} ${coloredBold(color, title)}`, innerWidth);
}

/**
 * 连续的圆角树状线：首行 ╭─、中间 ├─、末行 ╰─。
 * ╭ 向下连接，╰ 向上连接，因此行与行之间不会断开；每行都有横向分支。
 */
function treePrefix(color: string, index: number, total: number): string {
	const indent = "  ";
	if (total <= 1) return colored(color, `${indent}╰─ `);
	if (index === 0) return colored(color, `${indent}╭─ `);
	if (index === total - 1) return colored(color, `${indent}╰─ `);
	return colored(color, `${indent}├─ `);
}

/** 每个条目独占一行：首项 ╭─、中间 ├─、末项 ╰─，长路径从左侧截断保住文件名。 */
function renderStackedSection(
	icon: string,
	title: string,
	items: string[],
	color: string,
	innerWidth: number,
	format: (item: string, maxWidth: number) => string,
): string[] {
	const lines: string[] = [sectionHeading(icon, title, color, innerWidth)];
	const contentWidth = Math.max(1, innerWidth - ITEM_PREFIX_WIDTH);
	const continuation = colored(color, "  │  ");

	items.forEach((item, itemIndex) => {
		const text = format(item, contentWidth);
		for (const [segmentIndex, segment] of wrapTextWithAnsi(text, contentWidth).entries()) {
			const prefix =
				segmentIndex === 0 ? treePrefix(color, itemIndex, items.length) : continuation;
			lines.push(boxLine(`${prefix}${segment}`, innerWidth));
		}
	});

	return lines;
}

/** 条目在一行内用 ` · ` 连接：按“整个条目”换行，不把文件名或状态切成两半。 */
function renderInlineSection(
	icon: string,
	title: string,
	items: string[],
	color: string,
	innerWidth: number,
): string[] {
	const lines: string[] = [sectionHeading(icon, title, color, innerWidth)];
	const separator = colored(color, " · ");
	const contentWidth = Math.max(1, innerWidth - ITEM_PREFIX_WIDTH);
	const separatorWidth = visibleWidth(separator);

	const rows: string[] = [];
	let current = "";
	let currentWidth = 0;

	const flush = (): void => {
		if (!current) return;
		rows.push(current);
		current = "";
		currentWidth = 0;
	};

	for (const item of items) {
		let text = item;
		if (visibleWidth(text) > contentWidth) {
			text = truncateToWidth(text, contentWidth, "…");
		}
		const width = visibleWidth(text);

		if (current && currentWidth + separatorWidth + width > contentWidth) {
			flush();
		}
		if (current) {
			current += separator + text;
			currentWidth += separatorWidth + width;
		} else {
			current = text;
			currentWidth = width;
		}
	}
	flush();

	rows.forEach((row, index) => {
		lines.push(boxLine(`${treePrefix(color, index, rows.length)}${row}`, innerWidth));
	});

	return lines;
}

/**
 * 启动页条目着色：启用条目用分区主色，未启用条目用 dim。
 * `keepColorWhenDisabled` 给技能用——技能名始终是主色，只有「(未启用)」后缀变暗。
 */
function formatEntries(
	entries: ReadonlyArray<{ label: string; suffix?: string; enabled: boolean }>,
	theme: ThemeLike,
	color: string,
	options: { keepColorWhenDisabled?: boolean } = {},
): string[] {
	const keepColor = options.keepColorWhenDisabled === true;
	return entries.map((entry) => {
		const dim = !entry.enabled && !keepColor;
		const label = dim ? theme.fg("dim", entry.label) : colored(color, entry.label);
		if (entry.suffix === undefined) return label;
		const suffix = entry.enabled ? colored(color, entry.suffix) : theme.fg("dim", entry.suffix);
		return `${label}${suffix}`;
	});
}

function renderBox(data: StartupData, width: number, theme: ThemeLike): string[] {
	const innerWidth = width - 4;
	const lines: string[] = [gold(`╭${"─".repeat(Math.max(0, width - 2))}╮`)];

	const blocks: string[][] = [];

	if (data.context.length > 0) {
		blocks.push(
			renderStackedSection(
				ICON_CONTEXT,
				"上下文",
				data.context.map((file) => shortenHome(file)),
				LOGO_CORAL,
				innerWidth,
				(item, maxWidth) => colored(LOGO_CORAL, shortenTail(item, maxWidth)),
			),
		);
	}

	if (data.skills.length > 0) {
		blocks.push(
			renderInlineSection(
				ICON_SKILLS,
				"技能",
				formatEntries(
					data.skills.map((skill) => ({
						label: skill.name,
						suffix: skill.enabled ? "(已启用)" : "(未启用)",
						enabled: skill.enabled,
					})),
					theme,
					LOGO_BLUE,
					{ keepColorWhenDisabled: true },
				),
				LOGO_BLUE,
				innerWidth,
			),
		);
	}

	if (data.extensions.length > 0) {
		blocks.push(
			renderInlineSection(
				ICON_EXTENSIONS,
				"拓展",
				formatEntries(
					data.extensions.map((extension) => ({
						label: extension.name,
						enabled: extension.enabled,
					})),
					theme,
					LOGO_YELLOW,
				),
				LOGO_YELLOW,
				innerWidth,
			),
		);
	}

	if (blocks.length === 0) {
		blocks.push([boxLine(theme.fg("muted", "（未发现已加载的资源）"), innerWidth)]);
	}

	blocks.forEach((block, index) => {
		if (index > 0) lines.push(boxLine("", innerWidth));
		lines.push(...block);
	});

	lines.push(gold(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
	return lines;
}

/** 扫描期间占位：先把 logo 与提示上屏，资源清单等扫完再填。 */
function renderScanningBox(width: number, theme: ThemeLike): string[] {
	const innerWidth = width - 4;
	return [
		gold(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
		boxLine(theme.fg("muted", "正在扫描上下文 / 技能 / 扩展…"), innerWidth),
		gold(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
	];
}

function renderStartup(data: StartupData | undefined, width: number, theme: ThemeLike): string[] {
	if (width < MIN_BOX_WIDTH) {
		return [
			`${LOGO_BOTTOM} ${gold(`v${VERSION}`)}`,
			theme.fg("muted", truncateToWidth("窗口太窄，已隐藏资源清单", width, "…")),
		];
	}

	const textWidth = Math.max(8, width - visibleWidth(LOGO_TOP) - visibleWidth(LOGO_GAP));
	const lines = [
		`${LOGO_TOP}${LOGO_GAP}${goldBold(truncateToWidth(HINT_TEXT, textWidth, "…"))}`,
		`${LOGO_BOTTOM}${LOGO_GAP}${theme.fg("text", truncateToWidth(TIP_TEXT, textWidth, "…"))}`,
		gold(`v${VERSION}`),
		"",
	];

	lines.push(...(data ? renderBox(data, width, theme) : renderScanningBox(width, theme)));
	return lines;
}

class StartupHeader extends CachedView {
	private data: StartupData | undefined;
	private readonly theme: ThemeLike;

	constructor(theme: ThemeLike, data?: StartupData) {
		super();
		this.theme = theme;
		this.data = data;
	}

	/** 扫描完成：换掉数据并作废缓存（调用方负责 requestRender）。 */
	setData(data: StartupData): void {
		this.data = data;
		this.invalidate();
	}

	protected renderLines(width: number): string[] {
		return renderStartup(this.data, width, this.theme);
	}
}

/**
 * 扫描结果缓存。
 *
 * `/new`、`/fork`、`/resume` 都会触发 session_start，而 cwd 通常不变——
 * 之前每次都把技能树、扩展目录、各级父目录重新 stat 一遍（几十次 syscall）。
 * 按 cwd 缓存，`/reload` 时清空（那时可能装了新技能/扩展）。
 */
const dataCache = new Map<string, StartupData>();
/** 正在扫描中的 Promise：启动页与信息面板同时打开时只扫一次。 */
const dataPromiseCache = new Map<string, Promise<StartupData>>();

/**
 * 缓存感知的启动页数据：命中就用缓存，否则扫一次并回填（面板的「加载」区也走这里）。
 * `force` 用于面板按 `r` 时真正重扫（否则 dataCache 会一直返回旧技能/扩展清单）。
 */
async function getStartupData(cwd: string, force = false): Promise<StartupData> {
	const key = pathKey(cwd);
	if (!force) {
		const cached = dataCache.get(key);
		if (cached) return cached;
		const pending = dataPromiseCache.get(key);
		if (pending) return pending;
	}

	const promise = collectStartupData(cwd);
	dataPromiseCache.set(key, promise);
	promise.then(
		(data) => {
			// 已被更新的一次扫描（例如面板按 r 的 force）取代时，不要把旧结果写回缓存。
			if (dataPromiseCache.get(key) !== promise) return;
			dataPromiseCache.delete(key);
			dataCache.set(key, data);
			// cwd 通常只有一个；留几条足够覆盖 /cd 来回切，避免 Map 无上限。
			if (dataCache.size > 3) {
				const oldest = dataCache.keys().next().value;
				if (oldest !== undefined) dataCache.delete(oldest);
			}
		},
		() => {
			if (dataPromiseCache.get(key) === promise) dataPromiseCache.delete(key);
		},
	);
	return promise;
}

/** 信息面板「加载」区要的名单：当前会话已启用的技能 / 扩展 / MCP 名字。 */
export interface SessionResources {
	skills: string[];
	extensions: string[];
	mcp: string[];
}

/**
 * 技能/扩展复用启动页那份按 cwd 的扫描缓存；MCP 每次现读两份 mcp.json——
 * `/mcp` 的启停开关会直接写回文件，不等 /reload。`extensionMcp` 是调用方
 * 从 `pi.getMcpServers()` 取的扩展注册名单，去重后并入。
 */
export async function collectSessionResources(
	cwd: string,
	extensionMcp: readonly string[] = [],
	options: { force?: boolean } = {},
): Promise<SessionResources> {
	const [data, mcp] = await Promise.all([
		getStartupData(cwd, options.force === true),
		collectMcpServers(cwd),
	]);
	const enabledNames = (entries: ReadonlyArray<{ name: string; enabled: boolean }>): string[] =>
		entries.filter((entry) => entry.enabled).map((entry) => entry.name);
	// 用 Set 去重：数组长名单上 includes 是 O(n²)，且扩展注册的名字可能重复。
	const mcpNames = new Set(enabledNames(mcp));
	for (const name of extensionMcp) mcpNames.add(name);
	return {
		skills: enabledNames(data.skills),
		extensions: enabledNames(data.extensions),
		mcp: [...mcpNames],
	};
}

function setupStartupHeader(pi: ExtensionAPI): void {
	// 每次 session_start +1：扫描完成时如果会话已经换掉，就别再动 header。
	let generation = 0;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const current = ++generation;

		const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
		const cached = dataCache.get(pathKey(cwd));
		let header: StartupHeader | undefined;
		let tui: TUI | undefined;
		// 扫描可能先于工厂完成（工厂不一定同步被调）：把最新结果留在闭包里，
		// 工厂真正创建组件时再补一次，不能靠"工厂已经同步跑过"这个隐含前提。
		let latest: StartupData | undefined;
		ctx.ui.setHeader((ui, theme) => {
			tui = ui;
			header = new StartupHeader(theme);
			const initial = cached ?? latest;
			if (initial) header.setData(initial);
			return header;
		});
		if (cached) return;

		void getStartupData(cwd)
			.then((data) => {
				if (current !== generation) return;
				latest = data;
				if (header === undefined) return;
				header.setData(data);
				tui?.requestRender();
			})
			.catch(() => {
				// 扫描失败就保持骨架，不影响会话本身。
			});
	});

	pi.on("session_shutdown", (event) => {
		generation++;
		// reload 会重新加载扩展，技能/扩展清单可能变了 → 丢掉缓存
		if (event.reason === "reload") {
			dataCache.clear();
			dataPromiseCache.clear();
		}
	});
}

export { setupStartupHeader };
