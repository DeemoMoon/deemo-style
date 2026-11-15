#!/usr/bin/env bash
# 跑 ui-style 的纯函数单测。
#
# 为什么要这么绕：扩展文件在 <agent-dir>/extensions/ 下，那里没有 node_modules，
# 而 core.ts 依赖 @earendil-works/pi-tui。这里在临时目录里搭一个只含符号链接的
# node_modules（指向 pi 自带的包），把模块拷贝进去再跑 node --test。
#
#   bash ui-style.modules/tests/run.sh
#
# 只读操作，不会改动 ~/.pi/agent 下的任何文件。

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
modules="$(dirname "$here")"

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

pkg="$(find_pi_package || true)"
if [ -z "$pkg" ]; then
	echo "找不到 @earendil-works/pi-coding-agent；请设置 PI_PACKAGE_DIR 指向该包目录。" >&2
	exit 1
fi
if [ ! -d "$pkg/node_modules/@earendil-works/pi-tui" ]; then
	echo "在 $pkg 下找不到 @earendil-works/pi-tui" >&2
	exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/node_modules/@earendil-works"
ln -s "$pkg" "$tmp/node_modules/@earendil-works/pi-coding-agent"
ln -s "$pkg/node_modules/@earendil-works/pi-tui" "$tmp/node_modules/@earendil-works/pi-tui"
ln -s "$pkg/node_modules/jiti" "$tmp/node_modules/jiti"
cp -r "$modules" "$tmp/modules"

echo "pi 包目录: $pkg"
node --test "$tmp/modules/tests/"
