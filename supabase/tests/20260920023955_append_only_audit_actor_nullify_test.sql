\set ON_ERROR_STOP on
\timing off

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end;
$$;

do $test$
declare
  v_admin uuid:='02395500-1000-4000-a000-000000000001';
  v_member uuid:='02395500-1000-4000-a000-000000000002';
  v_audit bigint;
  v_impact jsonb;
  v_error text;
begin
  insert into auth.users(id,email) values
    (v_admin,'v112-nullify-admin@example.invalid'),
    (v_member,'v112-nullify-member@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_admin,'ADMIN','V1.12 删除执行人'),
    (v_member,'REVIEWER','V1.12 被删成员')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  insert into public.analysis_scope_decision_audit(
    decision_type,source,actor_id,reason_codes,after_state
  ) values (
    'IDENTITY_CONFIG','USER',v_member,array['SELF_IDENTITY_CREATED'],
    jsonb_build_object('masked_email','m***@example.invalid')
  ) returning id into v_audit;

  ----------------------------------------------------------------------------
  -- 1. 人为改写与直接删除仍然被拒
  ----------------------------------------------------------------------------
  begin
    update public.analysis_scope_decision_audit set reason_codes=array['TAMPERED'] where id=v_audit;
    perform pg_temp.assert(false,'direct update must stay rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='APPEND_ONLY_RECORD_IMMUTABLE','direct update is rejected');
  end;
  begin
    update public.analysis_scope_decision_audit set actor_id=v_admin where id=v_audit;
    perform pg_temp.assert(false,'re-pointing actor_id must stay rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='APPEND_ONLY_RECORD_IMMUTABLE','changing actor to another user is rejected');
  end;
  begin
    update public.analysis_scope_decision_audit set actor_id=null where id=v_audit;
    perform pg_temp.assert(false,'manual nullification outside a cascade must stay rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='APPEND_ONLY_RECORD_IMMUTABLE',
      'nullifying actor_id by hand is rejected (trigger depth = 1)');
  end;
  begin
    delete from public.analysis_scope_decision_audit where id=v_audit;
    perform pg_temp.assert(false,'direct delete must stay rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='APPEND_ONLY_RECORD_IMMUTABLE','direct delete is rejected');
  end;

  ----------------------------------------------------------------------------
  -- 2. 影响评估把"会被置空"的痕迹显式列出来
  ----------------------------------------------------------------------------
  insert into public.developer_identity(display_name,employee_code,status,auth_user_id)
  values('V1.12 被删成员','E-V112-DEL','VERIFIED',v_member);
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  v_impact:=public.admin_get_user_deletion_impact(v_member);
  reset role;
  perform pg_temp.assert((v_impact->>'can_delete')::boolean,
    'a member with only identity traces can be deleted');
  perform pg_temp.assert(
    (v_impact->'nullify_counts'->>'developer_identity')::integer=1
    and (v_impact->'nullify_counts'->>'analysis_scope_decision_audit')::integer=1,
    'impact assessment reports the identity traces that will be detached');

  ----------------------------------------------------------------------------
  -- 3. 真正删除账号：审计行留下来，只有 actor_id 变成 null
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  perform public.admin_delete_user(v_member);
  reset role;

  perform pg_temp.assert(not exists(select 1 from auth.users where id=v_member),
    'the account is deleted');
  perform pg_temp.assert(
    (select actor_id is null
       and 'SELF_IDENTITY_CREATED'=any(reason_codes)
       and after_state->>'masked_email'='m***@example.invalid'
     from public.analysis_scope_decision_audit where id=v_audit),
    'the audit row survives with actor_id nullified and every other column intact');
  perform pg_temp.assert(
    (select auth_user_id is null and status='VERIFIED'
     from public.developer_identity where employee_code='E-V112-DEL'),
    'the developer identity falls back to unclaimed instead of blocking the delete');
end;
$test$;

rollback;
