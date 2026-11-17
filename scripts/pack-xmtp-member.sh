#!/bin/sh
# 把 workers/xmtp-member 打成发布 tar.gz（WP6 发布打包）。
#
# 用法：
#   sh scripts/pack-xmtp-member.sh           # 产物: dist/xmtp-member-<version>.tar.gz
#
# 产物内容与约定：
#   - tar 包顶层目录固定叫 xmtp-member/（install.sh 解包时会自动识别单一顶层目录）。
#   - 包含 package.json / package-lock.json / tsconfig.json / src/**，
#     排除 node_modules、.state、*.db3*、.env*、*.test.ts、日志、系统垃圾文件。
#   - 同时生成 <包名>.sha256 旁车文件，发布侧校验用。
#
# 发布到 Hub 的 /downloads/（install.sh 的 MAPR_PKG_URL 默认指向
#   {hub_origin}/downloads/xmtp-member-latest.tar.gz）：
#   方式 A：把产物传到生产机 /var/www/hub-downloads/xmtp-member-latest.tar.gz
#           （nginx 的 location ^~ /downloads/ 已在，见 publish-downloads.yml）。
#   方式 B：跑 .github/workflows/publish-downloads.yml（workflow_dispatch），
#           该工作流接受 source_base_url + target_slug，把文件落到同一个目录。
#   以后要做版本号/日期戳多版本共存时，把 target_slug 用成版本目录即可。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/workers/xmtp-member"
[ -f "$SRC/package.json" ] || { echo "错误: 找不到 $SRC/package.json" >&2; exit 1; }

VERSION=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -n 1)
[ -n "$VERSION" ] || { echo "错误: 无法从 package.json 读出 version" >&2; exit 1; }

command -v tar >/dev/null 2>&1 || { echo "错误: 缺少 tar" >&2; exit 1; }

OUT_DIR="$ROOT/dist"
PKG_NAME="xmtp-member-$VERSION.tar.gz"
OUT="$OUT_DIR/$PKG_NAME"
mkdir -p "$OUT_DIR"

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/mapr-pack.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT

# 用 find 白名单收文件再逐个复制：比 tar --exclude 更可移植（GNU/BSD 都一致）。
( cd "$SRC" && find . -type f \
    ! -path './node_modules/*' \
    ! -path './.state/*' \
    ! -path './dist/*' \
    ! -path './coverage/*' \
    ! -name '.env' \
    ! -name '.env.*' \
    ! -name '*.db3' \
    ! -name '*.db3-*' \
    ! -name '*.db3.*' \
    ! -name '*.test.ts' \
    ! -name '*.test.tsx' \
    ! -name '*.tsbuildinfo' \
    ! -name '*.log' \
    ! -name '.DS_Store' \
    -print ) > "$TMPD/files"

mkdir -p "$TMPD/xmtp-member"
while IFS= read -r f; do
  d=$(dirname "$f")
  mkdir -p "$TMPD/xmtp-member/$d"
  cp "$SRC/$f" "$TMPD/xmtp-member/$f"
done < "$TMPD/files"

# 发布包必须能独立安装：这几个文件缺一不可。
for req in package.json package-lock.json src/cli.ts; do
  [ -f "$TMPD/xmtp-member/$req" ] || { echo "错误: 发布包缺 $req" >&2; exit 1; }
done

tar -czf "$OUT" -C "$TMPD" xmtp-member

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT_DIR" && sha256sum "$PKG_NAME" > "$PKG_NAME.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$OUT_DIR" && shasum -a 256 "$PKG_NAME" > "$PKG_NAME.sha256" )
fi

echo "打包完成: $OUT"
echo "文件数: $(wc -l < "$TMPD/files" | tr -d ' ')"
[ -f "$OUT.sha256" ] && echo "校验值: $(cat "$OUT.sha256")"
echo ""
echo "发布方式（任选其一）："
echo "  scp $OUT <生产机>:/var/www/hub-downloads/xmtp-member-latest.tar.gz"
echo "  或跑 .github/workflows/publish-downloads.yml（workflow_dispatch）"
