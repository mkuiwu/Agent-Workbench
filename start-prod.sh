#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ 错误：当前分支是 '$CURRENT_BRANCH'，只能在 main 分支部署生产模式"
  echo "   请切换到 main 分支后重试: git checkout main"
  exit 1
fi

echo "✅ 分支检查通过 (main)"

STAGED=$(git diff --cached --name-only)
UNSTAGED=$(git diff --name-only)
UNTRACKED=$(git ls-files --others --exclude-standard)
if [ -n "$STAGED" ] || [ -n "$UNSTAGED" ] || [ -n "$UNTRACKED" ]; then
  echo "⚠️  警告：存在未提交的变更"
  echo "已暂存：$STAGED"
  echo "未暂存：$UNSTAGED"
  echo "未跟踪：$UNTRACKED"
  read -p "是否继续部署？(y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "已取消"
    exit 0
  fi
fi

echo "📦 正在检查依赖..."
if ! pnpm install --frozen-lockfile; then
  echo "❌ 依赖安装失败"
  exit 1
fi

echo "📦 正在编译..."
pnpm build

echo "🚀 正在启动生产模式..."
pm2 start ecosystem.config.cjs --only agent-workbench --update-env

echo "✅ 生产模式已启动"
pm2 list
