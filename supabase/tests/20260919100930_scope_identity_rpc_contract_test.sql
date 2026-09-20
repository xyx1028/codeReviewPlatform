\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_cond boolean,p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then raise exception 'ASSERT FAILED: %',p_msg; end if;
end;
$$;

do $test$
declare
  v_save regprocedure := to_regprocedure(
    'public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text)');
  v_checkpoint regprocedure := to_regprocedure(
    'public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint,text,text)');
  v_save_def text;
  v_checkpoint_def text;
begin
  perform pg_temp.assert(v_save is not null,
    'final save exposes generation/revision/manifest/scope/ruleset parameters');
  perform pg_temp.assert(v_checkpoint is not null,
    'checkpoint exposes Worker scope/ruleset identity parameters');
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='save_agent_review_result'),
    'final save has exactly one public overload');
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='save_analysis_session_checkpoint'),
    'checkpoint has exactly one public overload');

  perform pg_temp.assert(
    has_function_privilege('service_role',v_save,'EXECUTE')
      and not has_function_privilege('authenticated',v_save,'EXECUTE'),
    'final save remains service-role only');
  perform pg_temp.assert(
    has_function_privilege('service_role',v_checkpoint,'EXECUTE')
      and not has_function_privilege('authenticated',v_checkpoint,'EXECUTE'),
    'checkpoint remains service-role only');
  perform pg_temp.assert(
    not has_function_privilege('service_role',
      'public.save_agent_review_result_v111_internal(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)',
      'EXECUTE'),
    'service role cannot bypass final scope wrapper through the internal writer');
  perform pg_temp.assert(
    not has_function_privilege('service_role',
      'public.save_analysis_session_checkpoint_v111_internal(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint)',
      'EXECUTE'),
    'service role cannot bypass checkpoint scope wrapper through the internal writer');

  select pg_get_functiondef(v_save::oid) into v_save_def;
  select pg_get_functiondef(v_checkpoint::oid) into v_checkpoint_def;
  perform pg_temp.assert(
    v_save_def like '%p_scope_generation is distinct from v_run.scope_generation%'
      and v_save_def like '%p_triage_revision is distinct from v_run.agent_attempt%'
      and v_save_def like '%p_candidate_manifest_hash is distinct from v_scope.candidate_manifest_hash%'
      and v_save_def like '%p_analysis_scope_hash is distinct from public.analysis_agent_run_scope_hash(v_run.id)%'
      and v_save_def like '%p_attribution_ruleset_hash is distinct from v_run.attribution_ruleset_hash%',
    'final save validates every explicit V2 scope identity component');
  perform pg_temp.assert(
    v_checkpoint_def like '%p_analysis_scope_hash is distinct from public.analysis_agent_run_scope_hash(v_run.id)%'
      and v_checkpoint_def like '%p_attribution_ruleset_hash is distinct from v_run.attribution_ruleset_hash%',
    'checkpoint validates Worker scope and ruleset identities');
end;
$test$;

rollback;
