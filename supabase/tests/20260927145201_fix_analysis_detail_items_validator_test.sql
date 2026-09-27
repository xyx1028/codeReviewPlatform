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
  v_source text;
  v_valid jsonb := jsonb_build_object(
    'implemented_content', jsonb_build_array('接口已实现'),
    'missing_content', '[]'::jsonb,
    'risks', '[]'::jsonb,
    'test_points', '[]'::jsonb,
    'ai_remark', '[]'::jsonb
  );
begin
  perform pg_temp.assert(public.is_valid_analysis_detail_items(v_valid), 'fixed validator accepts a valid five-key object');
  perform pg_temp.assert(not public.is_valid_analysis_detail_items(v_valid - 'risks'), 'fixed validator still requires every key');

  select pg_get_functiondef('public.is_valid_analysis_detail_items(jsonb)'::regprocedure)
  into v_source;
  perform pg_temp.assert(
    position('jsonb_object_keys' in v_source) > 0
    and position('jsonb_object_length' in v_source) = 0,
    'validator counts JSON object keys with a PostgreSQL-supported function'
  );
end;
$test$;

select 'ALL_V137_ANALYSIS_DETAIL_VALIDATOR_FIX_TESTS_PASSED' as result;

rollback;
