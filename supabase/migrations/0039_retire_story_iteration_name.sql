-- Retire the iteration dimension: reviewers only track the release window.
--
-- Same policy as application_name in 0038: the column is KEPT and simply no longer
-- written, so historical batches keep the值 they were imported with. The importer no
-- longer produces an iteration_name key at all, which on its own would already make
-- `v_story->>'iteration_name'` resolve to NULL — dropping it from the insert list makes
-- that intent explicit instead of implicit.
begin;

comment on column public.review_story.iteration_name is
  '已停用：只关注发布窗口，confirm_source_import 不再写入。仅为历史批次保留。';
comment on column public.review_story.source_status is
  '需求在源系统里的状态，例如「提测完成」「基线测试完成」。统计看板按它分组下钻。';

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
    -- Strip retired keys so the persisted mapping never suggests a field we no longer honour.
    coalesce(p_field_mapping, '{}'::jsonb)
      - 'description' - 'acceptance_criteria' - 'application_name' - 'iteration_name',
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
      requirement_handlers,
      test_handlers,
      project_name,
      cloud_name,
      release_window,
      source_status,
      source_data
    ) values (
      p_batch_id,
      v_story->>'story_code',
      v_story->>'story_name',
      coalesce(nullif(v_story->>'owners_text', ''), '未分配'),
      nullif(v_story->>'requirement_handlers', ''),
      nullif(v_story->>'test_handlers', ''),
      nullif(v_story->>'project_name', ''),
      nullif(v_story->>'cloud_name', ''),
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

revoke execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) to authenticated;

commit;
