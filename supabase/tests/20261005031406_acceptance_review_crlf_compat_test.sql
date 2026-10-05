begin;

-- Exercise the real canonical function with Windows line endings, preserving
-- the original function and privileges by rolling the entire test back.
create temporary table v143_compat_original as
select oid, pg_get_functiondef(oid) as definition,
       proowner, proacl, prosecdef, proconfig
from pg_proc
where oid='public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure;

do $fixture$
declare v_definition text;
begin
  select definition into v_definition from v143_compat_original;
  execute replace(replace(v_definition,chr(13)||chr(10),chr(10)),chr(10),chr(13)||chr(10));
  if strpos(pg_get_functiondef('public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure),chr(13)||chr(10))=0 then
    raise exception 'CRLF fixture was not installed';
  end if;
end;
$fixture$;

\ir ../migrations/20261005031406_acceptance_review_crlf_compat.sql
\ir ../migrations/20261005031406_acceptance_review_crlf_compat.sql

do $assert$
declare v_original record; v_current record;
begin
  select * into v_original from v143_compat_original;
  select oid, pg_get_functiondef(oid) as definition,
         proowner,proacl,prosecdef,proconfig into v_current
  from pg_proc where oid='public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure;
  if v_current.definition is distinct from replace(v_original.definition,chr(13)||chr(10),chr(10)) then
    raise exception 'Compatibility patch changed more than CRLF line endings';
  end if;
  if (v_current.oid,v_current.proowner,v_current.proacl,v_current.prosecdef,v_current.proconfig)
     is distinct from
     (v_original.oid,v_original.proowner,v_original.proacl,v_original.prosecdef,v_original.proconfig) then
    raise exception 'Compatibility patch changed identity or security metadata';
  end if;
end;
$assert$;

select 'ALL_V143_CRLF_COMPAT_TESTS_PASSED' as result;
rollback;
