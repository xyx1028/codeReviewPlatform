begin;

create index if not exists idx_review_batch_created_by on public.review_batch(created_by);

create or replace function public.can_create_review_batch()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.user_profile profile
    where profile.id = (select auth.uid())
      and profile.role in ('ADMIN', 'REVIEWER')
  );
$$;

create or replace function public.can_manage_review_batch(p_batch_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.review_batch batch
    join public.user_profile profile on profile.id = (select auth.uid())
    where batch.id = p_batch_id
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  );
$$;

create or replace function public.ensure_manage_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_review_batch(p_batch_id) then
    raise exception 'batch management permission required';
  end if;
end;
$$;

create or replace function public.can_write_review_file(p_name text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.review_batch batch
    join public.user_profile profile on profile.id = (select auth.uid())
    where batch.id::text = split_part(p_name, '/', 1)
      and split_part(p_name, '/', 2) in ('source', 'ai-result', 'template')
      and nullif(split_part(p_name, '/', 3), '') is not null
      and batch.status <> 'COMPLETED'
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  );
$$;

create or replace function public.can_delete_review_file(p_name text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.review_batch batch
    join public.user_profile profile on profile.id = (select auth.uid())
    where batch.id::text = split_part(p_name, '/', 1)
      and split_part(p_name, '/', 2) in ('source', 'ai-result', 'template')
      and nullif(split_part(p_name, '/', 3), '') is not null
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  );
$$;

create or replace function public.claim_initial_admin()
returns public.user_profile
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.user_profile;
begin
  if v_user_id is null then
    raise exception 'login required';
  end if;

  if not exists (
    select 1
    from public.user_profile profile
    where profile.id = v_user_id and profile.role = 'REVIEWER'
  ) then
    raise exception 'REVIEWER role required';
  end if;

  if exists (select 1 from public.user_profile where role = 'ADMIN' and id <> v_user_id) then
    raise exception 'ADMIN already exists';
  end if;

  update public.user_profile
  set role = 'ADMIN'
  where id = v_user_id
  returning * into v_profile;

  return v_profile;
end;
$$;

create or replace function public.ensure_batch_import_file(
  p_batch_id uuid,
  p_storage_path text,
  p_folder text
)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if p_storage_path !~ ('^' || p_batch_id::text || '/' || p_folder || '/.+') then
    raise exception 'invalid storage path';
  end if;

  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'review-files'
      and object.name = p_storage_path
  ) then
    raise exception 'storage file not found';
  end if;
end;
$$;

drop policy if exists "admins insert batches" on public.review_batch;
create policy "batch creators insert batches" on public.review_batch
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.can_create_review_batch()
);

drop policy if exists "reviewers write own human reviews" on public.human_review;
create policy "batch managers insert human reviews" on public.human_review
for insert to authenticated
with check (
  exists (
    select 1
    from public.review_story story
    join public.ai_review_result result on result.id = human_review.ai_review_result_id and result.story_id = story.id
    join public.review_batch batch on batch.id = story.batch_id
    join public.user_profile profile on profile.id = (select auth.uid())
    where story.id = human_review.story_id
      and human_review.reviewer_id = (select auth.uid())
      and batch.status <> 'COMPLETED'
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  )
);

drop policy if exists "reviewers update own human reviews" on public.human_review;
create policy "batch managers update human reviews" on public.human_review
for update to authenticated
using (
  exists (
    select 1
    from public.review_story story
    join public.ai_review_result result on result.id = human_review.ai_review_result_id and result.story_id = story.id
    join public.review_batch batch on batch.id = story.batch_id
    join public.user_profile profile on profile.id = (select auth.uid())
    where story.id = human_review.story_id
      and human_review.reviewer_id = (select auth.uid())
      and batch.status <> 'COMPLETED'
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  )
)
with check (
  exists (
    select 1
    from public.review_story story
    join public.ai_review_result result on result.id = human_review.ai_review_result_id and result.story_id = story.id
    join public.review_batch batch on batch.id = story.batch_id
    join public.user_profile profile on profile.id = (select auth.uid())
    where story.id = human_review.story_id
      and human_review.reviewer_id = (select auth.uid())
      and batch.status <> 'COMPLETED'
      and (
        profile.role = 'ADMIN'
        or (profile.role = 'REVIEWER' and batch.created_by = (select auth.uid()))
      )
  )
);

drop policy if exists "admins upload review files" on storage.objects;
create policy "batch managers upload review files" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'review-files'
  and public.can_write_review_file(name)
);

drop policy if exists "admins update review files" on storage.objects;
create policy "batch managers update review files" on storage.objects
for update to authenticated
using (
  bucket_id = 'review-files'
  and public.can_write_review_file(name)
)
with check (
  bucket_id = 'review-files'
  and public.can_write_review_file(name)
);

drop policy if exists "admins delete review files" on storage.objects;
create policy "batch managers delete review files" on storage.objects
for delete to authenticated
using (
  bucket_id = 'review-files'
  and public.can_delete_review_file(name)
);

create or replace function public.confirm_source_import(
  p_batch_id uuid,
  p_file_name text,
  p_storage_path text,
  p_file_hash text,
  p_template_version text,
  p_stories jsonb,
  p_field_mapping jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file_id uuid;
  v_story jsonb;
  v_batch_status text;
begin
  perform public.ensure_manage_review_batch(p_batch_id);
  perform public.ensure_batch_import_file(p_batch_id, p_storage_path, 'source');

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  if jsonb_typeof(p_stories) <> 'array' or jsonb_array_length(p_stories) = 0 then
    raise exception 'stories must be a non-empty array';
  end if;

  insert into public.import_file (batch_id, file_type, file_name, storage_path, file_hash, template_version, field_mapping, uploaded_by)
  values (
    p_batch_id,
    'SOURCE',
    p_file_name,
    p_storage_path,
    p_file_hash,
    p_template_version,
    coalesce(p_field_mapping, '{}'::jsonb) - 'description' - 'acceptance_criteria',
    (select auth.uid())
  )
  returning id into v_file_id;

  for v_story in select * from jsonb_array_elements(p_stories)
  loop
    insert into public.review_story (
      batch_id,
      story_code,
      story_name,
      owners_text,
      project_name,
      cloud_name,
      application_name,
      iteration_name,
      release_window,
      source_status,
      source_data
    ) values (
      p_batch_id,
      v_story->>'story_code',
      v_story->>'story_name',
      coalesce(nullif(v_story->>'owners_text', ''), '未分配'),
      nullif(v_story->>'project_name', ''),
      nullif(v_story->>'cloud_name', ''),
      nullif(v_story->>'application_name', ''),
      nullif(v_story->>'iteration_name', ''),
      nullif(v_story->>'release_window', ''),
      nullif(v_story->>'source_status', ''),
      coalesce(v_story->'source_data', '{}'::jsonb) - 'description' - 'acceptance_criteria'
    );
  end loop;

  update public.review_batch
  set status = 'WAITING_AI_RESULT'
  where id = p_batch_id and status in ('DRAFT', 'WAITING_AI_RESULT');

  return v_file_id;
end;
$$;

create or replace function public.confirm_ai_result_import(
  p_batch_id uuid,
  p_file_name text,
  p_storage_path text,
  p_file_hash text,
  p_template_version text,
  p_baseline_branch text,
  p_baseline_commit text,
  p_ai_model text,
  p_analyzed_at timestamptz,
  p_results jsonb,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file_id uuid;
  v_import_id uuid;
  v_version integer;
  v_result jsonb;
  v_evidence jsonb;
  v_story_id uuid;
  v_result_id uuid;
  v_batch_status text;
begin
  perform public.ensure_manage_review_batch(p_batch_id);
  perform public.ensure_batch_import_file(p_batch_id, p_storage_path, 'ai-result');

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already imported for this batch; delete and recreate the batch to import again';
  end if;

  if jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be an array';
  end if;

  insert into public.import_file (batch_id, file_type, file_name, storage_path, file_hash, template_version, uploaded_by)
  values (p_batch_id, 'AI_RESULT', p_file_name, p_storage_path, p_file_hash, p_template_version, (select auth.uid()))
  returning id into v_file_id;

  select coalesce(max(version), 0) + 1 into v_version from public.ai_import_record where batch_id = p_batch_id;

  update public.ai_import_record set is_active = false where batch_id = p_batch_id;

  insert into public.ai_import_record (
    batch_id,
    import_file_id,
    version,
    baseline_branch,
    baseline_commit,
    ai_model,
    analyzed_at,
    imported_by,
    is_active
  ) values (
    p_batch_id,
    v_file_id,
    v_version,
    nullif(p_baseline_branch, ''),
    nullif(p_baseline_commit, ''),
    nullif(p_ai_model, ''),
    p_analyzed_at,
    (select auth.uid()),
    true
  ) returning id into v_import_id;

  for v_result in select * from jsonb_array_elements(p_results)
  loop
    select id into v_story_id from public.review_story where batch_id = p_batch_id and story_code = v_result->>'story_code';
    if v_story_id is null then
      raise exception 'unknown story code: %', v_result->>'story_code';
    end if;

    insert into public.ai_review_result (
      story_id,
      ai_import_record_id,
      verdict,
      confidence,
      summary,
      implemented_content,
      missing_content,
      risks,
      test_points,
      ai_remark
    ) values (
      v_story_id,
      v_import_id,
      nullif(v_result->>'verdict', ''),
      nullif(v_result->>'confidence', '')::integer,
      nullif(v_result->>'summary', ''),
      nullif(v_result->>'implemented_content', ''),
      nullif(v_result->>'missing_content', ''),
      nullif(v_result->>'risks', ''),
      nullif(v_result->>'test_points', ''),
      nullif(v_result->>'ai_remark', '')
    );
  end loop;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      select result.id into v_result_id
      from public.ai_review_result result
      join public.review_story story on story.id = result.story_id
      where result.ai_import_record_id = v_import_id and story.story_code = v_evidence->>'story_code';

      if v_result_id is null then
        raise exception 'evidence references story without result: %', v_evidence->>'story_code';
      end if;

      insert into public.ai_code_evidence (
        ai_review_result_id,
        repository_name,
        commit_sha,
        file_path,
        symbol_name,
        start_line,
        end_line,
        evidence_type,
        description
      ) values (
        v_result_id,
        v_evidence->>'repository_name',
        nullif(v_evidence->>'commit_sha', ''),
        v_evidence->>'file_path',
        nullif(v_evidence->>'symbol_name', ''),
        nullif(v_evidence->>'start_line', '')::integer,
        nullif(v_evidence->>'end_line', '')::integer,
        v_evidence->>'evidence_type',
        v_evidence->>'description'
      );
    end loop;
  end if;

  update public.review_batch set status = 'REVIEWING' where id = p_batch_id and status <> 'COMPLETED';
  return v_import_id;
end;
$$;

create or replace function public.set_active_ai_import(p_ai_import_record_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_batch_status text;
begin
  select batch_id into v_batch_id
  from public.ai_import_record
  where id = p_ai_import_record_id;

  if v_batch_id is null then
    raise exception 'AI import record not found';
  end if;

  perform public.ensure_manage_review_batch(v_batch_id);

  select status into v_batch_status from public.review_batch where id = v_batch_id;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  update public.ai_import_record set is_active = false where batch_id = v_batch_id;
  update public.ai_import_record set is_active = true where id = p_ai_import_record_id;
  update public.review_batch set status = 'REVIEWING' where id = v_batch_id and status <> 'COMPLETED';

  return p_ai_import_record_id;
end;
$$;

create or replace function public.complete_review_batch(p_batch_id uuid, p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending_count integer;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  select count(*) into v_pending_count
  from public.review_story story
  left join public.ai_import_record active_import on active_import.batch_id = story.batch_id and active_import.is_active
  left join public.ai_review_result result on result.story_id = story.id and result.ai_import_record_id = active_import.id
  left join public.human_review review on review.story_id = story.id and review.ai_review_result_id = result.id
  where story.batch_id = p_batch_id and result.id is not null and review.id is null;

  if v_pending_count > 0 and not p_force then
    raise exception '仍有 % 条需求未确认', v_pending_count;
  end if;

  update public.review_batch set status = 'COMPLETED', completed_at = now() where id = p_batch_id;

  insert into public.batch_operation_log (batch_id, action, pending_count, forced, performed_by)
  values (p_batch_id, 'COMPLETE', v_pending_count, p_force, (select auth.uid()));

  return v_pending_count;
end;
$$;

create or replace function public.reopen_review_batch(p_batch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  update public.review_batch set status = 'REVIEWING', completed_at = null where id = p_batch_id;

  insert into public.batch_operation_log (batch_id, action, performed_by)
  values (p_batch_id, 'REOPEN', (select auth.uid()));

  return p_batch_id;
end;
$$;

create or replace function public.delete_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  delete from storage.objects
  where bucket_id = 'review-files'
    and name like p_batch_id::text || '/%';

  delete from public.review_batch where id = p_batch_id;
end;
$$;

revoke execute on function public.claim_initial_admin() from public, anon;
revoke execute on function public.can_create_review_batch() from public, anon;
revoke execute on function public.can_manage_review_batch(uuid) from public, anon;
revoke execute on function public.ensure_manage_review_batch(uuid) from public, anon, authenticated;
revoke execute on function public.can_write_review_file(text) from public, anon;
revoke execute on function public.can_delete_review_file(text) from public, anon;
revoke execute on function public.ensure_batch_import_file(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) from public, anon;
revoke execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) from public, anon;
revoke execute on function public.set_active_ai_import(uuid) from public, anon;
revoke execute on function public.complete_review_batch(uuid, boolean) from public, anon;
revoke execute on function public.reopen_review_batch(uuid) from public, anon;
revoke execute on function public.delete_review_batch(uuid) from public, anon;

grant execute on function public.claim_initial_admin() to authenticated;
grant execute on function public.can_create_review_batch() to authenticated;
grant execute on function public.can_manage_review_batch(uuid) to authenticated;
grant execute on function public.can_write_review_file(text) to authenticated;
grant execute on function public.can_delete_review_file(text) to authenticated;
grant execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) to authenticated;
grant execute on function public.set_active_ai_import(uuid) to authenticated;
grant execute on function public.complete_review_batch(uuid, boolean) to authenticated;
grant execute on function public.reopen_review_batch(uuid) to authenticated;
grant execute on function public.delete_review_batch(uuid) to authenticated;

commit;
