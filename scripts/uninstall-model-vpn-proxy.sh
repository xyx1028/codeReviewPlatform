#!/bin/bash
# 卸载 Mac 宿主机模型代理的 launchd 服务（V1.7 回滚步骤）。
# 保留 .docker/worker.env，便于重新安装；如需彻底回滚，请手动删除其中的
# MODEL_CONNECTIVITY_PROXY_* 三项配置并重启 Worker。
set -euo pipefail

LABEL="com.codereviewplatform.model-vpn-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "removed $LABEL"
