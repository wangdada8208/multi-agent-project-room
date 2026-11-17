#!/bin/sh
# WP6 自检脚本：在临时 HOME 里模拟 install.sh 的安装 / 升级 / 卸载全流程。
#
# 用法: sh scripts/verify-install.sh
#
# 做的事：
#   1. 跑 pack-xmtp-member.sh 打发布包；
#   2. 在临时 HOME（且屏蔽 systemd 用户总线）里跑 install.sh；
#   3. 校验目录结构、mapr 入口、自启项文件；
#   4. 重跑一次验证幂等（数据保留、退出码 0）；
#   5. `mapr uninstall` 撤自启、停进程、保留数据；再装 + --purge --yes 验证全删；
#   6. 顺带观察 `mapr up` 走到哪一步：8790 起来=PASS；
#      日志含 unknown_command/not implemented=WARN（WP2 还没实现，已知）；
#      其它失败=FAIL。
#
# 需要本机有 node(>=22.6)/npm/curl/tar（npm install 会真实访问 npm registry）。
# 不碰真实 HOME 和真实 systemd；结束清理全部临时文件。
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_SH="$ROOT/frontend/public/install.sh"
PACK_SH="$ROOT/scripts/pack-xmtp-member.sh"

PASS=0; FAIL=0; WARN=0
ok()   { printf 'PASS  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf 'WARN  %s\n' "$*"; WARN=$((WARN+1)); }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mapr-verify.XXXXXX")
FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME"
cleanup() {
  pkill -f "$FAKE_HOME/.mapr/pkg/src/cli.ts" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

say_section() { printf '\n── %s ──\n' "$*"; }

# 让 install.sh 走「无 systemd」分支，避免碰真实 systemd/dbus。
unset XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
export HOME="$FAKE_HOME"

say_section "0. 环境"
for c in node npm curl tar; do
  command -v "$c" >/dev/null 2>&1 || { bad "缺少 $c，无法继续"; exit 1; }
done
ok "node $(node -v) / npm $(npm -v)"

say_section "1. 打包"
sh "$PACK_SH" >"$WORK/pack.log" 2>&1 && ok "pack-xmtp-member.sh 跑通" || { cat "$WORK/pack.log"; bad "打包失败"; exit 1; }
TARBALL=$(ls "$ROOT"/dist/xmtp-member-*.tar.gz 2>/dev/null | head -n 1)
[ -n "$TARBALL" ] && ok "产物 $TARBALL" || { bad "找不到产物"; exit 1; }
[ -f "$TARBALL.sha256" ] && ok ".sha256 旁车文件存在" || note "没有 .sha256（无 sha256sum/shasum？）"
tar -tzf "$TARBALL" | grep -q 'xmtp-member/src/cli.ts' && ok "tar 包内有 src/cli.ts" || bad "tar 包结构不对"
tar -tzf "$TARBALL" | grep -q '\.test\.ts' && bad "tar 包含测试文件" || ok "tar 不含 *.test.ts"
tar -tzf "$TARBALL" | grep -q 'node_modules' && bad "tar 包含 node_modules" || ok "tar 不含 node_modules"

say_section "2. 首次安装（临时 HOME，无 --pair）"
export MAPR_PKG_URL="file://$TARBALL"
export MAPR_HUB_ORIGIN="https://hub.invalid.test"   # 故意不可达：验证离线场景行为
sh "$INSTALL_SH" >"$WORK/install1.log" 2>&1
i1_rc=$?
cat "$WORK/install1.log"
[ "$i1_rc" = "0" ] && ok "install.sh 退出码 0" || bad "install.sh 退出码 $i1_rc"

M="$FAKE_HOME/.mapr"
[ -d "$M/pkg" ] && [ -f "$M/pkg/package.json" ] && ok "发布包落在 $M/pkg" || bad "pkg 未就位"
[ -d "$M/pkg/node_modules" ] && ok "node_modules 已安装" || bad "npm install 没产出 node_modules"
[ -x "$M/bin/mapr" ] && ok "mapr 入口可执行" || bad "mapr 入口缺失"
[ -f "$M/uninstall.sh" ] && ok "uninstall.sh 已生成" || bad "uninstall.sh 缺失"
for d in agents seats sandbox; do
  [ -d "$M/$d" ] || bad "缺目录 $M/$d"
done
[ -f "$FAKE_HOME/.config/systemd/user/mapr-helper.service" ] && note "写进了 systemd（不该发生：总线已屏蔽）" || true
[ -f "$FAKE_HOME/.config/autostart/mapr-helper.desktop" ] && ok "回退桌面自启项已写入" || bad "没有任何自启项"

say_section "3. mapr up 可达性（WP2 状态检查）"
sleep 1
if curl -fsS --max-time 2 http://127.0.0.1:8790/api/hello >/dev/null 2>&1; then
  ok "本机助手已在 8790 响应 /api/hello"
elif grep -qE 'unknown_command|not implemented' "$M/helper.log" 2>/dev/null; then
  note "mapr up 走到 cli.ts 但 WP2 未实现（helper.log: $(tail -n 1 "$M/helper.log")）"
else
  bad "mapr up 没起来且不是已知 WP2 桩；helper.log: $(tail -n 3 "$M/helper.log" 2>/dev/null)"
fi
pkill -f "$M/pkg/src/cli.ts" 2>/dev/null || true

say_section "4. 重复安装（幂等）"
echo sentinel > "$M/helper.json"   # 模拟已配对数据，验证不被覆盖
sh "$INSTALL_SH" >"$WORK/install2.log" 2>&1
[ "$?" = "0" ] && ok "第二次 install 退出码 0" || bad "第二次 install 退出码非 0"
[ "$(cat "$M/helper.json" 2>/dev/null)" = "sentinel" ] && ok "helper.json 数据保留" || bad "helper.json 被覆盖"
pkill -f "$M/pkg/src/cli.ts" 2>/dev/null || true

say_section "5. mapr uninstall（保留数据）"
"$M/bin/mapr" uninstall >"$WORK/uninst.log" 2>&1 || true
cat "$WORK/uninst.log"
[ ! -e "$FAKE_HOME/.config/autostart/mapr-helper.desktop" ] && ok "自启项已撤" || bad "自启项仍在"
[ ! -e "$M/bin/mapr" ] && ok "mapr 命令已撤" || bad "mapr 仍在"
[ -f "$M/helper.json" ] && ok "数据保留（helper.json 还在）" || bad "数据被误删"

say_section "6. 重装 + --purge --yes"
sh "$INSTALL_SH" >/dev/null 2>&1 || { bad "重装失败"; exit 1; }
sh "$INSTALL_SH" --purge --yes >"$WORK/purge.log" 2>&1 || true
cat "$WORK/purge.log"
[ ! -d "$M" ] && ok "--purge 后 $M 已删除" || bad "--purge 后目录仍在"

say_section "汇总"
printf 'PASS=%d WARN=%d FAIL=%d\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" = "0" ]
