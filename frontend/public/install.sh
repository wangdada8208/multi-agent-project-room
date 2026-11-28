#!/bin/sh
# Parlor 本机助手一键安装脚本（Linux + macOS，POSIX sh）
#
# 用法（网站「我的 Agent」页生成的命令）：
#   curl -fsSL https://hub.wangdada8208.xyz/install.sh | sh -s -- --pair <配对码>
#
# 参数：
#   --pair <配对码>   装好后立即执行一次 `mapr up --hub <hub> --pair <配对码>` 完成配对
#   --hub <Hub 地址>  默认见下方 MAPR_HUB_ORIGIN（覆盖默认发布包地址用环境变量 MAPR_PKG_URL）
#   --uninstall      撤掉开机自启、停掉本机助手进程，保留 ~/.mapr 数据
#   --purge          在卸载基础上连 ~/.mapr 数据一起删除（会询问确认，--yes 跳过）
#   --yes            跳过 --purge 的确认（管道里运行、无法交互时使用）
#   --auto-install-node
#                    检测不到合格 Node 时，把官方 Node 22 装进 ~/.mapr/runtime/node
#                    （只写用户目录，不用 sudo，不改系统 Node）；默认不自动安装
#   -h, --help       显示本说明
#
# 环境变量：
#   MAPR_HUB_ORIGIN  Hub 地址，默认 https://hub.wangdada8208.xyz
#   MAPR_PKG_URL     发布包（tar.gz）地址，
#                    默认 <Hub>/downloads/xmtp-member-latest.tar.gz
#                    WP6 备注：发布流水线（scripts/pack-xmtp-member.sh 打包 +
#                    .github/workflows/publish-downloads.yml 或手动传到生产机
#                    /var/www/hub-downloads/）就位后这个默认地址即生效；
#                    联调时可指向 file:///... 或任意 http(s) 地址。
#
# 写文件的位置：~/.mapr/（程序与数据）+ 当前用户的自启目录。
# 不用 sudo。重复运行 = 升级包体并保留 helper.json 等数据（幂等）。
set -eu

# ── 常量与默认值 ────────────────────────────────────────────────

DEFAULT_HUB="https://hub.wangdada8208.xyz"
HELPER_PORT=8790
if [ -z "${HOME:-}" ]; then
  printf '错误: HOME 环境变量未设置，无法确定 ~/.mapr 位置。\n' >&2
  exit 1
fi
MAPR_ROOT="$HOME/.mapr"
NODE_MIN="22.6"   # node --experimental-strip-types 自 22.6 起可用

say()  { printf '%s\n' "$*"; }
warn() { printf '警告: %s\n' "$*" >&2; }
die()  { printf '错误: %s\n' "$*" >&2; exit 1; }

# 输出给「复制粘贴」用的 shell 参数：单引号包裹，原字符串里的单引号按 POSIX 惯例转义。
shell_quote() {
  sq=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$sq"
}

usage() {
  cat <<'USAGE'
Parlor 本机助手一键安装（Linux + macOS）

用法: curl -fsSL <Hub>/install.sh | sh -s -- [--pair <配对码>] [--hub <Hub 地址>] [--auto-install-node]

  --pair <配对码>   装好后立即执行 `mapr up --pair <配对码>` 完成配对
  --hub <Hub 地址>  默认 https://hub.wangdada8208.xyz（或环境变量 MAPR_HUB_ORIGIN）
  --uninstall      撤自启、停进程，保留 ~/.mapr 数据
  --purge          卸载并删除 ~/.mapr 全部数据（默认询问，--yes 跳过）
  --yes            跳过 --purge 的确认
  --auto-install-node
                   缺 Node 或版本太低时，把官方 Node 22 装进 ~/.mapr/runtime/node
                   （只写用户目录，不改系统 Node）；默认不自动安装
  -h, --help       显示本说明

环境变量: MAPR_HUB_ORIGIN、MAPR_PKG_URL（发布包地址，默认 <Hub>/downloads/xmtp-member-latest.tar.gz）
USAGE
}

# ── 参数解析 ────────────────────────────────────────────────────

HUB=""
PAIR_CODE=""
DO_UNINSTALL=0
DO_PURGE=0
ASSUME_YES=0
AUTO_INSTALL_NODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pair)      PAIR_CODE="${2:?--pair 需要一个配对码参数}"; shift 2 ;;
    --hub)       HUB="${2:?--hub 需要一个地址参数}"; shift 2 ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    --purge)     DO_PURGE=1; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --auto-install-node) AUTO_INSTALL_NODE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "不认识的参数: $1（--help 看用法）" ;;
  esac
done

HUB="${HUB:-${MAPR_HUB_ORIGIN:-$DEFAULT_HUB}}"
HUB="${HUB%/}"
PKG_URL="${MAPR_PKG_URL:-$HUB/downloads/xmtp-member-latest.tar.gz?t=$(date +%s)}"

# ── 卸载 / 清除：委托给安装时落盘的 ~/.mapr/uninstall.sh ──

if [ "$DO_UNINSTALL" = 1 ] || [ "$DO_PURGE" = 1 ]; then
  if [ -f "$MAPR_ROOT/uninstall.sh" ]; then
    u_args=""
    if [ "$DO_PURGE" = 1 ]; then u_args="--purge"; fi
    if [ "$ASSUME_YES" = 1 ]; then u_args="$u_args --yes"; fi
    # shellcheck disable=SC2086
    exec sh "$MAPR_ROOT/uninstall.sh" $u_args
  fi
  [ -d "$MAPR_ROOT" ] || { say "未安装（$MAPR_ROOT 不存在）。"; exit 0; }
  die "$MAPR_ROOT 存在但 uninstall.sh 缺失。请手动删除自启项后删掉该目录。"
fi

# ── 环境检查 ────────────────────────────────────────────────────

OS=$(uname -s 2>/dev/null || echo unknown)
case "$OS" in
  Linux|Darwin) ;;
  MINGW*|MSYS*|CYGWIN*)
    die "这是 Windows 环境，请改用 PowerShell 版本：iwr $HUB/install.ps1 -UseBasicParsing | iex" ;;
  *) die "暂不支持的系统：${OS}（本脚本支持 Linux 和 macOS）" ;;
esac

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "缺少 $c 命令，请先安装后再运行。"
done

# 之前用 --auto-install-node 装过的 Node 只服务 Parlor，不要求用户改 PATH。
if [ -x "$MAPR_ROOT/runtime/node/bin/node" ]; then
  case ":$PATH:" in
    *":$MAPR_ROOT/runtime/node/bin:"*) ;;
    *) PATH="$MAPR_ROOT/runtime/node/bin:$PATH"; export PATH ;;
  esac
fi

node_version_value() {
  node -v 2>/dev/null | sed 's/^v//'
}

node_satisfies() {
  nv=$(node_version_value)
  nv_major=${nv%%.*}
  nv_rest=${nv#*.}
  nv_minor=${nv_rest%%.*}
  case "$nv_major" in ''|*[!0-9]*) return 1 ;; esac
  case "$nv_minor" in ''|*[!0-9]*) nv_minor=0 ;; esac
  [ "$nv_major" -gt 22 ] || { [ "$nv_major" -eq 22 ] && [ "$nv_minor" -ge 6 ]; }
}

detect_node_problem() {
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' missing
  elif ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' npm-missing
  elif ! node_satisfies; then
    printf '%s\n' old
  fi
}

node_platform() {
  np_arch=$(uname -m 2>/dev/null || echo unknown)
  case "$OS:$np_arch" in
    Linux:x86_64|Linux:amd64) printf '%s\n' linux-x64 ;;
    Linux:aarch64|Linux:arm64) printf '%s\n' linux-arm64 ;;
    Darwin:x86_64) printf '%s\n' darwin-x64 ;;
    Darwin:arm64) printf '%s\n' darwin-arm64 ;;
    *) return 1 ;;
  esac
}

verify_sha256() {
  vs_file=$1
  vs_sum=$2
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$vs_sum" "$vs_file" | sha256sum -c - >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\n' "$vs_sum" "$vs_file" | shasum -a 256 -c - >/dev/null 2>&1
  else
    return 1
  fi
}

# 显式 --auto-install-node 才走这里：从 nodejs.org 下载带 SHA256 校验的官方包，
# 只写 ~/.mapr/runtime/node；不碰 /usr/local、不使用 sudo、也不修改系统 Node。
auto_install_node() {
  ai_platform=$(node_platform) || {
    warn "这台机器的系统和芯片组合暂不支持自动安装 Node。请用下面的手动指引。"
    return 1
  }
  ai_tmp=$(mktemp -d "${TMPDIR:-/tmp}/mapr-node.XXXXXX") || return 1
  ai_ok=0
  ai_base_url="https://nodejs.org/dist/latest-v22.x"
  say "检测到 --auto-install-node：正在把官方 Node 22 安装到 $MAPR_ROOT/runtime/node（不修改系统目录）…"

  if curl -fsSL --retry 3 --retry-delay 2 -o "$ai_tmp/SHASUMS256.txt" "$ai_base_url/SHASUMS256.txt"; then
    ai_line=$(grep "node-v[0-9.]*-${ai_platform}\.tar\.gz$" "$ai_tmp/SHASUMS256.txt" 2>/dev/null | sed -n '1p' || true)
    ai_sum=${ai_line%% *}
    ai_file=${ai_line##* }
    if [ -n "$ai_sum" ] && [ -n "$ai_file" ] && [ "$ai_sum" != "$ai_file" ]; then
      if curl -fsSL --retry 3 --retry-delay 2 -o "$ai_tmp/$ai_file" "$ai_base_url/$ai_file"; then
        if verify_sha256 "$ai_tmp/$ai_file" "$ai_sum"; then
          mkdir -p "$ai_tmp/ex"
          ai_dir=${ai_file%.tar.gz}
          if tar -xzf "$ai_tmp/$ai_file" -C "$ai_tmp/ex" && [ -x "$ai_tmp/ex/$ai_dir/bin/node" ]; then
            mkdir -p "$MAPR_ROOT/runtime"
            rm -rf "$MAPR_ROOT/runtime/node.new" "$MAPR_ROOT/runtime/node.old"
            if mv "$ai_tmp/ex/$ai_dir" "$MAPR_ROOT/runtime/node.new"; then
              if [ -d "$MAPR_ROOT/runtime/node" ]; then mv "$MAPR_ROOT/runtime/node" "$MAPR_ROOT/runtime/node.old"; fi
              if mv "$MAPR_ROOT/runtime/node.new" "$MAPR_ROOT/runtime/node"; then
                rm -rf "$MAPR_ROOT/runtime/node.old"
                PATH="$MAPR_ROOT/runtime/node/bin:$PATH"
                export PATH
                hash -r 2>/dev/null || true
                if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node_satisfies; then
                  ai_ok=1
                fi
              elif [ -d "$MAPR_ROOT/runtime/node.old" ]; then
                mv "$MAPR_ROOT/runtime/node.old" "$MAPR_ROOT/runtime/node"
              fi
            fi
          fi
        fi
      fi
    fi
  fi

  rm -rf "$ai_tmp"
  if [ "$ai_ok" = "1" ]; then
    say "Node.js $(node -v 2>/dev/null) 已装好，只供 Parlor 使用。"
    return 0
  fi
  warn "自动安装 Node 没有成功。已保留系统现状，未写入系统目录。"
  return 1
}

print_node_guidance() {
  pg_problem=$1
  pg_current=$(node_version_value 2>/dev/null || true)
  case "$pg_problem" in
    missing) pg_first="检测不到 Node.js。" ;;
    npm-missing) pg_first="检测不到 npm（它应随 Node.js 一起安装）。" ;;
    old) pg_first="Node.js 版本太低（当前 v${pg_current}，需要 >= ${NODE_MIN}）。" ;;
    *) pg_first="Node.js 环境不可用。" ;;
  esac
  printf '错误: %s\n' "$pg_first" >&2
  printf '本机助手需要 Node.js %s 或更高版本。\n' "$NODE_MIN" >&2

  if [ "$AUTO_INSTALL_NODE" = "1" ]; then
    printf '%s\n' "自动安装没有成功。检查网络或代理后，重新运行刚才那条命令；也可以打开 https://nodejs.org/en/download 手动安装 Node 22 LTS（或更新）。" >&2
    exit 1
  fi

  pg_cmd=""
  if command -v brew >/dev/null 2>&1; then
    pg_cmd="brew install node"
  elif command -v fnm >/dev/null 2>&1; then
    pg_cmd="fnm install 22 && fnm use 22"
  elif [ -n "${NVM_DIR:-}" ] && [ -f "$NVM_DIR/nvm.sh" ]; then
    pg_cmd="export NVM_DIR=$(shell_quote "$NVM_DIR") && . $(shell_quote "$NVM_DIR/nvm.sh") && nvm install 22"
  elif [ -f "$HOME/.nvm/nvm.sh" ]; then
    pg_cmd="export NVM_DIR=$(shell_quote "$HOME/.nvm") && . $(shell_quote "$HOME/.nvm/nvm.sh") && nvm install 22"
  else
    pg_url="$HUB/install.sh"
    pg_cmd="curl -fsSL $(shell_quote "$pg_url") | sh -s -- --auto-install-node --hub $(shell_quote "$HUB")"
    if [ -n "$PAIR_CODE" ]; then
      pg_cmd="$pg_cmd --pair $(shell_quote "$PAIR_CODE")"
    fi
  fi

  printf '复制这一行安装 Node 22 或更新：\n  %s\n' "$pg_cmd" >&2
  printf '%s\n' '装完后，重新粘贴刚才那条 Parlor 配对命令即可继续。' >&2
  printf '%s\n' '如果上面的命令不能用，打开 https://nodejs.org/en/download 安装 Node 22 LTS（或更新）。' >&2
  exit 1
}

node_problem=$(detect_node_problem)
if [ -n "$node_problem" ] && [ "$AUTO_INSTALL_NODE" = "1" ]; then
  auto_install_node || true
  node_problem=$(detect_node_problem)
fi
if [ -n "$node_problem" ]; then
  print_node_guidance "$node_problem"
fi

# ── 下载并解开发布包到 ~/.mapr/pkg/（升级时整包替换） ──

mkdir -p "$MAPR_ROOT/bin" "$MAPR_ROOT/agents" "$MAPR_ROOT/seats" "$MAPR_ROOT/sandbox"
chmod 700 "$MAPR_ROOT" "$MAPR_ROOT/agents" "$MAPR_ROOT/seats" "$MAPR_ROOT/sandbox" 2>/dev/null || true

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/mapr-install.XXXXXX")
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM HUP

say "正在下载发布包：$PKG_URL"
curl -fsSL --retry 3 --retry-delay 2 -o "$TMPD/pkg.tar.gz" "$PKG_URL" \
  || die "下载失败。检查网络，或确认发布包已上传到该地址（可用环境变量 MAPR_PKG_URL 指定其它地址）。"

mkdir -p "$TMPD/ex"
tar -xzf "$TMPD/pkg.tar.gz" -C "$TMPD/ex" || die "发布包解压失败（不是有效的 tar.gz）。"
top_count=$(ls -A "$TMPD/ex" | wc -l | tr -d ' ')
if [ "$top_count" = "1" ]; then
  top_name=$(ls -A "$TMPD/ex")
  if [ -d "$TMPD/ex/$top_name" ]; then PKG_SRC="$TMPD/ex/$top_name"; else PKG_SRC="$TMPD/ex"; fi
else
  PKG_SRC="$TMPD/ex"
fi
[ -f "$PKG_SRC/package.json" ] || die "发布包结构不对：里面没有 package.json。"

rm -rf "$MAPR_ROOT/pkg.new"
mv "$PKG_SRC" "$MAPR_ROOT/pkg.new"
say "正在安装依赖（npm install --omit=dev，在 $MAPR_ROOT/pkg.new 里）…"
( cd "$MAPR_ROOT/pkg.new" && npm install --omit=dev ) \
  || { rm -rf "$MAPR_ROOT/pkg.new"; die "npm install 失败（网络问题或依赖源不可用）。原有安装未受影响。"; }

rm -rf "$MAPR_ROOT/pkg.old"
if [ -d "$MAPR_ROOT/pkg" ]; then mv "$MAPR_ROOT/pkg" "$MAPR_ROOT/pkg.old"; fi
mv "$MAPR_ROOT/pkg.new" "$MAPR_ROOT/pkg"
rm -rf "$MAPR_ROOT/pkg.old"

# ── 写 ~/.mapr/bin/mapr 入口与卸载脚本 ──

cat > "$MAPR_ROOT/bin/mapr" <<'MAPR_EOF'
#!/bin/sh
# mapr — Parlor 本机助手命令行入口（install.sh 生成，重复安装会重写本文件）
set -eu
MAPR_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "${1:-}" = "uninstall" ]; then
  shift
  exec sh "$MAPR_ROOT/uninstall.sh" "$@"
fi
if [ -x "$MAPR_ROOT/runtime/node/bin/node" ]; then
  MAPR_NODE="$MAPR_ROOT/runtime/node/bin/node"
else
  MAPR_NODE=node
fi
exec "$MAPR_NODE" --experimental-strip-types "$MAPR_ROOT/pkg/src/cli.ts" "$@"
MAPR_EOF
chmod 755 "$MAPR_ROOT/bin/mapr"

cat > "$MAPR_ROOT/uninstall.sh" <<'UNINST_EOF'
#!/bin/sh
# Parlor 本机助手卸载：撤自启、停进程。
# 用法: sh ~/.mapr/uninstall.sh [--purge] [--yes]
#   --purge  连 ~/.mapr 数据一起删（配对信息、席位私钥都会没，谨慎）
#   --yes    跳过 --purge 的确认提示
set -eu
MAPR_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PURGE=0; YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    *) printf '参数不认识: %s（支持 --purge --yes）\n' "$a" >&2; exit 2 ;;
  esac
done
OS=$(uname -s 2>/dev/null || echo unknown)

if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/xyz.mapr.helper.plist"
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/xyz.mapr.helper" 2>/dev/null \
      || launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已移除 LaunchAgent。"
  fi
else
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now mapr-helper.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.config/systemd/user/mapr-helper.service" \
        "$HOME/.config/autostart/mapr-helper.desktop"
  echo "已移除 systemd 用户服务 / 桌面自启项（如果存在过）。"
fi

# 停掉仍在运行的本机助手（含手动 nohup 起来的）。
pkill -f "$MAPR_ROOT/pkg/src/cli.ts" 2>/dev/null || true

if [ "$PURGE" = "0" ]; then
  rm -f "$MAPR_ROOT/bin/mapr" "$MAPR_ROOT/uninstall.sh"
  echo "卸载完成：自启项和 mapr 命令已移除。$MAPR_ROOT 下的数据已保留。"
  echo "要连数据一起删：rm -rf $MAPR_ROOT"
  exit 0
fi

if [ "$YES" = "0" ]; then
  if [ -r /dev/tty ]; then
    printf '确认删除 %s 下的全部数据（配对信息、席位私钥不可恢复）？输入 yes 继续: ' "$MAPR_ROOT" > /dev/tty
    ans=""
    read -r ans < /dev/tty || ans=""
    [ "$ans" = "yes" ] || { echo "已取消。"; exit 1; }
  else
    echo "无法交互确认。确定要删请加 --yes。" >&2
    exit 1
  fi
fi
rm -rf "$MAPR_ROOT"
echo "已删除 $MAPR_ROOT"
exit 0
UNINST_EOF
chmod 755 "$MAPR_ROOT/uninstall.sh"

# ── 自启项：写入但不启动（配对先走手动进程，之后交管理器接管） ──

AUTOSTART_KIND="none"
PLIST="$HOME/Library/LaunchAgents/xyz.mapr.helper.plist"
UNIT="$HOME/.config/systemd/user/mapr-helper.service"
DESKTOP="$HOME/.config/autostart/mapr-helper.desktop"

NODE_BIN_DIR=$(dirname "$(command -v node)")
BASE_SERVICE_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
case ":$BASE_SERVICE_PATH:" in
  *":$NODE_BIN_DIR:"*) SERVICE_PATH="$BASE_SERVICE_PATH" ;;
  *) SERVICE_PATH="$NODE_BIN_DIR:$BASE_SERVICE_PATH" ;;
esac

systemd_user_ok() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

write_systemd_unit() {
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$UNIT" <<EOF
[Unit]
Description=Parlor helper (mapr 本机助手)
After=network-online.target

[Service]
Type=simple
Environment="PATH=$SERVICE_PATH"
ExecStart="$MAPR_ROOT/bin/mapr" up --hub "$HUB"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

write_desktop_autostart() {
  mkdir -p "$HOME/.config/autostart"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Parlor Helper (mapr 本机助手)
Comment=Local helper for Parlor encrypted rooms, port 8790
Exec="$MAPR_ROOT/bin/mapr" up --hub "$HUB"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
}

write_launchagent() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>xyz.mapr.helper</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$SERVICE_PATH</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$MAPR_ROOT/bin/mapr</string>
    <string>up</string>
    <string>--hub</string>
    <string>$HUB</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$MAPR_ROOT/helper.log</string>
  <key>StandardErrorPath</key>
  <string>$MAPR_ROOT/helper.log</string>
</dict>
</plist>
EOF
}

setup_autostart() {
  if [ "$OS" = "Darwin" ]; then
    write_launchagent
    AUTOSTART_KIND="launchd"
    say "已写入 LaunchAgent：${PLIST}（下次登录自动启动）"
  elif systemd_user_ok; then
    write_systemd_unit
    systemctl --user enable mapr-helper.service >/dev/null 2>&1 || true
    AUTOSTART_KIND="systemd"
    say "已写入并启用 systemd 用户服务：$UNIT"
  else
    write_desktop_autostart
    AUTOSTART_KIND="desktop"
    say "已写入桌面会话自启项：${DESKTOP}（下次图形登录生效）"
  fi
}

# 让服务管理器从现在起接管（升级时 restart 以加载新包体）。
start_managed() {
  case "$AUTOSTART_KIND" in
    systemd)
      systemctl --user restart mapr-helper.service >/dev/null 2>&1 || return 1
      # 注销后仍在跑（需要 loginctl，部分发行版会弹授权；失败不致命）
      loginctl enable-linger >/dev/null 2>&1 || true
      return 0 ;;
    launchd)
      launchctl bootout "gui/$(id -u)/xyz.mapr.helper" >/dev/null 2>&1 || true
      if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
        launchctl kickstart -k "gui/$(id -u)/xyz.mapr.helper" >/dev/null 2>&1 || true
        return 0
      fi
      launchctl load -w "$PLIST" >/dev/null 2>&1 && return 0
      return 1 ;;
    *) return 1 ;;
  esac
}

# ── 本机接口探测与本地配对 ────────────────────────────────────────

probe_hello() {
  curl -fsS --max-time 2 "http://127.0.0.1:$HELPER_PORT/api/hello" 2>/dev/null
}

hello_paired() {
  probe_hello | grep -q '"paired"[ ]*:[ ]*true'
}

pair_running_helper() {
  p_escaped=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  curl -fsS --max-time 8 -X POST "http://127.0.0.1:$HELPER_PORT/api/pair" \
    -H 'Content-Type: application/json' -H 'X-MAPR-Owner: 1' \
    -d "{\"code\":\"$p_escaped\"}" >/dev/null 2>&1
}

# 手动启动一次（无管理器兜底，或先跑配对）。
HELPER_PID=""
launch_helper() {
  nohup "$MAPR_ROOT/bin/mapr" up --hub "$HUB" "$@" \
    >>"$MAPR_ROOT/helper.log" 2>&1 </dev/null &
  HELPER_PID=$!
}

wait_hello() {   # 最多等 15 秒；进程提前死掉返回 2
  w_i=0
  while [ "$w_i" -lt 30 ]; do
    [ -n "$HELPER_PID" ] && ! kill -0 "$HELPER_PID" 2>/dev/null && return 2
    probe_hello >/dev/null 2>&1 && return 0
    sleep 0.5 2>/dev/null || sleep 1
    w_i=$((w_i + 1))
  done
  probe_hello >/dev/null 2>&1
}

# ── 主流程 ──────────────────────────────────────────────────────

PAIR_CODE="${PAIR_CODE:-${MAPR_PAIR_CODE:-${MAPR_PAIR:-}}}"

setup_autostart

MANAGED_OK="na"
if [ "$AUTOSTART_KIND" != "desktop" ] && [ "$AUTOSTART_KIND" != "none" ]; then
  if pkill -f "$MAPR_ROOT/pkg/src/cli.ts" 2>/dev/null; then
    sleep 0.5 2>/dev/null || sleep 1
  fi
  if start_managed; then
    w_i=0
    while [ "$w_i" -lt 20 ]; do
      if probe_hello >/dev/null 2>&1; then break; fi
      sleep 0.5 2>/dev/null || sleep 1
      w_i=$((w_i + 1))
    done
    if probe_hello >/dev/null 2>&1; then MANAGED_OK=1; else MANAGED_OK=0; fi
  else
    MANAGED_OK=0
  fi
else
  # 无服务管理器（如桌面会话或容器）：若存在旧版从 $MAPR_ROOT/pkg 拉起的手动进程，先停掉以便加载新代码
  if pkill -f "$MAPR_ROOT/pkg/src/cli.ts" 2>/dev/null; then
    sleep 0.5 2>/dev/null || sleep 1
  fi
fi

PAIR_STATE="not-requested"
if [ -n "$PAIR_CODE" ]; then
  case "$PAIR_CODE" in
    mpc_*.*) : ;;
    *) warn "配对码长得不像 mpc_... ，仍继续尝试" ;;
  esac
  if probe_hello >/dev/null 2>&1; then
    # 已有运行中的本机助手（含刚由 systemd/launchd 重启的新服务）：走本地接口配对（POST /api/pair {code}）
    say "检测到本机助手已在运行，直接通过本地接口配对…"
    if pair_running_helper "$PAIR_CODE"; then
      PAIR_STATE="paired"
    else
      PAIR_STATE="pair-failed"
    fi
  else
    say "正在启动本机助手并配对…"
    launch_helper --pair "$PAIR_CODE"
    w_rc=0; wait_hello || w_rc=$?
    if [ "$w_rc" = "2" ]; then
      PAIR_STATE="process-died"
    elif hello_paired; then
      PAIR_STATE="paired"
    else
      PAIR_STATE="pair-pending"
    fi
  fi
else
  # 无配对码：若服务管理器已接管则已就绪；否则手动拉起一次。
  if [ "$MANAGED_OK" = "1" ]; then
    say "本机助手已通过后台服务启动。"
  elif ! probe_hello >/dev/null 2>&1; then
    say "正在手动启动本机助手（本次会话内有效；开机自启项已注册）…"
    launch_helper
    wait_hello >/dev/null 2>&1 || true
  fi
fi

# ── 结果汇报 ────────────────────────────────────────────────────

say ""
say "──── 安装完成 ────"
say "助手目录: $MAPR_ROOT"
say "mapr 命令: $MAPR_ROOT/bin/mapr（要直接在终端用，可把 $MAPR_ROOT/bin 加进 PATH）"
case "$AUTOSTART_KIND" in
  systemd) say "开机自启: systemd 用户服务 mapr-helper.service（mapr uninstall 可撤销）" ;;
  launchd) say "开机自启: LaunchAgent xyz.mapr.helper（mapr uninstall 可撤销）" ;;
  desktop) say "开机自启: 桌面自启项 mapr-helper.desktop（下次图形登录生效）" ;;
  *)       say "开机自启: 未注册，请手动把 $MAPR_ROOT/bin/mapr up --hub $HUB 加进你的自启项" ;;
esac

if [ -n "$PAIR_CODE" ]; then
  case "$PAIR_STATE" in
    paired)
      owner=$(probe_hello | sed -n 's/.*"owner_display_name"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
      say "配对: 成功${owner:+（账号：${owner}）}"
      ;;
    pair-failed)  warn "配对请求被本机助手拒绝（配对码过期或已用？）。可在 http://127.0.0.1:$HELPER_PORT/ 页面里重新输入配对码。" ;;
    pair-pending) warn "本机助手已启动但 15 秒内没确认配对结果。看日志 $MAPR_ROOT/helper.log；也可打开 http://127.0.0.1:$HELPER_PORT/ 检查状态。" ;;
    process-died) warn "mapr up 启动后立刻退出。日志在 $MAPR_ROOT/helper.log" ;;
  esac
  if [ "${MANAGED_OK:-na}" = "0" ]; then
    warn "后台服务接管失败，但手动进程可能仍在运行；重启后由自启项拉起。"
  elif [ "${MANAGED_OK:-na}" = "1" ]; then
    say "运行方式: 已由后台服务接管（崩溃自动重启）。"
  elif [ "$PAIR_STATE" != "process-died" ]; then
    say "运行方式: 本次为手动进程；下次登录起由自启项拉起。"
  fi
else
  hello=$(probe_hello 2>/dev/null || true)
  if [ -n "$hello" ]; then
    if printf '%s' "$hello" | grep -q '"paired"[ ]*:[ ]*true'; then
      say "本机助手运行中: http://127.0.0.1:$HELPER_PORT/ （已配对）"
    else
      say "本机助手运行中: http://127.0.0.1:$HELPER_PORT/ （未配对；去网站拿配对码）"
    fi
  else
    warn "本机助手暂未起来。看日志 $MAPR_ROOT/helper.log，或手动运行 $MAPR_ROOT/bin/mapr up --hub $HUB"
  fi
fi
say ""
say "撤销安装: sh $MAPR_ROOT/uninstall.sh（保留数据）或加 --purge（连数据一起删）"
