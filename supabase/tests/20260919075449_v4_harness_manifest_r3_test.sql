-- V1.11 正式模型工具所需 Harness manifest 与数据库 RPC 契约；全程 rollback。
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
  v_active public.v4_harness_manifest;
begin
  select * into v_active from public.v4_harness_manifest where is_active;
  perform pg_temp.assert(
    v_active.manifest_revision=3
    and v_active.contract_version=4
    and v_active.harness_version='0.1.5-rc.1'
    and v_active.manifest_hash='6189bb7bdd6ddfbb33512fad6f867a3a9ceda7a30845bc62598c5a69226df868',
    'revision 3 is the unique active V4 manifest');
  perform pg_temp.assert(
    (select count(*)=1 from public.v4_harness_manifest where is_active),
    'exactly one V4 manifest is active');

  perform pg_temp.assert(
    to_regprocedure('public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)') is not null
    and to_regprocedure('public.record_story_commit_access(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text,text,integer,integer,boolean,text)') is not null
    and to_regprocedure('public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text)') is not null
    and to_regprocedure('public.record_analysis_scope_expansion(uuid,text,uuid,uuid,uuid,text,text,text)') is not null,
    'all four formal tool database dependencies exist');

  perform pg_temp.assert(
    has_function_privilege('service_role','public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)','EXECUTE')
    and has_function_privilege('service_role','public.record_story_commit_access(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text,text,integer,integer,boolean,text)','EXECUTE')
    and has_function_privilege('service_role','public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text)','EXECUTE')
    and has_function_privilege('service_role','public.record_analysis_scope_expansion(uuid,text,uuid,uuid,uuid,text,text,text)','EXECUTE'),
    'service_role can execute every formal tool dependency');

  perform pg_temp.assert(
    not has_function_privilege('authenticated','public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)','EXECUTE')
    and not has_function_privilege('authenticated','public.record_story_commit_access(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text,text,integer,integer,boolean,text)','EXECUTE')
    and not has_function_privilege('authenticated','public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text)','EXECUTE')
    and not has_function_privilege('authenticated','public.record_analysis_scope_expansion(uuid,text,uuid,uuid,uuid,text,text,text)','EXECUTE'),
    'browser roles cannot invoke formal tool write/read dependencies');
end;
$test$;

rollback;
