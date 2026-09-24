#!/usr/bin/env bash
# 校验 MCP 鉴权方式改动的三件确定性事实：
#   ① kdmanage 前后端开放白名单是否一致
#   ② 有没有只认 OAUTH2 的单值判断（应改用 isOAuthFamily）
#   ③ 开放白名单里的值在 Harness V2 里有没有对应分支
#
# 用法：bash check-auth-method-sync.sh [工作区根路径]
# 默认从当前目录找 kdmanage-backend / tmanage-backend。
# 退出码：0 全过；1 有问题；2 环境不对。

set -uo pipefail

ROOT="${1:-.}"
BE="$ROOT/kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/service/mcphub/McpHubService.java"
FE="$ROOT/kdmanage-frontend/src/components/mcp-hub/authMethod.ts"
V2="$ROOT/tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/service/McpCredentialsV2Service.java"

fail=0
miss=0
for f in "$BE" "$FE" "$V2"; do
  [ -f "$f" ] || { echo "环境不对：找不到 $f"; miss=1; }
done
[ $miss -eq 1 ] && { echo "请从工作区根运行，或把根路径作为第一个参数传入。"; exit 2; }

# --- ① 白名单一致性 -----------------------------------------------------------
# 后端 Set.of(...) 可能跨多行，取到 ); 为止。
# 注意：常量名 OPEN_AUTH_METHODS 自身含 AUTH_METHODS，必须先去掉，否则会多出一个假值 METHODS。
be_raw=$(awk '/OPEN_AUTH_METHODS *= *Set\.of\(/{c=1} c{print} c&&/\);/{exit}' "$BE")
be=$(printf '%s' "$be_raw" \
  | sed 's/OPEN_AUTH_METHODS//g' \
  | grep -o '\(AUTH_\|McpAuthMethods\.\)[A-Z0-9_]*' \
  | sed 's/^AUTH_//; s/^McpAuthMethods\.//' \
  | sort -u)

fe_raw=$(awk '/VISIBLE_AUTH_METHODS *= *\[/{c=1} c{print} c&&/\]/{exit}' "$FE")
fe=$(printf '%s' "$fe_raw" | grep -o "'[A-Z0-9_]*'" | tr -d "'" | sort -u)

echo "① 开放白名单一致性"
printf '   后端 OPEN_AUTH_METHODS   (%s 项): %s\n' "$(printf '%s' "$be" | grep -c .)" "$(printf '%s' "$be" | tr '\n' ' ')"
printf '   前端 VISIBLE_AUTH_METHODS(%s 项): %s\n' "$(printf '%s' "$fe" | grep -c .)" "$(printf '%s' "$fe" | tr '\n' ' ')"

if [ -z "$be" ] || [ -z "$fe" ]; then
  echo "   ✗ 解析失败（常量改名或格式变了），请人工核对"
  fail=1
elif [ "$be" = "$fe" ]; then
  echo "   ✓ 一致"
else
  echo "   ✗ 不一致："
  comm -23 <(printf '%s\n' "$be") <(printf '%s\n' "$fe") | sed 's/^/     只在后端: /'
  comm -13 <(printf '%s\n' "$be") <(printf '%s\n' "$fe") | sed 's/^/     只在前端: /'
  echo "     前端多出 = 运营能选但后端拒绝；后端多出 = 界面选不到但接口能配"
  fail=1
fi

# --- ② 只认 OAUTH2 的单值判断 --------------------------------------------------
# 判据：命中 OAUTH2 等值判断，且【同一行没有 OAUTH2_PKCE 兜底】才算漏。
# 刻意排除：家族判定函数与常量的定义处、console 工具管理线（那条线没有 PKCE 档）、注释行。
echo
echo "② 只认 OAUTH2 的单值判断（漏掉 OAUTH2_PKCE）"
scatter=$(grep -rn --include='*.java' --include='*.ts' --include='*.tsx' \
    -e '"OAUTH2"\.equals' -e '\.equals("OAUTH2")' -e '"OAUTH2"\.equalsIgnoreCase' \
    -e "=== *'OAUTH2'" -e "'OAUTH2' *===" \
    "$ROOT/kdmanage-backend" "$ROOT/tmanage-backend" "$ROOT/kdmanage-frontend" "$ROOT/tmanage-frontend" 2>/dev/null \
  | grep -v '/target/' | grep -v '/test/' | grep -v '__tests__' \
  | grep -v 'McpAuthMethods\.java' | grep -v 'authMethod\.ts' \
  | grep -v 'ToolPage\.tsx' \
  | grep -vE ':[[:space:]]*(/\*|\*|//)' \
  | grep -v 'OAUTH2_PKCE')

if [ -z "$scatter" ]; then
  echo "   ✓ 无单值判断（命中的都带 OAUTH2_PKCE 兜底）"
else
  n=$(printf '%s\n' "$scatter" | grep -c .)
  echo "   ✗ 发现 $n 处 —— 这些位置对 OAUTH2_PKCE 会静默不生效："
  printf '%s\n' "$scatter" | sed 's/^/     /' | head -20
  echo "     改用 McpAuthMethods.isOAuthFamily（后端）/ isOAuthFamily、OAUTH_FAMILY（前端）"
  fail=1
fi

# --- ③ 白名单里的值在 V2 有没有分支 -------------------------------------------
echo
echo "③ 开放白名单的值在 Harness V2 里是否有取值分支"
echo "   （V2 分支：OAuth → YZJ → PERSONAL+BEARER → PERSONAL+API_KEY → 其余落静态凭据循环，只收 HEADER）"
v2_missing=""
while IFS= read -r m; do
  [ -z "$m" ] && continue
  case "$m" in
    NONE)      grep -q '"NONE"\.equals(authMethod)\|none *=' "$V2" && ok=1 || ok=0 ;;
    BEARER)    grep -q 'buildPersonalBearerItem' "$V2" && ok=1 || ok=0 ;;
    API_KEY)   grep -q 'buildPersonalApiKeyItem' "$V2" && ok=1 || ok=0 ;;
    YZJ_OAUTH) grep -q 'buildYzjItem' "$V2" && ok=1 || ok=0 ;;
    OAUTH2|OAUTH2_PKCE) grep -q 'isOAuthAuthMethod' "$V2" && ok=1 || ok=0 ;;
    *)
      # 其余值：只有 schemaType 映射不算分支，必须有真正的取值逻辑
      if grep -q "build.*Item\b.*$m\|\"$m\"\.equals(authMethod)" "$V2"; then ok=1; else ok=0; fi
      ;;
  esac
  if [ "$ok" = 1 ]; then
    printf '   ✓ %-28s 有分支\n' "$m"
  else
    printf '   ✗ %-28s 无分支 —— 走 V2 静默失败（success=false + "MCP credential is not configured"）\n' "$m"
    v2_missing="$v2_missing $m"
  fi
done <<< "$be"

if [ -n "$v2_missing" ]; then
  echo
  echo "   以上方式可以新配但 Harness V2 调不通。两条出路："
  echo "     a) 给 McpCredentialsV2Service 补分支；"
  echo "     b) 从 OPEN_AUTH_METHODS + VISIBLE_AUTH_METHODS 同时撤回，只留存量。"
  echo "   注意：只在 schemaType() 里加字符串映射不算分支。"
  fail=1
fi

echo
if [ $fail -eq 0 ]; then
  echo "全部通过。"
else
  echo "有问题，见上。判据说明见 SKILL.md"
fi
exit $fail
