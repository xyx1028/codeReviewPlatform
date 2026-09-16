-- Follow the current requirement-export format: track 需求人员 / 测试人员, retire 所属应用.
--
-- Why:
--   * The upstream requirement platform switched to a new export layout that has no
--     application column at all. It does expose 需求人员 (requirement handlers) and
--     测试人员 (test handlers), which is what reviewers actually group by now.
--   * owners_text ("负责人") is re-pointed at 开发人员 by the importer, so the review
--     dashboard's owner breakdown becomes a developer breakdown. That is a client-side
--     mapping change only; the column keeps its meaning of "who owns delivery".
--
-- Migration policy for application_name:
--   The column is KEPT and simply no longer written, mirroring what 0005 did for
--   description / acceptance_criteria. Dropping it would destroy the值 already imported
--   for historical batches, and claim_next_story_task / get_analysis_runtime_console
--   still read it. Those functions keep working and will just observe NULL for new
--   imports, so they are intentionally left untouched here.
begin;

alter table public.review_story add column if not exists requirement_handlers text;
alter table public.review_story add column if not exists test_handlers text;

comment on column public.review_story.requirement_handlers is
  '需求人员，来自新版导出的 tf_req_handlers 列。';
comment on column public.review_story.test_handlers is
  '测试人员，来自新版导出的 tf_test_handlers 列。';
comment on column public.review_story.owners_text is
  '负责人。新版导出映射自 开发人员（tf_dev_handlers）；旧版导出映射自 负责人 列。';
comment on column public.review_story.application_name is
  '已停用：新版导出没有应用维度，confirm_source_import 不再写入。仅为历史批次保留。';

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
    coalesce(p_field_mapping, '{}'::jsonb) - 'description' - 'acceptance_criteria' - 'application_name',
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
      iteration_name,
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

revoke execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) to authenticated;

commit;
