#!/usr/bin/env bash
# 公司 Linux 的统一发布入口。
#
# 它协调已有的迁移/Functions 发布脚本、Worker drain 与统一应用镜像：
#   release 同步 -> 迁移/Functions -> 拉镜像 -> Worker 排空更新 -> Web 更新 -> 健康检查。
# 默认 --dry-run 只预览迁移并校验 Compose，不修改数据库、Function、容器或镜像。
# 真实发布必须显式传 --apply 和 CI 产物镜像引用。

set -euo pipefail
set +x

mode='--dry-run'
image=''
worker_timeout=3600

usage() {
  cat <<'USAGE'
用法：
  bash deploy/supabase-selfhost/scripts/release.sh --dry-run [--image <CI镜像>]
  bash deploy/supabase-selfhost/scripts/release.sh --apply [--image <CI镜像>]

示例：
  bash deploy/supabase-selfhost/scripts/release.sh --apply \
    --image mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review:release_202610161013071

参数：
  --dry-run                 仅预览数据库迁移并校验配置（默认）
  --apply                   同步 release、执行迁移/Functions、更新 Worker 和 Web
  --image <镜像>            指定本次 CI 产物；省略时自动选 Nexus 中最新 release_ 时间戳标签
  --worker-timeout <秒>     Worker 排空最大等待时间，默认 3600
  -h, --help                显示帮助

注意：真实发布仍会在 Supabase CLI 处要求确认数据库迁移。自动选镜像只筛选
      kingdee/lingee/patch/kwork-code-review 的 release_数字标签，不会选 cache 镜像。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--apply) mode="$1"; shift ;;
    --image) image="${2:-}"; shift 2 ;;
    --worker-timeout) worker_timeout="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../../.." && pwd)"
script_path="$script_dir/$(basename -- "${BASH_SOURCE[0]}")"
supabase_dir="${CRP_SUPABASE_DIR:-/home/kduser/crp/supabase}"
web_runtime_config="${CRP_WEB_RUNTIME_CONFIG:-/home/kduser/crp/web/runtime-config.js}"
worker_env_file="${CRP_WORKER_ENV_FILE:-.docker/worker.selfhost.env}"
state_file="${CRP_RELEASE_STATE_FILE:-/home/kduser/crp/last-release.env}"
expected_origin='https://git.kingdee.com/kwork-code-review/kwork-code-review.git'
nexus_api="${CRP_NEXUS_API:-https://mirrors.kingdee.com/service/rest/v1/search}"
nexus_repository="${CRP_NEXUS_REPOSITORY:-docker-hosted}"
nexus_component='kingdee/lingee/patch/kwork-code-review'
nexus_registry='mirrors.kingdee.com'

for command_name in git docker flock curl sha256sum python3; do
  command -v "$command_name" >/dev/null || { echo "缺少命令：$command_name" >&2; exit 1; }
done
docker compose version >/dev/null || { echo 'Docker Compose v2 不可用。' >&2; exit 1; }

resolve_latest_image() {
  local payload tag
  payload="$(curl -fsS --max-time 20 -G "$nexus_api" \
    --data-urlencode "repository=$nexus_repository" \
    --data-urlencode 'format=docker' \
    --data-urlencode "name=$nexus_component")" || return 1
  tag="$(NEXUS_PAYLOAD="$payload" python3 - "$nexus_component" <<'PY'
import json
import os
import re
import sys

component = sys.argv[1]
payload = json.loads(os.environ['NEXUS_PAYLOAD'])
tags = [
    item.get('version', '')
    for item in payload.get('items', [])
    if item.get('name') == component
    and re.fullmatch(r'release_[0-9]{15}', item.get('version', ''))
]
if tags:
    print(max(tags))
PY
)" || return 1
  [[ -n "$tag" ]] || return 1
  printf '%s:%s' "$nexus_registry/$nexus_component" "$tag"
}

if [[ -z "$image" ]]; then
  echo '未指定镜像，查询 Nexus 中最新的 release_ 时间戳镜像…'
  image="$(resolve_latest_image || true)"
  if [[ -n "$image" ]]; then
    echo "已自动选择：$image"
  elif [[ -t 0 ]]; then
    read -r -p '自动查询失败；请输入本次 CI 成功产物的完整镜像地址：' image
  else
    echo '无法查询 Nexus，且非交互调用未传 --image。' >&2
    exit 1
  fi
fi
[[ -n "$image" ]] || { echo '镜像地址不能为空。' >&2; exit 2; }
[[ "$worker_timeout" =~ ^[1-9][0-9]*$ ]] || { echo '--worker-timeout 必须是正整数秒。' >&2; exit 2; }
[[ -f "$supabase_dir/docker-compose.yml" ]] || { echo "找不到 Supabase 目录：$supabase_dir" >&2; exit 1; }
[[ -f "$web_runtime_config" ]] || {
  echo "找不到浏览器运行配置：$web_runtime_config" >&2
  echo '请先从 frontend.runtime-config*.js.example 创建它；不要把服务端密钥写入该文件。' >&2
  exit 1
}

cd "$repo_dir"
[[ "$(git rev-parse --show-toplevel)" == "$repo_dir" ]] || { echo '脚本必须从应用仓库工作树运行。' >&2; exit 1; }
[[ "$(git remote get-url origin 2>/dev/null || true)" == "$expected_origin" ]] || {
  echo "origin 不是预期的 GitLab 仓库：$(git remote get-url origin 2>/dev/null || echo 未设置)" >&2
  exit 1
}

exec 9>"$repo_dir/../.crp-platform-release.lock"
flock -n 9 || { echo '另一轮平台发布正在运行。' >&2; exit 1; }

# clone、fetch 与 apply-migrations.sh 共用进程外的 30 分钟内存 credential cache，
# 不把 GitLab 密码或 Token 写入磁盘。关闭平台发布锁 FD，避免凭据缓存守护进程继承它。
git_cached() { git -c credential.helper= -c 'credential.helper=cache --timeout=1800' "$@" 9>&-; }

web_compose() {
  CRP_APP_IMAGE="$image" CRP_WEB_RUNTIME_CONFIG="$web_runtime_config" \
    docker compose -p crp-selfhost-web \
      -f deploy/supabase-selfhost/docker-compose.web.yml "$@"
}

worker_compose() {
  CRP_APP_IMAGE="$image" WORKER_ENV_FILE="$worker_env_file" \
    docker compose -p crp-selfhost-worker \
      -f docker-compose.worker.yml \
      -f deploy/supabase-selfhost/worker.override.yml \
      -f deploy/supabase-selfhost/worker.image.yml "$@"
}

validate_compose() {
  [[ -f "$worker_env_file" ]] || { echo "找不到 Worker 环境文件：$worker_env_file" >&2; exit 1; }
  docker network inspect crp-selfhost-net >/dev/null || { echo '找不到 crp-selfhost-net。先启动 Supabase。' >&2; exit 1; }
  web_compose config --quiet
  worker_compose config --quiet
}

sync_release() {
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo '应用仓库存在已跟踪的未提交修改；为防止覆盖，已停止。' >&2
    git status --short >&2
    exit 1
  fi

  local before_hash after_hash
  before_hash="$(sha256sum "$script_path" | awk '{print $1}')"
  echo '同步 GitLab release（首次可能提示输入一次账号和密码）…'
  git_cached fetch origin release
  git checkout release
  git merge --ff-only origin/release
  after_hash="$(sha256sum "$script_path" | awk '{print $1}')"

  # 让“脚本也更新”成为同一次发布的一部分；最多重启一次，避免循环。
  if [[ "$before_hash" != "$after_hash" && "${CRP_RELEASE_REEXEC:-}" != 1 ]]; then
    echo '总发布脚本已随 release 更新，使用新版本继续本次发布…'
    exec env CRP_RELEASE_REEXEC=1 bash "$script_path" --apply --image "$image" --worker-timeout "$worker_timeout"
  fi
}

wait_for_web() {
  local attempt body
  for attempt in {1..30}; do
    body="$(curl -fsS --max-time 3 http://127.0.0.1:4180/__health 2>/dev/null || true)"
    if [[ "$body" == 'ok' ]]; then
      echo 'Web 健康检查通过。'
      return 0
    fi
    sleep 1
  done
  echo 'Web 健康检查失败：127.0.0.1:4180/__health 未返回 ok。' >&2
  return 1
}

verify_worker() {
  local worker_id
  worker_id="$(docker ps -q \
    --filter label=com.docker.compose.project=crp-selfhost-worker \
    --filter label=com.docker.compose.service=worker | head -n 1)"
  [[ -n "$worker_id" ]] || { echo 'Worker 容器未运行。' >&2; return 1; }
  docker inspect --format '{{.State.Status}}' "$worker_id" | grep -qx running || {
    echo 'Worker 容器不是 running 状态。' >&2; return 1;
  }
  if ! docker logs --tail 100 "$worker_id" 2>&1 | grep -q '"event":"worker_started"'; then
    echo 'Worker 未观察到 worker_started 日志。' >&2
    docker logs --tail 100 "$worker_id" >&2 || true
    return 1
  fi
  echo 'Worker 启动检查通过。'
}

write_state() {
  local previous_image=''
  if [[ -r "$state_file" ]]; then
    previous_image="$(sed -n 's/^CURRENT_IMAGE=//p' "$state_file" | head -n 1 || true)"
  fi
  umask 077
  mkdir -p "$(dirname -- "$state_file")"
  cat >"$state_file" <<EOF_STATE
# 由 release.sh 写入；不含密钥。
CURRENT_IMAGE=$image
PREVIOUS_IMAGE=$previous_image
RELEASE_COMMIT=$(git rev-parse --short HEAD)
DEPLOYED_AT_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF_STATE
  echo "发布记录已写入：$state_file"
}

if [[ "$mode" == '--dry-run' ]]; then
  echo "预览模式：当前应用代码版本 $(git rev-parse --short HEAD)，不会同步工作树或更新容器。"
  validate_compose
  bash deploy/supabase-selfhost/scripts/apply-migrations.sh --dry-run
  echo '预览完成。确认后执行相同命令并把 --dry-run 改为 --apply。'
  exit 0
fi

sync_release
validate_compose

echo "开始发布应用镜像：$image"
echo '第 1/4 步：数据库增量迁移与 Edge Functions…'
bash deploy/supabase-selfhost/scripts/apply-migrations.sh --apply

echo '第 2/4 步：拉取同一应用镜像供 Worker 与 Web 使用…'
worker_compose pull worker
web_compose pull web

echo '第 3/4 步：排空在途任务后更新 Worker…'
bash scripts/worker-drain-restart.sh \
  --project crp-selfhost-worker \
  --env-file "$worker_env_file" \
  --compose-file docker-compose.worker.yml \
  --compose-file deploy/supabase-selfhost/worker.override.yml \
  --compose-file deploy/supabase-selfhost/worker.image.yml \
  --scale 1 \
  --timeout "$worker_timeout"
verify_worker

echo '第 4/4 步：更新 Web…'
web_compose up -d --no-build --force-recreate web
wait_for_web
write_state

echo "发布完成：代码 $(git rev-parse --short HEAD)，镜像 $image"
