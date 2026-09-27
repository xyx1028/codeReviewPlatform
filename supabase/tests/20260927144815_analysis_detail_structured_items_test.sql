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
  v_column_nullable boolean;
  v_constraint_definition text;
  v_function_source text;
  v_valid jsonb := jsonb_build_object(
    'implemented_content', jsonb_build_array('订单创建接口已实现'),
    'missing_content', '[]'::jsonb,
    'risks', jsonb_build_array('并发扣减库存需要覆盖'),
    'test_points', jsonb_build_array('覆盖重复提交场景'),
    'ai_remark', '[]'::jsonb
  );
begin
  select is_nullable = 'YES'
  into v_column_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'ai_review_result'
    and column_name = 'analysis_detail_items';
  perform pg_temp.assert(v_column_nullable, 'analysis_detail_items is nullable for historical and manual results');

  perform pg_temp.assert(
    public.is_valid_analysis_detail_items(v_valid),
    'the five-key structured object with single-line points is accepted'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(v_valid || jsonb_build_object('unexpected', '[]'::jsonb)),
    'extra keys are rejected'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(jsonb_set(v_valid, '{risks}', jsonb_build_array('重复风险', '重复风险'))),
    'duplicate category items are rejected'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(jsonb_set(v_valid, '{test_points}', jsonb_build_array(E'含有\n换行'))),
    'newlines are rejected'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(jsonb_set(v_valid, '{ai_remark}', jsonb_build_array(' 前后空白 '))),
    'untrimmed items are rejected'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(jsonb_set(v_valid, '{missing_content}', jsonb_build_array(repeat('x', 501)))),
    'items longer than 500 characters are rejected'
  );
  perform pg_temp.assert(
    not public.is_valid_analysis_detail_items(jsonb_set(v_valid, '{implemented_content}', (
      select jsonb_agg(to_jsonb(value)) from generate_series(1, 13) value
    ))),
    'more than twelve items in a category are rejected'
  );

  select pg_get_constraintdef(table_constraint.oid)
  into v_constraint_definition
  from pg_constraint table_constraint
  join pg_class relation on relation.oid = table_constraint.conrelid
  join pg_namespace schema on schema.oid = relation.relnamespace
  where schema.nspname = 'public'
    and relation.relname = 'ai_review_result'
    and table_constraint.conname = 'ai_review_result_analysis_detail_items_check';
  perform pg_temp.assert(
    position('is_valid_analysis_detail_items' in coalesce(v_constraint_definition, '')) > 0,
    'result table constraint delegates every non-NULL value to the structured validator'
  );

  select pg_get_functiondef('public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure)
  into v_function_source;
  perform pg_temp.assert(
    position('ANALYSIS_DETAIL_ITEMS_INVALID' in v_function_source) > 0
    and position('analysis_detail_items' in v_function_source) > 0
    and position('v_result->''analysis_detail_items''' in v_function_source) > 0,
    'finalizer rejects malformed structured details and persists the validated JSONB field'
  );
end;
$test$;

select 'ALL_V137_ANALYSIS_DETAIL_STRUCTURED_ITEMS_TESTS_PASSED' as result;

rollback;
