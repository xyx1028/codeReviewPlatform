-- Run in the same psql connection immediately after applying the V1.43
-- migration, which installs the actual pg_temp.patch_review_function helper.
begin;

create function pg_temp.v143_crlf_fixture() returns integer
language sql security definer set search_path=pg_temp
as E'select\r\n  1';

create temporary table v143_crlf_metadata as
select oid,proowner,proacl,prosecdef,proconfig from pg_proc
where oid='pg_temp.v143_crlf_fixture()'::regprocedure;

select pg_temp.patch_review_function('pg_temp.v143_crlf_fixture()',E'select\n  1',E'select\n  2');
select pg_temp.patch_review_function('pg_temp.v143_crlf_fixture()',E'select\n  1',E'select\n  2');
select pg_temp.patch_review_function('pg_temp.v143_crlf_fixture()',E'select\r\n  2',E'select\r\n  3');

do $assert$
declare v_old record; v_new record;
begin
  if pg_temp.v143_crlf_fixture() <> 3 then
    raise exception 'CRLF source and anchors were not patched correctly';
  end if;
  select * into v_old from v143_crlf_metadata;
  select oid,proowner,proacl,prosecdef,proconfig into v_new from pg_proc
  where oid='pg_temp.v143_crlf_fixture()'::regprocedure;
  if (v_new.oid,v_new.proowner,v_new.proacl,v_new.prosecdef,v_new.proconfig)
     is distinct from (v_old.oid,v_old.proowner,v_old.proacl,v_old.prosecdef,v_old.proconfig) then
    raise exception 'Patch changed function identity or security metadata';
  end if;
  begin
    perform pg_temp.patch_review_function('pg_temp.v143_crlf_fixture()','missing anchor','unexpected replacement');
  exception when others then
    if strpos(sqlerrm,'V143 patch target missing:')=0 then raise; end if;
    return;
  end;
  raise exception 'Missing target guard was bypassed';
end;
$assert$;

select 'ALL_V143_CRLF_PATCH_TESTS_PASSED' as result;
rollback;
