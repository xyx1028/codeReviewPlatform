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
  perform public.ensure_admin();

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status is null then
    raise exception 'batch not found';
  end if;
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

revoke execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) to authenticated;
