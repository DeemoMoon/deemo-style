#!/usr/bin/env bash
# 在"朋友的干净环境"里验证这个包：跑测试 + 安装 + 真实加载一次。
#   bash scripts/smoke.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 找 pi 包目录（Homebrew / npm 全局 / PI_PACKAGE_DIR 三种情况）
find_pi_package() {
	if [ -n "${PI_PACKAGE_DIR:-}" ] && [ -d "$PI_PACKAGE_DIR" ]; then
		printf '%s\n' "$PI_PACKAGE_DIR"
		return 0
	fi

	# 1. pi 的可执行文件（Homebrew 之类是符号链接，readlink -f 后向上找 package.json）
	local bin real dir
	bin="$(command -v pi 2>/dev/null || true)"
	if [ -n "$bin" ]; then
		real="$(readlink -f "$bin" 2>/dev/null || true)"
		# 1a. 包根目录（bin 在包内时）
		dir="$real"
		while [ -n "$dir" ] && [ "$dir" != "/" ]; do
			if [ -d "$dir/dist" ] && grep -q '"name": "@earendil-works/pi-coding-agent"' "$dir/package.json" 2>/dev/null; then
				printf '%s\n' "$dir"
				return 0
			fi
			dir="$(dirname "$dir")"
		done
		# 1b. 常见的包装脚本布局（Homebrew: bin/pi -> libexec/lib/node_modules/...）
		local base
		base="$(dirname "$real")"
		for dir in \
			"$base/../libexec/lib/node_modules/@earendil-works/pi-coding-agent" \
			"$base/../lib/node_modules/@earendil-works/pi-coding-agent" \
			"$base/../libexec/node_modules/@earendil-works/pi-coding-agent"; do
			if [ -d "$dir" ]; then
				printf '%s\n' "$(cd "$dir" && pwd)"
				return 0
			fi
		done
	fi

	# 2. 全局 node_modules
	local root
	root="$(npm root -g 2>/dev/null || true)"
	if [ -n "$root" ] && [ -d "$root/@earendil-works/pi-coding-agent" ]; then
		printf '%s\n' "$root/@earendil-works/pi-coding-agent"
		return 0
	fi

	return 1
}

echo "== 1/3 跑测试"
bash "$repo/extensions/ui-style.modules/tests/run.sh" | grep -E "^ℹ (tests|pass|fail)"

echo "== 2/3 在全新 agent 目录里安装本地包"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export PI_CODING_AGENT_DIR="$tmp/agent"
export PI_PKG="$(find_pi_package || true)"
pi install "$repo" >/dev/null
pi list

echo "== 3/3 走 pi 的真实包发现路径加载一次"
node --input-type=module -e '
const pkg = process.env.PI_PKG;
const pi = await import(`file://${pkg}/dist/index.js`);
const services = await pi.createAgentSessionServices({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
});
const found = services.resourceLoader.getExtensions();
const errors = found.errors ?? [];
if (errors.length > 0) {
  for (const error of errors) console.error("LOAD ERROR:", error.path, error.error?.message ?? error.error);
  process.exit(1);
}
const loaded = found.extensions.map((ext) => ext.resolvedPath ?? ext.path);
console.log("loaded extensions:", loaded);
if (!loaded.some((path) => path.includes("ui-style.ts"))) {
  console.error("package extension not loaded");
  process.exit(1);
}
console.log("OK：包安装 → 发现 → 加载 全链路通过");
'
