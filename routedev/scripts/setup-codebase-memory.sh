#!/usr/bin/env bash
# scripts/setup-codebase-memory.sh
# Phase 36 Task 1：codebase-memory-mcp 安装辅助脚本
#
# 功能：检测系统架构 → 下载对应平台的 codebase-memory 二进制文件 → 设置执行权限
#
# codebase-memory-mcp 是纯 C 实现的代码智能 MCP 服务器：
#   - tree-sitter 解析 158 种语言
#   - SQLite 知识图谱存储
#   - 14 个 MCP 工具（调用链/影响分析/死代码检测/社区发现等）
#   - stdio 传输，与 RouteDev MCP 客户端天然兼容
#
# 用法：bash scripts/setup-codebase-memory.sh

set -euo pipefail

# ===== 配置 =====
REPO_OWNER="multica-ai"
REPO_NAME="codebase-memory-mcp"
INSTALL_DIR="${HOME}/.routedev/bin"
BINARY_NAME="codebase-memory"

# ===== 颜色输出 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ===== 检测系统架构 =====
detect_platform() {
  local os arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  # 标准化 OS 名称
  case "$os" in
    linux*)  os="linux" ;;
    darwin*) os="macos" ;;
    mingw*|msys*|cygwin*) os="windows" ;;
    *) error "不支持的操作系统: $os"; exit 1 ;;
  esac

  # 标准化架构名称
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "不支持的架构: $arch"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# ===== 下载二进制文件 =====
download_binary() {
  local platform="$1"
  local binary_ext=""
  local download_url

  # Windows 需要 .exe 后缀
  if [[ "$platform" == windows-* ]]; then
    binary_ext=".exe"
  fi

  # 构建下载 URL（假设 GitHub Releases 提供二进制下载）
  download_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/codebase-memory-${platform}${binary_ext}"

  info "下载平台: $platform"
  info "下载地址: $download_url"

  # 创建安装目录
  mkdir -p "$INSTALL_DIR"

  local target="${INSTALL_DIR}/${BINARY_NAME}${binary_ext}"

  # 下载（使用 curl 或 wget）
  if command -v curl &>/dev/null; then
    curl -L -o "$target" "$download_url" || {
      error "下载失败。请检查网络连接或手动下载: $download_url"
      exit 1
    }
  elif command -v wget &>/dev/null; then
    wget -O "$target" "$download_url" || {
      error "下载失败。请检查网络连接或手动下载: $download_url"
      exit 1
    }
  else
    error "未找到 curl 或 wget，请先安装其中之一"
    exit 1
  fi

  # 设置执行权限（非 Windows）
  if [[ "$platform" != windows-* ]]; then
    chmod +x "$target"
  fi

  info "安装完成: $target"
}

# ===== 验证安装 =====
verify_installation() {
  local platform="$1"
  local binary_ext=""
  local target

  if [[ "$platform" == windows-* ]]; then
    binary_ext=".exe"
  fi

  target="${INSTALL_DIR}/${BINARY_NAME}${binary_ext}"

  if [[ ! -f "$target" ]]; then
    error "二进制文件未找到: $target"
    exit 1
  fi

  # 尝试执行 --version
  if "$target" --version &>/dev/null; then
    info "验证成功: $("$target" --version 2>&1 || echo 'unknown version')"
  else
    warn "无法执行 --version，但文件已下载。可能需要手动验证。"
  fi
}

# ===== 提示配置 =====
show_config_hint() {
  local binary_path="${INSTALL_DIR}/${BINARY_NAME}"
  if [[ "$(detect_platform)" == windows-* ]]; then
    binary_path="${binary_path}.exe"
  fi

  cat <<EOF

${GREEN}===== 安装完成 =====${NC}

codebase-memory-mcp 已安装到: ${binary_path}

${YELLOW}下一步：在 RouteDev 配置中启用${NC}

在 config.yaml 的 mcp.servers 中添加或取消注释：

  mcp:
    autoConnect: true
    servers:
      - id: codebase-memory
        name: Codebase Memory
        enabled: true
        config:
          transport: stdio
          command: ${binary_path}
          args: ["--stdio"]

或者将 ${binary_path} 所在目录加入 PATH，然后使用 command: codebase-memory

${YELLOW}验证 MCP 连接${NC}

启动 RouteDev 后，使用 /status 命令查看 MCP 服务器连接状态。
codebase-memory-mcp 的 14 个工具会自动注册，命名空间为 mcp__codebase-memory__<toolName>

EOF
}

# ===== 主流程 =====
main() {
  info "codebase-memory-mcp 安装脚本"
  info "============================"

  # 1. 检测平台
  local platform
  platform="$(detect_platform)"
  info "检测到平台: $platform"

  # 2. 下载二进制
  download_binary "$platform"

  # 3. 验证安装
  verify_installation "$platform"

  # 4. 显示配置提示
  show_config_hint

  info "安装完成！"
}

main "$@"
