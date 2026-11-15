#!/usr/bin/env node
/**
 * 静态检查：有没有"别的模块导出了这个名字，我这里用了却没导入"。
 *
 * 为什么需要：我们用 jiti 直接跑 TS（只剥类型、不做类型检查），
 * 所以「改了调用处但忘了加 import」这种错误只会在**运行时**炸，
 * 一旦测试没覆盖到那条分支，就会带着 bug 上线（真实事故：
 * statusline.ts 用了 context-bar 的 hitRateMuted 却没导入）。
 *
 * 判据很窄、几乎不会误报：只检查"这个名字确实被别的模块 export 了，
 * 但本文件既没 import 也没自己声明"——方法名（render/cacheKey…）
 * 不是导出名，所以不会被误报。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 用 fileURLToPath 而不是 URL.pathname：后者会把非 ASCII 目录名百分号编码
const dir = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
const sources = new Map(files.map((file) => [file, readFileSync(join(dir, file), "utf8")]));

const EXPORT_RE = /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu;
const REEXPORT_RE = /export\s+\*\s+from\s+"\.\/([^"]+)"/gu;

/** export 名字 → 来源文件 */
const exportedBy = new Map();
function addExports(file, seen = new Set()) {
	if (seen.has(file)) return;
	seen.add(file);
	const source = sources.get(file) ?? "";
	for (const match of source.matchAll(EXPORT_RE)) {
		if (!exportedBy.has(match[1])) exportedBy.set(match[1], new Set());
		exportedBy.get(match[1]).add(file);
	}
	for (const match of source.matchAll(REEXPORT_RE)) {
		addExports(match[1].endsWith(".ts") ? match[1] : `${match[1]}.ts`, seen);
	}
}
for (const file of files) addExports(file);

/** 本文件导入的名字 */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

function importedNames(rawSource) {
	const names = new Set();
	const source = stripComments(rawSource);
	for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/gu)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).pop()?.trim();
			if (name) names.add(name);
		}
	}
	for (const match of source.matchAll(/import\s+(?:type\s+)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from/gu)) {
		names.add(match[1]);
	}
	return names;
}

/** 本文件自己声明的名字（含解构） */
function declaredNames(source) {
	const names = new Set();
	const declRe = /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gu;
	for (const match of source.matchAll(declRe)) names.add(match[1]);
	for (const match of source.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/gu)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(":").pop()?.split("=")[0]?.trim();
			if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
		}
	}
	return names;
}

/** 去掉注释和 import 语句后的正文 */
function body(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:])\/\/[^\n]*/gu, "$1")
		.replace(/import\s+(?:type\s+)?(?:\{[^}]*\}|[^;\n]+?)\s+from\s+"[^"]+";/gu, "");
}

const problems = [];
for (const file of files) {
	const source = sources.get(file);
	const known = new Set([...importedNames(source), ...declaredNames(source)]);
	const text = body(source);
	for (const [name, owners] of exportedBy) {
		if (owners.size === 1 && owners.has(file)) continue;
		if (known.has(name)) continue;
		// 作为"独立标识符"出现（不是 obj.name，也不是纯对象键 name: 的值位置忽略）
		const used = new RegExp(`(?<![.\\w$"'])\\b${name}\\b(?!\\s*:)`, "u");
		if (used.test(text)) {
			problems.push(`${file}: 用了 ${name}（由 ${[...owners].join(", ")} 导出），但没 import`);
		}
	}
}

if (problems.length > 0) {
	console.error("静态检查失败：");
	for (const problem of problems) console.error("  " + problem);
	process.exit(1);
}
console.log(`静态检查通过：${files.length} 个模块，没有「用了别的模块的导出却没 import」`);
