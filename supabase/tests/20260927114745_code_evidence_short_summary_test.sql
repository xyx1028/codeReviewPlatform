\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

do $test$
declare
  v_column_exists boolean;
  v_function_source text;
  v_error text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_code_evidence'
      and column_name = 'evidence_summary'
      and data_type = 'text'
  ) into v_column_exists;
  perform pg_temp.assert(v_column_exists, 'ai_code_evidence has nullable evidence_summary text column');

  -- 历史/人工证据继续可空；新 Worker 写出的合法短概述可以被接受。
  insert into public.ai_code_evidence (
    ai_review_result_id, repository_name, commit_sha, file_path,
    evidence_type, evidence_summary, description
  )
  select result.id, 'kdmanage-backend', repeat('a', 40), 'src/V134Evidence.java',
         '现有实现', 'AK/SK 登录采用专用鉴权字段', '完整说明用于展开详情。'
  from public.ai_review_result result
  limit 1;

  begin
    insert into public.ai_code_evidence (
      ai_review_result_id, repository_name, commit_sha, file_path,
      evidence_type, evidence_summary, description
    )
    select result.id, 'kdmanage-backend', repeat('b', 40), 'src/Invalid.java',
           '现有实现', '太短', 'invalid summary'
    from public.ai_review_result result
    limit 1;
    raise exception 'short evidence summary must be rejected';
  exception when check_violation then
    get stacked diagnostics v_error = message_text;
    perform pg_temp.assert(v_error like '%ai_code_evidence_evidence_summary_check%', 'summary length check rejects too-short values');
  end;

  select pg_get_functiondef('public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure)
  into v_function_source;
  perform pg_temp.assert(
    position('evidence_summary' in v_function_source) > 0
    and position('v_evidence->>''evidence_summary''' in v_function_source) > 0,
    'finalization function maps evidence_summary from aggregate JSON to ai_code_evidence'
  );
end;
$test$;

select 'ALL_V134_CODE_EVIDENCE_SUMMARY_TESTS_PASSED' as result;

rollback;
