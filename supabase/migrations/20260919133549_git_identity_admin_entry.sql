-- V1.11 administrator entry for Git identity configuration.
-- Raw email is accepted only as an RPC argument, HMACed inside PostgreSQL, and never persisted or returned.

begin;

create or replace function public.admin_upsert_developer_git_identity_from_email(
  p_developer_id uuid,
  p_git_identity_id uuid,
  p_display_name text,
  p_employee_code text,
  p_email text,
  p_author_name_aliases text[] default array[]::text[],
  p_gitlab_username text default null,
  p_gitlab_user_id text default null,
  p_developer_status text default 'VERIFIED',
  p_verification_status text default 'VERIFIED',
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_domain text;
  v_local text;
  v_masked text;
  v_pepper text;
  v_fingerprint text;
  v_result jsonb;
begin
  perform public.ensure_admin();

  v_email := lower(btrim(coalesce(p_email,'')));
  if char_length(v_email) > 320
     or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$' then
    raise exception 'IDENTITY_EMAIL_INVALID';
  end if;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper,'')='' then raise exception 'IDENTITY_PEPPER_MISSING'; end if;

  v_local := split_part(v_email,'@',1);
  v_domain := split_part(v_email,'@',2);
  v_masked := left(v_local,1)||'***@'||v_domain;
  v_fingerprint := encode(hmac(
    convert_to(v_email,'UTF8'),
    convert_to(v_pepper,'UTF8'),
    'sha256'
  ),'hex');

  v_result := public.admin_upsert_developer_git_identity(
    v_actor,
    p_developer_id,
    p_git_identity_id,
    p_display_name,
    p_employee_code,
    p_developer_status,
    'gitlab',
    v_fingerprint,
    v_masked,
    v_domain,
    coalesce(p_author_name_aliases,array[]::text[]),
    p_gitlab_username,
    p_gitlab_user_id,
    p_verification_status,
    p_expected_revision
  );

  return v_result || jsonb_build_object(
    'masked_email',v_masked,
    'provider','gitlab'
  );
end;
$$;

revoke execute on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) from public,anon;
grant execute on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) to authenticated,service_role;

comment on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) is 'ADMIN only. HMACs normalized Git email with Vault analysis_identity_pepper; raw email is never stored or returned.';

commit;
