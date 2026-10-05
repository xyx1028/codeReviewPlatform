-- V1.43 compatibility: the cloud canonical writer uses CRLF line endings.
-- Run this idempotent preflight once in the cloud SQL editor before retrying
-- the earlier 20261004182525 migration. db push will subsequently record this
-- migration in its normal order. No function logic, privileges or data change.
do $compat$
declare
  v_function regprocedure := to_regprocedure('public.complete_analysis_job(uuid,text,jsonb,jsonb)');
  v_definition text;
  v_normalized text;
begin
  if v_function is null then
    raise exception 'V143 compatibility prerequisite missing: public.complete_analysis_job(uuid,text,jsonb,jsonb)';
  end if;
  v_definition := pg_get_functiondef(v_function);
  v_normalized := replace(v_definition, chr(13) || chr(10), chr(10));
  if v_normalized is distinct from v_definition then
    execute v_normalized;
  end if;
end;
$compat$;
