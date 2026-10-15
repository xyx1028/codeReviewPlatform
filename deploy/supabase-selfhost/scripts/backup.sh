#!/usr/bin/env bash
#
# 内网自部署 Supabase 的备份 —— V1.48
#
# 备份四类东西，缺一类就恢复不出一个能用的平台：
#
#   1. 数据库全量（pg_dump，含 Vault 密文与 auth schema）
#   2. Storage 文件卷（需求附件、技能包归档）
#   3. 配置与密钥（.env / Compose override / functions 目录）
#   4. Worker 的 Session 卷（未提交 attempt 的续跑依据；丢了在途任务只能从零重跑）
#
# ⚠️ 这个脚本**只读**。它不会 stop、不会 down、不会带 -v、不会 reset。
# ⚠️ 备份产物含密钥与业务数据：落盘后必须复制到独立位置，并限制权限。
#
# 用法：
#   sudo -u crp bash deploy/supabase-selfhost/scripts/backup.sh
#   BACKUP_ROOT=/srv/crp/backups SUPABASE_DIR=/srv/crp/supabase bash .../backup.sh

set -euo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-/srv/crp/supabase}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/crp/backups}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
# 导出角色：自部署里 `postgres` **不是** superuser（rolsuper=f），用它导出的 dump
# 恢复时会在 vault.secrets 上报 permission denied —— 模型 API Key 静默丢失。
# supabase_admin 才是 superuser。实测：postgres 恢复 2 errors，supabase_admin 0 errors。
DB_SUPERUSER="${DB_SUPERUSER:-supabase_admin}"
STORAGE_VOLUME="${STORAGE_VOLUME:-}"
SESSION_VOLUME="${SESSION_VOLUME:-crp-selfhost-worker_worker-sessions}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="${BACKUP_ROOT}/${STAMP}"

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { printf '[backup][错误] %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "找不到 docker"
[ -d "$SUPABASE_DIR" ] || fail "Supabase 目录不存在：$SUPABASE_DIR"
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 \
  || fail "数据库容器 $DB_CONTAINER 不在运行（用 DB_CONTAINER=... 指定实际名字）"
docker exec "$DB_CONTAINER" psql -U "$DB_SUPERUSER" -tAc \
  "select rolsuper from pg_roles where rolname = current_user" 2>/dev/null | grep -qx t \
  || fail "$DB_SUPERUSER 不是 superuser：用它导出的备份恢复时会丢 vault.secrets（模型密钥）"

mkdir -p "$OUT"
chmod 700 "$OUT"

# ---------------------------------------------------------------------------
# 1. 数据库
#
# 用 pg_dumpall --roles-only + pg_dump -Fc：角色单独导是因为 Supabase 的
# authenticated / service_role / supabase_auth_admin 等角色是库外对象，
# 只 dump 一个库恢复出来会缺角色，RLS 直接失效。
# ---------------------------------------------------------------------------
log "导出数据库角色"
docker exec "$DB_CONTAINER" pg_dumpall -U "$DB_SUPERUSER" --roles-only > "${OUT}/roles.sql"

log "导出数据库全量（自定义格式）"
docker exec "$DB_CONTAINER" pg_dump -U "$DB_SUPERUSER" -d postgres -Fc > "${OUT}/postgres.dump"

# 体积为 0 就是失败，不要把空文件当备份留着
[ -s "${OUT}/postgres.dump" ] || fail "数据库导出为空，备份作废"

# ---------------------------------------------------------------------------
# 2. Storage 文件
# ---------------------------------------------------------------------------
if [ -d "${SUPABASE_DIR}/volumes/storage" ]; then
  log "打包 Storage 目录"
  tar -czf "${OUT}/storage.tar.gz" -C "${SUPABASE_DIR}/volumes" storage
elif [ -n "$STORAGE_VOLUME" ]; then
  log "打包 Storage 命名卷 ${STORAGE_VOLUME}"
  docker run --rm -v "${STORAGE_VOLUME}:/data:ro" -v "${OUT}:/out" alpine:3.21 \
    tar -czf /out/storage.tar.gz -C /data .
else
  log "警告：没找到 Storage 目录或卷，附件与技能包未备份"
fi

# ---------------------------------------------------------------------------
# 3. 配置与密钥（含 .env，所以整份备份都要当密钥对待）
# ---------------------------------------------------------------------------
log "打包配置与 functions"
tar -czf "${OUT}/config.tar.gz" -C "$SUPABASE_DIR" \
  --exclude='volumes/db/data' \
  --exclude='volumes/storage' \
  .

# ---------------------------------------------------------------------------
# 4. Worker Session 卷（可选：没有在途任务时它无所谓，有在途任务时它是唯一依据）
# ---------------------------------------------------------------------------
if docker volume inspect "$SESSION_VOLUME" >/dev/null 2>&1; then
  log "打包 Worker Session 卷 ${SESSION_VOLUME}"
  docker run --rm -v "${SESSION_VOLUME}:/data:ro" -v "${OUT}:/out" alpine:3.21 \
    tar -czf /out/worker-sessions.tar.gz -C /data .
else
  log "跳过 Worker Session 卷（${SESSION_VOLUME} 不存在）"
fi

# ---------------------------------------------------------------------------
# 清单：恢复时靠它核对完整性
# ---------------------------------------------------------------------------
( cd "$OUT" && sha256sum ./* > SHA256SUMS )
cat > "${OUT}/MANIFEST.txt" <<EOF
backup_at_utc=${STAMP}
supabase_dir=${SUPABASE_DIR}
db_container=${DB_CONTAINER}
supabase_version=$(cat "${SUPABASE_DIR}/.supabase-version" 2>/dev/null || echo "未记录")
host=$(hostname)
EOF

log "完成：${OUT}"
log "下一步（必做）：复制到独立备份位置，并按 restore.sh 做一次恢复验证。"
du -sh "$OUT" >&2
