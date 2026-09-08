begin;

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
  perform public.ensure_admin();

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status is null then
    raise exception 'batch not found';
  end if;
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

revoke execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb, jsonb) to authenticated;

update public.import_file
set field_mapping = coalesce(field_mapping, '{}'::jsonb) - 'description' - 'acceptance_criteria'
where field_mapping ?| array['description', 'acceptance_criteria'];

update public.review_story
set source_data = coalesce(source_data, '{}'::jsonb) - 'description' - 'acceptance_criteria'
where source_data ?| array['description', 'acceptance_criteria'];

alter table public.review_story
  drop column description,
  drop column acceptance_criteria;

commit;
