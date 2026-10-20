#!/usr/bin/env bash
#
# 部署前环境自检 —— V1.48
#
# 在**公司目标 Linux 服务器**上跑。它把执行方案 §9.A 里"由实施同事确认"的那一串，
# 变成一次可复制的输出：架构、Docker 版本、Compose 版本（!override 要 2.24.4+）、
# 资源、端口占用、以及 Linky / GitLab / 模型三条出网能力。
#
# 全部只读，不装东西、不改配置。
#
# 用法：
#   bash deploy/supabase-selfhost/scripts/preflight.sh
#   GITLAB_BASE_URL=https://gitlab.corp MODEL_BASE_URL=https://model.corp bash .../preflight.sh

set -uo pipefail

LINKY_URL="${LINKY_API_BASE_URL:-https://linky.kingdee.com/quality-platform/api/linky}"
GITLAB_URL="${GITLAB_BASE_URL:-}"
MODEL_URL="${MODEL_BASE_URL:-}"

ok() { printf '  ✅ %s\n' "$*"; }
no() { printf '  ❌ %s\n' "$*"; }
info() { printf '  ·  %s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }

head2 "主机"
info "hostname: $(hostname)"
info "内核/架构: $(uname -srm)"
if [ -r /etc/os-release ]; then
  info "发行版: $(. /etc/os-release && echo "$PRETTY_NAME")"
fi
info "CPU 核数: $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 未知)"
info "内存: $(free -h 2>/dev/null | awk '/^Mem:/{print $2" 总 / "$7" 可用"}' || echo 未知)"
info "磁盘(/srv 或 /): $(df -h /srv 2>/dev/null || df -h /)"

# Supabase 官方推荐 4 核 / 8GB+ / 80GB+ SSD；与 Worker 同机还要额外留代码快照缓存。
# 测不到就如实说"测不到"，不要拿一个没测出来的值报红 —— 那会让人去修一个不存在的问题。
CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "")
MEM_GB=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || echo "")
if [ -z "$CORES" ]; then
  info "CPU 核数无法测量（这个脚本面向 Linux；非 Linux 上请手工确认 ≥ 4 核）"
elif [ "$CORES" -ge 4 ]; then
  ok "CPU 核数 ${CORES} ≥ 4"
else
  no "CPU 核数 ${CORES} < 4（官方推荐 4 核，与 Worker 同机建议更多）"
fi
if [ -z "$MEM_GB" ]; then
  info "内存无法测量（非 Linux 上请手工确认 ≥ 8GB）"
elif [ "$MEM_GB" -ge 8 ]; then
  ok "内存 ${MEM_GB}GB ≥ 8GB"
else
  no "内存 ${MEM_GB}GB < 8GB（Supabase + Worker 同机偏紧）"
fi

head2 "Docker"
if command -v docker >/dev/null; then
  ok "docker: $(docker --version)"
  if docker info >/dev/null 2>&1; then
    ok "当前用户可用 docker（无需 sudo）"
  else
    no "当前用户不能用 docker：加入 docker 组或用 sudo 部署"
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_VER=$(docker compose version --short 2>/dev/null)
    ok "docker compose: ${COMPOSE_VER}"
    # !override 需要 2.24.4+。版本不够时 ports 会合并而不是替换，
    # 后果是 Supabase 的 8000 仍然暴露在 0.0.0.0，而部署看起来是成功的。
    if printf '%s\n2.24.4\n' "$COMPOSE_VER" | sort -V | head -1 | grep -qx "2.24.4"; then
      ok "Compose ≥ 2.24.4，支持 ports: !override"
    else
      no "Compose < 2.24.4：docker-compose.crp.yml 的 !override 不生效，端口不会被收到回环"
    fi
  else
    no "没有 docker compose v2（compose-plugin）"
  fi
  if systemctl is-enabled docker >/dev/null 2>&1; then
    ok "docker 已设开机自启"
  else
    no "docker 未设开机自启：服务器重启后平台不会自己回来"
  fi
else
  no "没装 docker"
fi

head2 "Node（MCP 需要）"
if command -v node >/dev/null; then
  NODE_V=$(node -v)
  ok "node: ${NODE_V}（which: $(command -v node)）"
  MAJOR=${NODE_V#v}; MAJOR=${MAJOR%%.*}
  [ "${MAJOR:-0}" -ge 20 ] && ok "Node ≥ 20" || no "Node < 20：MCP 依赖的 SDK 需要 20+"
else
  no "没装 node（MCP 作为 systemd 进程时需要）"
fi

head2 "端口占用（需要空闲：54341-54344 回环、443）"
for port in 54341 54342 54343 54344 443; do
  if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${port} "; then
    no "端口 ${port} 已被占用"
  else
    ok "端口 ${port} 空闲"
  fi
done

head2 "出网连通性（Worker 必须能到这三类）"
probe() {
  local label="$1" url="$2"
  [ -z "$url" ] && { info "${label}: 未提供 URL，跳过（部署人员补齐）"; return; }
  local code
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null)
  if [ "$code" != "000" ] && [ -n "$code" ]; then
    ok "${label} 可达（HTTP ${code}）：${url}"
  else
    no "${label} 不可达：${url}（Worker 会在导入/快照/评审阶段失败）"
  fi
}
probe "Linky 取数接口" "${LINKY_URL}/stories?page=1&page_size=1"
probe "GitLab" "$GITLAB_URL"
probe "模型端点" "$MODEL_URL"

probe "镜像仓库（docker hub / ecr 任一）" "https://public.ecr.aws"

printf '\n把以上输出贴进执行方案 §10 的"尚未完成"清单里，逐条勾掉。\n'
printf '❌ 项必须先解决或在方案里写明替代做法，不要带着红叉继续部署。\n'
