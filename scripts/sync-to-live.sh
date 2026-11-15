#!/usr/bin/env bash
# 把仓库里的实现同步到你自己的 pi skill 目录（本机开发用）。
#   bash scripts/sync-to-live.sh
# 之后在 pi 里 /reload。
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
target="$agent/extensions"

mkdir -p "$target"
cp "$repo/extensions/ui-style.ts" "$target/ui-style.ts"
rm -rf "$target/ui-style.modules"
cp -r "$repo/extensions/ui-style.modules" "$target/ui-style.modules"

echo "已同步到 $target"
echo "（如果同时还用 pi install 装了这个包，记得二选一，别同时启用）"
