#!/bin/bash
# 安装 Mac 宿主机模型代理为 launchd 常驻服务（V1.7）。
#
# 只需执行一次。之后登录 Mac 即自动启动，异常退出由 launchd 重启。
# 代理凭据随机生成，写入 launchd plist（0600）与 .docker/worker.env（Git 已忽略）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.codereviewplatform.model-vpn-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/codereviewplatform"
WORKER_ENV="$REPO_ROOT/.docker/worker.env"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PROXY_PORT="${MODEL_VPN_PROXY_PORT:-17890}"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found; install Node.js or set NODE_BIN" >&2
  exit 1
fi
if [[ ! -f "$WORKER_ENV" ]]; then
  echo "missing $WORKER_ENV; copy .docker/worker.env.example first" >&2
  exit 1
fi

# 已存在的凭据保持不变，避免每次安装都要同步更新 Worker 配置。
existing_user="$(sed -n 's/^MODEL_CONNECTIVITY_PROXY_USERNAME=\(.*\)$/\1/p' "$WORKER_ENV" | tail -n 1)"
existing_pass="$(sed -n 's/^MODEL_CONNECTIVITY_PROXY_PASSWORD=\(.*\)$/\1/p' "$WORKER_ENV" | tail -n 1)"
PROXY_USERNAME="${existing_user:-worker}"
if [[ -n "$existing_pass" ]]; then
  PROXY_PASSWORD="$existing_pass"
else
  # openssl 而不是 `tr </dev/urandom | head`：后者会让 tr 收到 SIGPIPE，在 pipefail 下
  # 整个安装脚本以 141 静默退出。
  PROXY_PASSWORD="$(openssl rand -hex 24)"
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_ROOT/scripts/model-vpn-proxy.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MODEL_VPN_PROXY_BIND</key><string>127.0.0.1</string>
    <key>MODEL_VPN_PROXY_PORT</key><string>$PROXY_PORT</string>
    <key>MODEL_VPN_PROXY_ALLOWED_PORTS</key><string>${MODEL_VPN_PROXY_ALLOWED_PORTS:-80,443}</string>
    <key>MODEL_VPN_PROXY_USERNAME</key><string>$PROXY_USERNAME</string>
    <key>MODEL_VPN_PROXY_PASSWORD</key><string>$PROXY_PASSWORD</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/model-vpn-proxy.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/model-vpn-proxy.error.log</string>
</dict>
</plist>
PLIST_EOF

# plist 内含代理口令，权限收到仅本人可读。
chmod 600 "$PLIST"

# 写入/更新 Worker 侧配置。Docker 通过 host.docker.internal 访问宿主机代理。
python3 - "$WORKER_ENV" "$PROXY_PORT" "$PROXY_USERNAME" "$PROXY_PASSWORD" <<'PY_EOF'
import sys

path, port, user, password = sys.argv[1:5]
settings = {
    'MODEL_CONNECTIVITY_PROXY_URL': f'http://host.docker.internal:{port}',
    'MODEL_CONNECTIVITY_PROXY_USERNAME': user,
    'MODEL_CONNECTIVITY_PROXY_PASSWORD': password,
}
with open(path, 'r', encoding='utf-8') as handle:
    lines = handle.read().splitlines()

kept = [line for line in lines if line.split('=', 1)[0] not in settings]
while kept and kept[-1].strip() == '':
    kept.pop()
kept.append('')
kept.append('# V1.7：Docker Worker 经 Mac 宿主机代理访问公司内网模型（由安装脚本维护）。')
kept.extend(f'{key}={value}' for key, value in settings.items())
with open(path, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(kept) + '\n')
PY_EOF
chmod 600 "$WORKER_ENV"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "installed $LABEL on 127.0.0.1:$PROXY_PORT (allowed ports: ${MODEL_VPN_PROXY_ALLOWED_PORTS:-80,443})"
echo "worker config updated: $WORKER_ENV"
echo "logs: $LOG_DIR/model-vpn-proxy.log"
