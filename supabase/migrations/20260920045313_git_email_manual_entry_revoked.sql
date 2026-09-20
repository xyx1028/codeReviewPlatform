-- V1.13 收口：Git 邮箱必须经 GitLab 提交验证，撤掉"自己声称一个邮箱"这条路。
--
-- ## 为什么不是只在前端隐藏
--
-- 产品规则是"邮箱必须走 GitLab 反查"。如果只把手输入口从页面上拿掉，
-- `upsert_my_git_identity_from_email` 仍然对 authenticated 开放 —— 规则就只是一句约定，
-- 而不是边界。本仓库对这件事一向的立场是：导航能藏，权限不能藏（见 src/App.tsx 里
-- "导航仅 ADMIN 显示，但这不是安全边界"那条注释）。所以这里直接收回执行权限。
--
-- ## 影响
--
--   * 普通成员：只能通过 upsert_my_git_identity_from_candidate 保存，
--     即必须先有一次成功的 GitLab 反查，指纹来自候选行；
--   * 管理员：不受影响，「用户管理」页下方的总览仍可用
--     admin_upsert_developer_git_identity_from_email 代录（新人还没提过 MR 时的兜底）；
--   * service_role：保留，供运维脚本与将来的管理链路使用；
--   * 既有数据：一行不动。以前手输存下来的 UNVERIFIED 行继续留着，
--     而它们本来就不参与归属匹配（worker/src/pipeline/story-scope.ts 只取 VERIFIED）。
--
-- 函数本身不删：删了等于让"之前调用过它的旧前端"在发布窗口里报 404 而不是权限错误，
-- 而且它仍是 service_role 的合法入口。只收 authenticated 的执行权。

begin;

revoke execute on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) from public, anon, authenticated;

grant execute on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) to service_role;

comment on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) is 'service_role only since V1.13. Members must use upsert_my_git_identity_from_candidate, '
    'which takes its fingerprint from a GitLab-verified candidate row; a typed email proves nothing.';

commit;
