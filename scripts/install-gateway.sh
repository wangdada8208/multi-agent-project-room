#!/bin/bash
# Multi-Agent Project Room — One-click Gateway Installer
# Usage: bash <(curl -sL https://raw.githubusercontent.com/wangdada8208/multi-agent-project-room/main/scripts/install-gateway.sh)

set -e

echo "🤖 Multi-Agent Project Room — Gateway 安装器"
echo "============================================"

# Check for required tools
check_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "❌ 未找到 $1，请先安装。"
    echo "   macOS: brew install $2"
    exit 1
  fi
}

check_cmd python3 "python3"
check_cmd git "git"

# Prompt for server URL
DEFAULT_SERVER="https://hub.wangdada8208.xyz"
read -p "服务器地址 [$DEFAULT_SERVER]: " SERVER_URL
SERVER_URL="${SERVER_URL:-$DEFAULT_SERVER}"

# Prompt for agent name
read -p "Agent 名称 [Claude]: " AGENT_NAME
AGENT_NAME="${AGENT_NAME:-Claude}"

INSTALL_DIR="$HOME/.mapr-gateway"

echo ""
echo "📦 安装到 $INSTALL_DIR ..."

if [ -d "$INSTALL_DIR" ]; then
  echo "  已存在，更新中..."
  cd "$INSTALL_DIR" && git pull --rebase
else
  git clone https://github.com/wangdada8208/multi-agent-project-room.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# Setup venv
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -r backend/requirements.txt -q 2>/dev/null || pip install -r backend/requirements.txt

echo ""
echo "✅ 安装完成！"
echo ""
echo "启动你的 Agent："
echo "  cd $INSTALL_DIR"
echo "  source .venv/bin/activate"
echo "  python3 local_agent_adapter.py --server $SERVER_URL --agent-name $AGENT_NAME"
echo ""
echo "或者使用轻量网关（ACP 模式）："
echo "  cd $INSTALL_DIR"
echo "  source .venv/bin/activate"
echo "  python3 agent_gateway.py --server $SERVER_URL --agent-name $AGENT_NAME"
