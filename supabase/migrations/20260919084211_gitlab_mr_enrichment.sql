-- V1.11 optional GitLab MR enrichment.
-- This migration is forward-only, service-role only, and never performs network access.

begin;

alter table public.analysis_repository_merge_request
  add column if not exists description text,
  add column if not exists author_username text,
  add column if not exists author_provider_id text,
  add column if not exists provider_created_at timestamptz,
  add column if not exists provider_updated_at timestamptz;

alter table public.analysis_repository_merge_request
  drop constraint if exists analysis_repository_mr_author_username_check,
  add constraint analysis_repository_mr_author_username_check
    check (author_username is null or btrim(author_username) <> ''),
  drop constraint if exists analysis_repository_mr_author_provider_id_check,
  add constraint analysis_repository_mr_author_provider_id_check
    check (author_provider_id is null or btrim(author_provider_id) <> ''),
  drop constraint if exists analysis_repository_mr_provider_time_check,
  add constraint analysis_repository_mr_provider_time_check
    check (
      provider_created_at is null or provider_updated_at is null
      or provider_created_at <= provider_updated_at
    );

create or replace function public.save_analysis_repository_merge_requests(
  p_job_id uuid,
  p_worker_id text,
  p_repository_name text,
  p_status text,
  p_error_code text,
  p_merge_requests jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_snapshot public.analysis_repository_snapshot;
  v_mr jsonb;
  v_membership jsonb;
  v_mr_id uuid;
  v_commit_id uuid;
  v_expected_project text;
  v_mr_count integer := 0;
  v_relation_count integer := 0;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id,p_worker_id,array['PREPARING_SCOPE']
  );

  v_expected_project := case p_repository_name
    when 'kdmanage-backend' then 'kwork/manage/kdmanage-backend'
    when 'kdmanage-frontend' then 'kwork/manage/kdmanage-frontend'
    when 'tmanage-backend' then 'kwork/manage/tmanage-backend'
    when 'tmanage-frontend' then 'kwork/manage/tmanage-frontend'
    else null
  end;
  if v_expected_project is null then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;
  if p_status not in ('UNAVAILABLE','COMPLETE','PARTIAL','FAILED') then
    raise exception 'MR_ENRICHMENT_STATUS_INVALID';
  end if;
  if (p_status = 'COMPLETE' and nullif(btrim(coalesce(p_error_code,'')),'') is not null)
     or (p_status <> 'COMPLETE' and nullif(btrim(coalesce(p_error_code,'')),'') is null) then
    raise exception 'MR_ENRICHMENT_ERROR_CODE_INVALID';
  end if;
  if jsonb_typeof(p_merge_requests) <> 'array'
     or jsonb_array_length(p_merge_requests) > 2000 then
    raise exception 'MR_METADATA_INPUT_INVALID';
  end if;
  if p_status in ('UNAVAILABLE','FAILED') and jsonb_array_length(p_merge_requests) <> 0 then
    raise exception 'MR_FAILED_STATUS_MUST_NOT_STORE_ROWS';
  end if;

  select * into v_snapshot
  from public.analysis_repository_snapshot
  where job_id=p_job_id and repository_name=p_repository_name
  for update;
  if v_snapshot.id is null then raise exception 'REPOSITORY_SNAPSHOT_NOT_FOUND'; end if;
  if v_snapshot.enumeration_status <> 'COMPLETE' or v_snapshot.commit_manifest_hash is null then
    raise exception 'COMMIT_MANIFEST_NOT_READY';
  end if;
  if exists(
    select 1
    from public.analysis_story_scope scope
    join public.analysis_story_task task on task.id=scope.task_id
    where task.job_id=p_job_id and scope.frozen_at is not null
  ) then raise exception 'ANALYSIS_SCOPE_ALREADY_FROZEN'; end if;

  delete from public.analysis_repository_merge_request where snapshot_id=v_snapshot.id;

  for v_mr in select * from jsonb_array_elements(p_merge_requests)
  loop
    if jsonb_typeof(v_mr) <> 'object'
       or v_mr->>'provider_project_id' is distinct from v_expected_project
       or coalesce((v_mr->>'merge_request_iid')::bigint,0) <= 0
       or coalesce(btrim(v_mr->>'title'),'') = ''
       or coalesce(btrim(v_mr->>'source_branch'),'') = ''
       or v_mr->>'target_branch' is distinct from v_job.requested_branch
       or coalesce(btrim(v_mr->>'author_username'),'') = ''
       or coalesce(btrim(v_mr->>'author_provider_id'),'') = ''
       or coalesce(v_mr->>'metadata_hash','') !~ '^(sha256:)?[0-9a-f]{64}$'
       or nullif(v_mr->>'provider_created_at','') is null
       or nullif(v_mr->>'provider_updated_at','') is null
       or nullif(v_mr->>'collected_at','') is null
       or jsonb_typeof(coalesce(v_mr->'structured_story_ids','[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_mr->'commits','[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(v_mr->'commits','[]'::jsonb)) > 5000 then
      raise exception 'MR_METADATA_INPUT_INVALID';
    end if;

    insert into public.analysis_repository_merge_request(
      snapshot_id,provider_project_id,merge_request_iid,source_branch,target_branch,
      title,description,structured_story_ids,author_display_name,author_username,
      author_provider_id,provider_created_at,provider_updated_at,merged_at,
      merge_commit_sha,squash_commit_sha,metadata_hash,collected_at
    ) values(
      v_snapshot.id,v_expected_project,(v_mr->>'merge_request_iid')::bigint,
      v_mr->>'source_branch',v_mr->>'target_branch',v_mr->>'title',
      nullif(v_mr->>'description',''),
      array(select value from jsonb_array_elements_text(
        coalesce(v_mr->'structured_story_ids','[]'::jsonb)
      ) value),
      nullif(v_mr->>'author_display_name',''),v_mr->>'author_username',
      v_mr->>'author_provider_id',(v_mr->>'provider_created_at')::timestamptz,
      (v_mr->>'provider_updated_at')::timestamptz,
      nullif(v_mr->>'merged_at','')::timestamptz,
      nullif(lower(v_mr->>'merge_commit_sha'),''),
      nullif(lower(v_mr->>'squash_commit_sha'),''),
      v_mr->>'metadata_hash',(v_mr->>'collected_at')::timestamptz
    ) returning id into v_mr_id;
    v_mr_count := v_mr_count + 1;

    for v_membership in select * from jsonb_array_elements(
      coalesce(v_mr->'commits','[]'::jsonb)
    )
    loop
      if lower(coalesce(v_membership->>'sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
         or v_membership->>'membership_type' not in ('COMMIT','MERGE_COMMIT','SQUASH_COMMIT')
         or (v_membership->>'membership_type'='MERGE_COMMIT'
             and lower(v_membership->>'sha') is distinct from lower(v_mr->>'merge_commit_sha'))
         or (v_membership->>'membership_type'='SQUASH_COMMIT'
             and lower(v_membership->>'sha') is distinct from lower(v_mr->>'squash_commit_sha')) then
        raise exception 'MR_COMMIT_MEMBERSHIP_INVALID';
      end if;

      select repo_commit.id into v_commit_id
      from public.analysis_repository_commit repo_commit
      where repo_commit.snapshot_id=v_snapshot.id
        and repo_commit.sha=lower(v_membership->>'sha');
      if v_commit_id is not null then
        insert into public.analysis_merge_request_commit(
          merge_request_id,commit_id,membership_type
        ) values(v_mr_id,v_commit_id,v_membership->>'membership_type')
        on conflict do nothing;
        if found then v_relation_count := v_relation_count + 1; end if;
      end if;
    end loop;
  end loop;

  update public.analysis_repository_snapshot
  set mr_enrichment_status=p_status,
      mr_enrichment_error_code=nullif(btrim(coalesce(p_error_code,'')),'')
  where id=v_snapshot.id;

  return jsonb_build_object(
    'snapshot_id',v_snapshot.id,
    'status',p_status,
    'merge_request_count',v_mr_count,
    'relation_count',v_relation_count
  );
end;
$$;

revoke execute on function public.save_analysis_repository_merge_requests(
  uuid,text,text,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.save_analysis_repository_merge_requests(
  uuid,text,text,text,text,jsonb
) to service_role;

revoke all on table public.analysis_repository_merge_request from anon,authenticated;
revoke all on table public.analysis_merge_request_commit from anon,authenticated;
grant select,insert,update,delete on table public.analysis_repository_merge_request to service_role;
grant select,insert,update,delete on table public.analysis_merge_request_commit to service_role;

comment on function public.save_analysis_repository_merge_requests(uuid,text,text,text,text,jsonb) is
  'Service-role-only V2 preparation write. Job/worker fenced; persists optional GitLab MR metadata and only relates commits already frozen in the repository manifest.';
comment on column public.analysis_repository_snapshot.mr_enrichment_status is
  'UNAVAILABLE means no API capability; PARTIAL/FAILED are auxiliary MR failures and never invalidate the core Git manifest.';

commit;
