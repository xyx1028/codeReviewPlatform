#!/usr/bin/env bash
# 在公司 Linux 上从 GitLab release 更新迁移和 Edge Functions，并部署到自托管 Supabase。
# 默认只预览；确认后使用 --apply。不要把包含密码的 .env 或命令输出发到聊天。

set -euo pipefail
set +x

mode="${1:---dry-run}"
if [[ "$mode" != "--dry-run" && "$mode" != "--apply" || $# -gt 1 ]]; then
  echo "用法：bash $0 [--dry-run|--apply]" >&2
  exit 2
fi

source_dir="${CRP_MIGRATION_SOURCE:-/home/kduser/crp/migration-source}"
supabase_dir="${CRP_SUPABASE_DIR:-/home/kduser/crp/supabase}"
env_file="${CRP_SUPABASE_ENV:-$supabase_dir/.env}"
cli="${CRP_SUPABASE_CLI:-/home/kduser/.local/bin/supabase}"
expected_origin='https://git.kingdee.com/kwork-code-review/kwork-code-review.git'

for command_name in git python3 flock; do
  command -v "$command_name" >/dev/null || { echo "缺少命令：$command_name" >&2; exit 1; }
done
[[ -x "$cli" ]] || { echo "找不到 Supabase CLI：$cli" >&2; exit 1; }
[[ -r "$env_file" ]] || { echo "读不到服务器 Supabase .env：$env_file" >&2; exit 1; }
[[ -d "$source_dir/.git" ]] || { echo "找不到 GitLab 迁移仓库：$source_dir" >&2; exit 1; }
[[ -f "$supabase_dir/docker-compose.yml" ]] || { echo "找不到 Supabase Compose：$supabase_dir" >&2; exit 1; }
functions_root="$supabase_dir/volumes/functions"
[[ -f "$functions_root/main/index.ts" ]] || {
  echo "找不到现有 Edge Functions 入口：$functions_root/main/index.ts" >&2; exit 1;
}

exec 9>"$source_dir/../.crp-migration.lock"
flock -n 9 || { echo '另一轮迁移正在运行。' >&2; exit 1; }

cd "$source_dir"
[[ "$(git remote get-url origin)" == "$expected_origin" ]] || {
  echo 'Git origin 不是预期的公司仓库，已停止。' >&2; exit 1;
}
[[ "$(git branch --show-current)" == 'release' ]] || {
  echo '当前不是 release 分支，已停止。' >&2; exit 1;
}
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo '迁移仓库有未提交改动，已停止；请先处理改动。' >&2
  exit 1
fi

# 只在内存中缓存本用户凭据 30 分钟；稀疏检出和 pull 共用，避免重复输入。
# 清空其他 credential.helper，避免误用明文落盘的 store helper。
git_cached() { git -c credential.helper= -c 'credential.helper=cache --timeout=1800' "$@"; }

echo '从 GitLab 更新 release 分支（首次可能提示输入一次账号和密码）…'
git_cached sparse-checkout set supabase
git_cached pull --ff-only origin release
[[ -f supabase/config.toml ]] || { echo '缺少 supabase/config.toml。' >&2; exit 1; }
shopt -s nullglob
migrations=(supabase/migrations/*.sql)
(( ${#migrations[@]} > 0 )) || { echo '没有找到迁移文件，已停止。' >&2; exit 1; }
functions=()
changed_functions=()
for function_path in supabase/functions/*/; do
  [[ -f "$function_path/index.ts" ]] || continue
  function_name="${function_path%/}"
  function_name="${function_name##*/}"
  functions+=("$function_name")
  if [[ ! -d "$functions_root/$function_name" ]] ||
     ! diff -qr "$function_path" "$functions_root/$function_name" >/dev/null; then
    changed_functions+=("$function_name")
  fi
done
(( ${#functions[@]} > 0 )) || { echo '没有找到 Edge Functions，已停止。' >&2; exit 1; }

# .env 不能用 shell source：官方文件含空格等非 shell 字符。
# 仅从已有 .env 读取数据库口令，按 CLI 要求编码进显式连接串；不打印它。
db_url="$(python3 - "$env_file" <<'PY'
import re
import sys
from urllib.parse import quote

values = {}
with open(sys.argv[1], encoding='utf-8') as env:
    for line in env:
        if line.startswith(('POSTGRES_PASSWORD=', 'POOLER_TENANT_ID=')):
            key, value = line.rstrip('\r\n').split('=', 1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key] = value
password = values.get('POSTGRES_PASSWORD', '')
tenant = values.get('POOLER_TENANT_ID', '')
if not password or not re.fullmatch(r'[A-Za-z0-9_-]+', tenant):
    sys.exit('Supabase .env 缺少有效的 POSTGRES_PASSWORD 或 POOLER_TENANT_ID')
print(f'postgresql://postgres.{tenant}:{quote(password, safe="")}@127.0.0.1:54342/postgres?sslmode=disable')
PY
)"

echo "代码版本：$(git rev-parse --short HEAD)，迁移文件：${#migrations[@]} 个。"
echo "Edge Functions：${functions[*]}；需要更新：${changed_functions[*]:-无}。"
echo '预览尚未执行的迁移…'
"$cli" db push --db-url "$db_url" --skip-vault --dry-run

if [[ "$mode" == '--apply' ]]; then
  [[ -t 0 ]] || { echo '实际执行需要交互终端确认。' >&2; exit 1; }
  echo '即将向本机自部署 Supabase 执行上述迁移；按 CLI 提示确认。'
  "$cli" db push --db-url "$db_url" --skip-vault
  if (( ${#changed_functions[@]} > 0 )); then
    stage="$(mktemp -d "$functions_root/.crp-stage.XXXXXXXX")"
    deploy_started=0
    cleanup() {
      status=$?
      if (( status != 0 && deploy_started == 1 )); then
        echo 'Function 更新失败，恢复之前的文件并重新启动 Functions；已成功执行的数据库迁移不会自动回滚。' >&2
        for name in "${changed_functions[@]}"; do
          rm -rf "$functions_root/$name"
          [[ ! -d "$stage/old-$name" ]] || mv "$stage/old-$name" "$functions_root/$name"
        done
        (cd "$supabase_dir" && docker compose restart functions) || true
      fi
      rm -rf "$stage"
    }
    trap cleanup EXIT
    for name in "${changed_functions[@]}"; do
      cp -a "supabase/functions/$name" "$stage/$name"
    done
    deploy_started=1
    for name in "${changed_functions[@]}"; do
      [[ ! -d "$functions_root/$name" ]] || mv "$functions_root/$name" "$stage/old-$name"
      mv "$stage/$name" "$functions_root/$name"
    done
    (cd "$supabase_dir" && docker compose restart functions)
    healthy=0
    for attempt in {1..30}; do
      if [[ "$(docker inspect --format '{{.State.Health.Status}}' supabase-edge-functions 2>/dev/null)" == healthy ]]; then
        healthy=1
        break
      fi
      sleep 1
    done
    (( healthy == 1 )) || { echo 'Functions 容器未恢复健康。' >&2; exit 1; }
    # 真实加载测试：匿名 JWT 不是用户会话，业务函数应返回自身的 invalid session。
    # 若依赖包在内网无法下载，通常会返回 BOOT_ERROR/500；此时触发文件回滚。
    python3 - "$env_file" <<'PY'
import json
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

with open(sys.argv[1], encoding='utf-8') as env:
    keys = [line.rstrip('\r\n').split('=', 1)[1] for line in env if line.startswith('ANON_KEY=')]
if len(keys) != 1 or not keys[0]:
    sys.exit('Supabase .env 缺少 ANON_KEY')
for name in ('admin-model-config', 'skill-bundle-admin'):
    req = Request(
        f'http://127.0.0.1:54341/functions/v1/{name}',
        data=b'{}',
        headers={'apikey': keys[0], 'Authorization': 'Bearer ' + keys[0],
                 'Content-Type': 'application/json'},
    )
    try:
        with urlopen(req, timeout=12) as response:
            status, body = response.status, response.read(1024)
    except HTTPError as error:
        status, body = error.code, error.read(1024)
    if status != 401 or json.loads(body).get('error') != 'invalid session':
        sys.exit(f'{name} 加载校验失败：HTTP {status}；检查 functions 日志')
    print(f'{name} 已加载并保持会话校验。')
PY
    deploy_started=0
    trap - EXIT
    rm -rf "$stage"
  fi
  echo "迁移及 Functions 更新已完成，代码版本：$(git rev-parse --short HEAD)。"
else
  echo "只完成预览，未修改数据库或 Functions；确认后运行：bash $0 --apply"
fi
