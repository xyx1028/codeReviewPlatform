#!/usr/bin/env bash
#
# 不中断在途任务的 Worker 发布 / 重启。
#
# 为什么需要这个脚本：`docker compose up -d --force-recreate` 会**销毁**正在跑 attempt 的
# 容器。一个 attempt 的模型时间是 20~40 分钟，被销毁之后平台只能 `agent_attempt+1` 从零
# 重跑（真实事故：2026-09-17 19:59 一次 --force-recreate 让 8 个在途 attempt 变成
# WORKER_LOST，浪费 47.9 分钟模型时间和对应 token）。
#
# 正确顺序只有一种：
#   1. 让全部副本停止领取新任务（写共享卷上的 DRAIN sentinel）；
#   2. 等到每个副本的在途 attempt 归零（等它们自己跑完并提交，不打断）；
#   3. 这时才重建容器；
#   4. 删掉 sentinel，新副本开始领取。
#
# 用法：
#   scripts/worker-drain-restart.sh                      # 云端配置池，副本数保持不变
#   scripts/worker-drain-restart.sh --scale 8            # 同时调整副本数
#   scripts/worker-drain-restart.sh --project codereviewplatform-local --env-file .docker/worker.local.env --scale 1
#   scripts/worker-drain-restart.sh --build              # 重建镜像（本地验证用）
#   scripts/worker-drain-restart.sh --drain-only         # 只排空，不重建（用于观察或手动介入）
#   scripts/worker-drain-restart.sh --lift-only          # 只解除 drain
#   scripts/worker-drain-restart.sh --skip-drain         # 跳过排空直接重建（见下）
#   scripts/worker-drain-restart.sh --timeout 5400       # 等待上限（秒），默认 3600
#   scripts/worker-drain-restart.sh --compose-file docker-compose.worker.yml \
#     --compose-file deploy/supabase-selfhost/worker.override.yml  # 可重复叠加 Compose
#
# `--skip-drain` 只有一个正当用途：**首次**部署带 drain 能力的镜像。在那之前池子里跑的是
# 不认识 DRAIN sentinel 的旧镜像，它们永远不会写出 DRAINED 标记，脚本只会白等到超时。
# 用它之前必须自己确认没有在途任务，否则就退化成 `--force-recreate` 那种摧毁式发布。
#
# 脚本本身只做可逆动作：写/删 sentinel 文件、等待、以及最后那一次 compose up。
set -euo pipefail

PROJECT="codereviewplatform"
ENV_FILE=".docker/worker.env"
COMPOSE_FILES=()
SCALE=""
BUILD_FLAG="--no-build"
TIMEOUT=3600
POLL_SECONDS=10
MODE="restart"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILES+=("$2"); shift 2 ;;
    --scale) SCALE="$2"; shift 2 ;;
    --build) BUILD_FLAG="--build"; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --poll) POLL_SECONDS="$2"; shift 2 ;;
    --drain-only) MODE="drain-only"; shift ;;
    --lift-only) MODE="lift-only"; shift ;;
    --skip-drain) MODE="skip-drain"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# 默认仍使用原来的单 Compose 文件；Linux 自部署可重复传 --compose-file
# 叠加固定网络与统一镜像覆盖层。
if [[ ${#COMPOSE_FILES[@]} -eq 0 ]]; then
  COMPOSE_FILES=("docker-compose.worker.yml")
fi
COMPOSE_ARGS=()
for compose_file in "${COMPOSE_FILES[@]}"; do
  COMPOSE_ARGS+=( -f "$compose_file" )
done

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_ARGS[@]}" "$@"
}

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# 当前项目里在跑的 worker 容器。WORKER_ID = worker-<容器 hostname> = worker-<短 id>。
containers() {
  docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
            --filter "label=com.docker.compose.service=worker" \
            --format '{{.ID}}'
}

worker_ids() {
  local id
  for id in $(containers); do
    printf 'worker-%s\n' "$(docker inspect -f '{{.Config.Hostname}}' "$id")"
  done
}

any_container() { containers | head -1; }

# sentinel 与 drained 标记都落在共享的 worker-jobs 卷（WORKSPACE_ROOT）上，
# 所以从任意一个副本里就能读到全部副本的状态。
WORKSPACE_ROOT_DEFAULT="/workspace/jobs"
workspace_root() {
  local c="$1"
  docker exec "$c" sh -c 'printf "%s" "${WORKSPACE_ROOT:-/workspace/jobs}"' 2>/dev/null \
    || printf '%s' "$WORKSPACE_ROOT_DEFAULT"
}

lift_drain() {
  local c
  c="$(any_container)" || true
  if [[ -z "${c:-}" ]]; then
    log "没有运行中的 worker 容器，无法删除 sentinel；新容器起来后请手动执行 rm。"
    return 0
  fi
  local root; root="$(workspace_root "$c")"
  docker exec "$c" sh -c "rm -f '${root}/DRAIN' '${root}'/DRAIN.* || true"
  log "已删除 DRAIN sentinel：副本恢复领取任务。"
}

if [[ "$MODE" == "lift-only" ]]; then
  lift_drain
  exit 0
fi

MAIN_CONTAINER="$(any_container || true)"
if [[ -z "${MAIN_CONTAINER:-}" ]]; then
  log "项目 ${PROJECT} 下没有运行中的 worker 容器：没有在途任务需要保护，直接启动即可。"
  if [[ "$MODE" == "restart" ]]; then
    WORKER_ENV_FILE="$ENV_FILE" compose \
      up -d $BUILD_FLAG ${SCALE:+--scale worker=$SCALE}
  fi
  exit 0
fi

ROOT="$(workspace_root "$MAIN_CONTAINER")"
EXPECTED_IDS="$(worker_ids | sort)"
EXPECTED_COUNT="$(printf '%s\n' "$EXPECTED_IDS" | grep -c . || true)"
log "项目 ${PROJECT}：${EXPECTED_COUNT} 个副本，WORKSPACE_ROOT=${ROOT}"

# 0) 清掉已经不存在的副本留下的 DRAINED 标记。
#
# WORKER_ID 派生自容器 hostname，容器一重建就换 id，所以卷上会堆积历史标记。它们不会
# 让本脚本误判（下面按当前副本 id 逐个核对），但会让人工 `ls` 时看不清现状，而这个文件
# 恰恰是发布时"能不能重建"的唯一判据。
purge_stale_markers() {
  local current="$1"
  local existing wid
  existing="$(docker exec "$MAIN_CONTAINER" sh -c "ls -1 '${ROOT}' 2>/dev/null | sed -n 's/^DRAINED\\.//p'" || true)"
  while IFS= read -r wid; do
    [[ -z "$wid" ]] && continue
    if ! printf '%s\n' "$current" | grep -qx "$wid"; then
      docker exec "$MAIN_CONTAINER" sh -c "rm -f '${ROOT}/DRAINED.${wid}'" || true
      log "清理历史标记 DRAINED.${wid}（该副本已不存在）"
    fi
  done <<< "$existing"
}
purge_stale_markers "$EXPECTED_IDS"

if [[ "$MODE" == "skip-drain" ]]; then
  log "⚠️  --skip-drain：跳过排空，直接重建 ${EXPECTED_COUNT} 个副本。"
  log "⚠️  只有在你已经确认「没有在途任务」时这才是安全的（首次部署 drain 能力时的唯一通道）。"
  WORKER_ENV_FILE="$ENV_FILE" compose \
    up -d $BUILD_FLAG --force-recreate ${SCALE:+--scale worker=$SCALE}
  sleep 5
  lift_drain
  MAIN_CONTAINER="$(any_container || true)"
  if [[ -n "${MAIN_CONTAINER:-}" ]]; then
    purge_stale_markers "$(worker_ids | sort)"
  fi
  log "完成。下一次发布就可以用不带 --skip-drain 的正常流程了。"
  exit 0
fi

# 1) 写 sentinel：全副本停止领取。这一步不会打断任何在跑的 attempt。
docker exec "$MAIN_CONTAINER" sh -c "touch '${ROOT}/DRAIN'"
log "已写入 ${ROOT}/DRAIN：全部副本将在 5 秒内停止领取新任务（在途任务继续跑完）。"

# 2) 等待每个副本写出 DRAINED.<worker-id>。
deadline=$(( $(date +%s) + TIMEOUT ))
started_at=$(date +%s)
legacy_hinted=0
while :; do
  drained_list="$(docker exec "$MAIN_CONTAINER" sh -c "ls -1 '${ROOT}' 2>/dev/null | sed -n 's/^DRAINED\\.//p'" | sort || true)"
  remaining=""
  drained_now=0
  while IFS= read -r wid; do
    [[ -z "$wid" ]] && continue
    if printf '%s\n' "$drained_list" | grep -qx "$wid"; then
      drained_now=$(( drained_now + 1 ))
    else
      remaining="${remaining}${wid} "
    fi
  done <<< "$EXPECTED_IDS"

  log "已排空 ${drained_now}/${EXPECTED_COUNT}；仍在跑：${remaining:-无}"
  if [[ "$drained_now" -ge "$EXPECTED_COUNT" ]]; then
    log "全部副本在途任务归零。"
    break
  fi

  # 一个副本都没写出标记，说明它们很可能是**不支持 drain 的旧镜像** —— 那种情况下
  # 再等下去只会白等到超时。提示一次，但不自动放弃：真的有长任务在跑时，等待才是对的。
  if [[ "$drained_now" -eq 0 && "$legacy_hinted" -eq 0 ]] \
     && [[ $(( $(date +%s) - started_at )) -ge 60 ]]; then
    legacy_hinted=1
    log "提示：60 秒内没有任何副本写出 DRAINED 标记。"
    log "      如果这些副本是首次升级前的旧镜像（不认识 DRAIN sentinel），它们永远不会写。"
    log "      自检：docker exec ${MAIN_CONTAINER} sh -c 'grep -c worker_drain_started dist-worker/index.js'"
    log "      结果为 0 就是旧镜像：确认没有在途任务后改用 --skip-drain 重跑本脚本。"
  fi

  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    log "等待超时（${TIMEOUT}s）。仍有副本在跑任务，**没有**执行重建。"
    log "可以继续等（重跑本脚本），或确认可以放弃这些 attempt 后自行重建。"
    log "放弃 drain：scripts/worker-drain-restart.sh --lift-only"
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

if [[ "$MODE" == "drain-only" ]]; then
  log "drain-only：池子已排空且仍在运行。重建前请保持 DRAIN sentinel 存在。"
  exit 0
fi

# 3) 现在重建是安全的：没有任何 attempt 在跑，也没有任何 claim 被持有。
log "重建容器…"
WORKER_ENV_FILE="$ENV_FILE" compose \
  up -d $BUILD_FLAG --force-recreate ${SCALE:+--scale worker=$SCALE}

# 4) 新容器起来后删掉 sentinel，否则它们会继承 drain 状态、永远不领任务。
sleep 5
lift_drain

# 5) 旧副本的 DRAINED 标记随容器一起作废，清掉它们。
MAIN_CONTAINER="$(any_container || true)"
if [[ -n "${MAIN_CONTAINER:-}" ]]; then
  purge_stale_markers "$(worker_ids | sort)"
fi

log "完成。校验："
log "  docker compose -p ${PROJECT} ${COMPOSE_ARGS[*]} ps"
log "  docker logs --tail 20 \$(docker ps -q --filter label=com.docker.compose.project=${PROJECT} | head -1)"
