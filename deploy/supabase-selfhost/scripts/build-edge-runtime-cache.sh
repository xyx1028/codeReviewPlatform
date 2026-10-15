#!/usr/bin/env bash
# 在可访问公司镜像仓库的构建机上，把当前 Edge Functions 的远程依赖预热进 linux/amd64 镜像。
# 使用：
#   CRP_SUPABASE_DOCKER_DIR=/绝对路径/supabase-source/docker \
#     bash deploy/supabase-selfhost/scripts/build-edge-runtime-cache.sh edge-runtime-v1.76.2-crp-r4

set -euo pipefail
set +x

tag="${1:-}"
if [[ $# -ne 1 || ! "$tag" =~ ^edge-runtime-[A-Za-z0-9._-]+$ ]]; then
  echo "用法：CRP_SUPABASE_DOCKER_DIR=/绝对路径/supabase-source/docker bash $0 <镜像标签>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
supabase_docker_dir="${CRP_SUPABASE_DOCKER_DIR:-}"
[[ -d "$supabase_docker_dir" ]] || {
  echo '请设置 CRP_SUPABASE_DOCKER_DIR，指向 self-hosted/v0.8.2 源码的 docker/ 目录。' >&2
  exit 1
}
[[ -f "$supabase_docker_dir/volumes/functions/main/index.ts" ]] || {
  echo "不是有效的 Supabase docker 目录：$supabase_docker_dir" >&2
  exit 1
}
[[ -d "$repo_root/supabase/functions" ]] || {
  echo "找不到项目 Functions 目录：$repo_root/supabase/functions" >&2
  exit 1
}

command -v docker >/dev/null || { echo '缺少 docker。' >&2; exit 1; }
docker buildx version >/dev/null || { echo 'Docker Buildx 不可用。' >&2; exit 1; }

stage="$(mktemp -d "${TMPDIR:-/tmp}/crp-functions-build.XXXXXXXX")"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT

# 主构建上下文的 .dockerignore 会排除 supabase/functions；先复制到临时目录，再作为独立的
# named context 交给 BuildKit，避免把该忽略规则改宽。
cp -a "$repo_root/supabase/functions/." "$stage/"
function_count="$(find "$stage" -mindepth 2 -maxdepth 2 -name index.ts -type f | wc -l | tr -d ' ')"
(( function_count > 0 )) || { echo '没有可预热的 Edge Function。' >&2; exit 1; }

image="kcr.kingdee.com/ai-2030/supabase:$tag"
echo "将预热 $function_count 个 Edge Functions，并推送：$image"
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --build-context "supabase_source=$supabase_docker_dir" \
  --build-context "functions_source=$stage" \
  --output "type=image,name=$image,push=true,oci-mediatypes=false" \
  -f "$repo_root/deploy/supabase-selfhost/Dockerfile.edge-runtime-cache" \
  "$repo_root"

echo "已推送 $image。请把 docker-compose.crp.yml 的 functions.image 更新为该标签，再仅重建 functions 服务。"
