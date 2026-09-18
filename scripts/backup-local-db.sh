#!/usr/bin/env bash
#
# 备份**本地** Supabase 数据库。
#
# 存在的理由不是"备份完就可以放心 reset"——`.kiro/steering/database-never-reset.md` 明确
# 禁止 reset。它的理由是：本地库里有一整套没法从代码生成的东西（账号与角色、模型配置、
# 评审批次、AI 结论、人工确认、监控汇总），而清库这种事往往不是"决定要做"，而是别的工具、
# 别的进程或一次手滑做掉的。有备份就有回去的路。
#
# 只对本地容器生效：脚本会核对容器名，绝不连云端。云端备份属于 Supabase 平台的职责
# （Dashboard 的 backups），不在这个脚本的范围里。
#
# 用法：
#   npm run db:backup:local              # 备份到 .local-db-backups/<时间戳>.sql
#   npm run db:backup:local -- --keep 5  # 只保留最近 5 份（默认 10）
#
# 恢复（由用户手动执行，脚本刻意不提供 restore 子命令：
#        恢复是覆盖性操作，必须是人在看清情况后自己敲）：
#   docker exec -i supabase_db_codeReviewPlatform psql -U postgres -d postgres < <备份文件>
set -euo pipefail

CONTAINER="supabase_db_codeReviewPlatform"
OUT_DIR=".local-db-backups"
KEEP=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# 只允许本地 supabase 容器：名字对不上就直接退出，避免有人把它指到别的库上。
case "$CONTAINER" in
  supabase_db_*) ;;
  *) echo "拒绝执行：--container 必须是本地 supabase_db_* 容器，收到 '$CONTAINER'" >&2; exit 2 ;;
esac

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "本地数据库容器 $CONTAINER 没在运行。先 supabase start 再备份。" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/local-$STAMP.sql"

# pg_dump 全量（含 auth schema：账号和身份在那里，缺了它备份没有意义）。
# --clean 让恢复时先 drop 再建，避免"恢复到一个半旧半新的库"这种更难查的状态。
docker exec "$CONTAINER" pg_dump -U postgres --clean --if-exists --quote-all-identifiers postgres > "$FILE"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "已备份本地数据库 → $FILE ($SIZE)"

# 只保留最近 N 份，避免仓库目录被历史备份撑大。
COUNT="$(ls -1 "$OUT_DIR"/local-*.sql 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$COUNT" -gt "$KEEP" ]]; then
  ls -1t "$OUT_DIR"/local-*.sql | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "清理旧备份 $old"
  done
fi

echo
echo "恢复命令（需要时由你自己执行，脚本不代劳）："
echo "  docker exec -i $CONTAINER psql -U postgres -d postgres < $FILE"
