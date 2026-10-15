#!/usr/bin/env bash
#
# 备份恢复验证 —— V1.48
#
# 回答一个问题：这份备份能不能恢复出完整的结构、策略和数据。
#
# 两条硬规矩（都是踩过的坑）：
#
# 1. **绝不把 roles.sql 灌进任何活着的集群。** `pg_dumpall --roles-only` 里是
#    `CREATE ROLE` / `ALTER ROLE ... PASSWORD` / `GRANT ... TO` 这类**集群级**语句。
#    往在服务的集群执行，会改掉现有角色的密码与成员关系 —— 等于用一份旧备份覆盖当前账号体系，
#    而且没有回头路。这里只**解析并核对**它：列出备份里的角色，检查目标集群是否已具备，
#    不执行其中任何一条。真正需要灌角色的场合只有"全新空集群"，那一步由人工在确认目标后执行。
# 2. **不吞恢复错误。** `ON_ERROR_STOP=0` + `|| true` 会让一份坏备份"验证通过"。
#    这里把 pg_restore 的 stderr 全量留存、逐条打印，有错就判定失败并退非零。
#
# 它只往**新建的临时库**恢复，不碰在服务的库；但请注意临时库仍在同一个集群里，
# 会占用该实例的磁盘与少量负载。条件允许时用 TARGET_CONTAINER 指向一个独立的空集群。
#
# 用法：
#   bash deploy/supabase-selfhost/scripts/restore-verify.sh /srv/crp/backups/20261014-xxxxxx
#   TARGET_CONTAINER=throwaway-pg bash .../restore-verify.sh <备份目录>
#
# 验证完清理（脚本不替你删，避免误删同名库）：
#   docker exec <容器> psql -U $DB_SUPERUSER -c 'drop database crp_restore_check'

set -euo pipefail

BACKUP_DIR="${1:-}"
# 备份来源容器（只读取备份文件时不需要）；恢复目标容器默认与它相同。
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
TARGET_CONTAINER="${TARGET_CONTAINER:-$DB_CONTAINER}"
CHECK_DB="${CHECK_DB:-crp_restore_check}"
# 必须用 superuser 恢复：`postgres` 在自部署里不是 superuser，恢复 vault.secrets 会被拒，
# 结果是"恢复成功但模型密钥没了"。实测 supabase_admin 恢复 0 error。
DB_SUPERUSER="${DB_SUPERUSER:-supabase_admin}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}}"
RESTORE_LOG="${LOG_DIR}/crp-restore-verify-$(date -u +%Y%m%d-%H%M%S).log"

log() { printf '[restore-verify] %s\n' "$*" >&2; }
fail() { printf '[restore-verify][错误] %s\n' "$*" >&2; exit 1; }

[ -n "$BACKUP_DIR" ] || fail "用法：restore-verify.sh <备份目录>"
[ -d "$BACKUP_DIR" ] || fail "备份目录不存在：$BACKUP_DIR"
[ -s "${BACKUP_DIR}/postgres.dump" ] || fail "缺少 postgres.dump 或为空"
docker inspect "$TARGET_CONTAINER" >/dev/null 2>&1 || fail "目标容器 $TARGET_CONTAINER 不在运行"

case "$CHECK_DB" in
  postgres|template0|template1|_supabase)
    fail "CHECK_DB 不能是 ${CHECK_DB} —— 那是在服务的库"
    ;;
esac

if [ "$TARGET_CONTAINER" = "$DB_CONTAINER" ]; then
  log "注意：恢复目标与备份来源是同一个集群（${TARGET_CONTAINER}）。"
  log "      只会新建临时库 ${CHECK_DB}，不动现有库、不动集群角色；"
  log "      但临时库占用同一实例的磁盘。要完全隔离请设 TARGET_CONTAINER。"
fi

log "校验备份完整性"
( cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS ) || fail "SHA256 校验不通过，这份备份不可信"

# ---------------------------------------------------------------------------
# 角色：只核对，不执行
# ---------------------------------------------------------------------------
if [ -s "${BACKUP_DIR}/roles.sql" ]; then
  log "核对备份中的集群角色（不执行 roles.sql）"
  BACKUP_ROLES=$(grep -oE "^(CREATE|ALTER) ROLE [A-Za-z0-9_\"]+" "${BACKUP_DIR}/roles.sql" \
    | awk '{print $3}' | tr -d '"' | sort -u)
  [ -n "$BACKUP_ROLES" ] || log "  警告：roles.sql 里没解析出任何角色，确认这份备份是否完整"
  MISSING=""
  for role in $BACKUP_ROLES; do
    if ! docker exec "$TARGET_CONTAINER" psql -U "$DB_SUPERUSER" -tAc \
        "select 1 from pg_roles where rolname = '${role}'" | grep -q 1; then
      MISSING="${MISSING} ${role}"
    fi
  done
  if [ -n "$MISSING" ]; then
    log "  目标集群缺少这些角色：${MISSING}"
    log "  → 这不影响本次结构/数据核对（恢复用 --no-owner --no-acl），"
    log "    但说明该集群不能直接承载这份备份。全新集群上线时，由人工确认目标后再执行："
    log "    docker exec -i <新集群> psql -U $DB_SUPERUSER -v ON_ERROR_STOP=1 < roles.sql"
  else
    log "  备份中的角色在目标集群全部存在"
  fi
else
  log "这份备份没有 roles.sql（全新集群恢复时会缺角色，RLS 会失效）"
fi

# ---------------------------------------------------------------------------
# 临时库
# ---------------------------------------------------------------------------
log "确认临时库 ${CHECK_DB} 不存在（存在就交人工处理，脚本不替你删）"
if docker exec "$TARGET_CONTAINER" psql -U "$DB_SUPERUSER" -tAc \
    "select 1 from pg_database where datname = '${CHECK_DB}'" | grep -q 1; then
  fail "${CHECK_DB} 已存在。确认无用后手工执行：drop database ${CHECK_DB}"
fi

log "创建临时库 ${CHECK_DB}"
docker exec "$TARGET_CONTAINER" psql -U "$DB_SUPERUSER" -v ON_ERROR_STOP=1 -c "create database ${CHECK_DB}"

# ---------------------------------------------------------------------------
# 恢复：全量留日志，有错即失败
#
# 不加 --exit-on-error：那样只能看到第一条错误，而我们要的是**全部**错误清单。
# 代价是必须自己判定退出码与错误条数，不能靠 set -e。
# ---------------------------------------------------------------------------
log "恢复到 ${CHECK_DB}（日志：${RESTORE_LOG}）"
set +e
docker exec -i "$TARGET_CONTAINER" pg_restore -U "$DB_SUPERUSER" -d "${CHECK_DB}" \
  --no-owner --no-acl --verbose < "${BACKUP_DIR}/postgres.dump" > "${RESTORE_LOG}" 2>&1
RESTORE_RC=$?
set -e

ERRORS=$(grep -cE "^pg_restore: error:" "${RESTORE_LOG}" || true)
WARNINGS=$(grep -cE "^pg_restore: warning:" "${RESTORE_LOG}" || true)
log "pg_restore 退出码=${RESTORE_RC}，error=${ERRORS}，warning=${WARNINGS}"

if [ "${ERRORS}" -gt 0 ] || [ "${RESTORE_RC}" -ne 0 ]; then
  log "恢复过程中的错误（全部列出，不做过滤）："
  grep -E "^pg_restore: (error|warning):" "${RESTORE_LOG}" | sed 's/^/    /' >&2 || true
  fail "恢复有错误，这份备份**不能**判定为可用。日志：${RESTORE_LOG}"
fi

# ---------------------------------------------------------------------------
# 核对关键对象
# ---------------------------------------------------------------------------
log "核对关键对象（数不对就说明这份备份不能用）"
docker exec "$TARGET_CONTAINER" psql -U "$DB_SUPERUSER" -d "${CHECK_DB}" -v ON_ERROR_STOP=1 -c "
select
  (select count(*) from information_schema.tables
     where table_schema = 'public')                                as public_tables,
  (select count(*) from information_schema.routines
     where routine_schema = 'public')                              as public_functions,
  (select count(*) from pg_policies where schemaname = 'public')    as rls_policies,
  (select count(*) from public.user_profile)                        as user_profiles,
  (select count(*) from public.review_batch)                        as review_batches,
  (select count(*) from public.review_story)                        as review_stories,
  (select count(*) from public.ai_review_result)                    as ai_results,
  -- Vault 必须有数：它是模型 API Key 的存放处，恢复不出来等于平台跑不了评审
  (select count(*) from vault.secrets)                              as vault_secrets;
"

log "核对 Storage 与配置包可解压"
for archive in storage.tar.gz config.tar.gz worker-sessions.tar.gz; do
  if [ -f "${BACKUP_DIR}/${archive}" ]; then
    tar -tzf "${BACKUP_DIR}/${archive}" >/dev/null && log "  ${archive} 正常"
  else
    log "  ${archive} 不在这份备份里"
  fi
done

log "完成。确认上面的计数符合预期后，清理临时库："
log "  docker exec ${TARGET_CONTAINER} psql -U $DB_SUPERUSER -c 'drop database ${CHECK_DB}'"
