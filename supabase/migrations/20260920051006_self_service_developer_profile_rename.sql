-- V1.13 修缺陷：开发人员姓名/员工号可以单独改，不必先重新绑一个邮箱。
--
-- ## 缺陷现场
--
-- 姓名、员工号属于「开发人员身份」（developer_identity），跟具体哪个 Git 邮箱无关。
-- 但页面把它们和邮箱绑定塞进了同一个弹窗，而唯一的保存入口
-- upsert_my_git_identity_from_candidate 要求必须选中一个候选 —— 于是"我只想把姓名从
-- 17751361028 改成薛宇轩"这件事变成了：先去 GitLab 反查一次、再点一个邮箱，才能保存。
-- 用户实测就卡在这里：保存按钮永远是灰的。
--
-- 姓名写错的后果不轻：归属规则要把需求里「开发人员」那一栏和这个姓名对齐，对不上就算邮箱
-- 命中也进不了强关联。所以它必须能被单独、随时改对。

begin;

create or replace function public.update_my_developer_profile(
  p_display_name text,
  p_employee_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_display_name text;
  v_employee_code text;
  v_developer public.developer_identity;
  v_before jsonb;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;

  v_display_name := btrim(coalesce(p_display_name, ''));
  if v_display_name = '' then raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED'; end if;
  if char_length(v_display_name) > 64 then raise exception 'DEVELOPER_DISPLAY_NAME_TOO_LONG'; end if;
  v_employee_code := nullif(btrim(coalesce(p_employee_code, '')), '');

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor
  for update;
  -- 没有身份行时不在这里新建：身份的创建入口只有"绑定一个经 GitLab 验证的邮箱"，
  -- 否则会出现一堆没有任何邮箱、永远匹配不到提交的空身份。
  if v_developer.id is null then raise exception 'DEVELOPER_IDENTITY_NOT_FOUND'; end if;
  if v_developer.status in ('CONFLICT', 'DISABLED') then raise exception 'DEVELOPER_IDENTITY_LOCKED'; end if;

  if v_employee_code is not null and exists (
    select 1 from public.developer_identity other
    where lower(other.employee_code) = lower(v_employee_code)
      and other.id <> v_developer.id
  ) then
    raise exception 'DEVELOPER_EMPLOYEE_CODE_CONFLICT';
  end if;

  v_before := jsonb_build_object(
    'display_name', v_developer.display_name,
    'employee_code', v_developer.employee_code
  );

  update public.developer_identity
  set display_name = v_display_name,
      employee_code = v_employee_code,
      revision = revision + 1,
      updated_by = v_actor,
      updated_at = now()
  where id = v_developer.id
  returning * into v_developer;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, before_state, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor, array['SELF_IDENTITY_RENAMED'], v_before,
    jsonb_build_object(
      'developer_id', v_developer.id,
      'display_name', v_developer.display_name,
      'employee_code', v_developer.employee_code
    )
  );

  return jsonb_build_object(
    'developer_id', v_developer.id,
    'display_name', v_developer.display_name,
    'employee_code', v_developer.employee_code,
    'revision', v_developer.revision
  );
end;
$$;

revoke execute on function public.update_my_developer_profile(text, text) from public, anon;
grant execute on function public.update_my_developer_profile(text, text) to authenticated, service_role;

comment on function public.update_my_developer_profile(text, text) is
  'Self-service rename of the caller own developer identity. Does not touch Git emails; '
  'creating an identity still requires binding a GitLab-verified commit email.';

commit;
