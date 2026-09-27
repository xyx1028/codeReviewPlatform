-- V1.34：代码证据的短概述由模型生成、Worker 验证后随最终结果入库。
-- 历史自动分析与人工 Excel 导入没有该字段，保留 NULL 并由前端安全降级显示原说明。

begin;

alter table public.ai_code_evidence
  add column if not exists evidence_summary text;

alter table public.ai_code_evidence
  drop constraint if exists ai_code_evidence_evidence_summary_check;
alter table public.ai_code_evidence
  add constraint ai_code_evidence_evidence_summary_check
  check (
    evidence_summary is null
    or (
      evidence_summary = btrim(evidence_summary)
      and char_length(evidence_summary) between 8 and 80
      and evidence_summary !~ E'[\\r\\n]'
    )
  );

comment on column public.ai_code_evidence.evidence_summary is
  'V1.34：AI 生成、面向评审列表的单行短概述；NULL 表示历史或人工导入证据。';

CREATE OR REPLACE FUNCTION public.complete_analysis_job(p_job_id uuid, p_worker_id text, p_results jsonb, p_evidence jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job public.analysis_job;
  v_batch public.review_batch;
  v_import_id uuid;
  v_version integer;
  v_result jsonb;
  v_evidence jsonb;
  v_story_id uuid;
  v_result_id uuid;
  v_pending integer;
  v_snapshot_count integer;
  v_model_label text;
  v_required integer;
  v_provided integer;
  v_distinct integer;
  v_repo text;
  v_snap_sha text;
  v_start integer;
  v_end integer;
begin
  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  if v_job.status <> 'FINALIZING' then
    raise exception 'job is not in FINALIZING state (status=%)', v_job.status;
  end if;
  if v_job.finalizer_worker_id is distinct from p_worker_id
     or v_job.finalize_lease_expires_at is null
     or v_job.finalize_lease_expires_at < now() then
    raise exception 'JOB_LEASE_LOST';
  end if;

  select count(*) into v_pending
  from public.analysis_story_task
  where job_id = p_job_id and agent_status <> 'SUCCEEDED';
  if v_pending > 0 then
    raise exception 'still % story task(s) not fully succeeded', v_pending;
  end if;

  select * into v_batch from public.review_batch where id = v_job.batch_id for update;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;
  if v_job.requested_branch is distinct from v_batch.default_branch then
    raise exception 'BATCH_BRANCH_CHANGED';
  end if;

  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;
  if v_snapshot_count <> public.analysis_allowed_repository_count() then
    raise exception 'repository snapshots incomplete (found %)', v_snapshot_count;
  end if;
  if jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be an array';
  end if;

  select count(*) into v_required from public.review_story where batch_id = v_job.batch_id;
  v_provided := jsonb_array_length(p_results);
  if v_provided <> v_required then
    raise exception 'results count % does not match required stories %', v_provided, v_required;
  end if;

  select count(distinct value->>'story_code') into v_distinct
  from jsonb_array_elements(p_results) as value;
  if v_distinct <> v_required then
    raise exception 'results must cover each story exactly once (distinct=%, required=%)',
      v_distinct, v_required;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_results) as value
    where not exists (
      select 1 from public.review_story story
      where story.batch_id = v_job.batch_id and story.story_code = value->>'story_code'
    )
  ) then
    raise exception 'results reference unknown story code';
  end if;

  v_model_label := coalesce(
    (v_job.model_snapshot->>'display_name') || ' / ' ||
    (v_job.model_snapshot->>'model_name') || ' / DeepSeek Harness Agent',
    'ai-automation / DeepSeek Harness Agent'
  );

  select coalesce(max(version), 0) + 1 into v_version
  from public.ai_import_record where batch_id = v_job.batch_id;

  update public.ai_import_record set is_active = false where batch_id = v_job.batch_id;

  insert into public.ai_import_record (
    batch_id, import_file_id, version, baseline_branch, baseline_commit,
    ai_model, analyzed_at, imported_by, is_active
  ) values (
    v_job.batch_id,
    null,
    v_version,
    v_batch.default_branch,
    jsonb_build_object(
      'actual_branch', v_batch.default_branch,
      'execution_engine', 'deepseek-harness-acp',
      'commits', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository', repository_name,
          'sha', commit_sha,
          'subject', commit_subject
        ) order by repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot where job_id = p_job_id
      )
    )::text,
    v_model_label,
    now(),
    v_job.requested_by,
    true
  ) returning id into v_import_id;

  for v_result in select * from jsonb_array_elements(p_results)
  loop
    select id into v_story_id from public.review_story
    where batch_id = v_job.batch_id and story_code = v_result->>'story_code';
    if v_story_id is null then
      raise exception 'unknown story code: %', v_result->>'story_code';
    end if;

    insert into public.ai_review_result (
      story_id, ai_import_record_id, verdict, confidence, summary,
      implemented_content, missing_content, risks, test_points, ai_remark
    ) values (
      v_story_id, v_import_id,
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
      v_repo := v_evidence->>'repository_name';

      select commit_sha into v_snap_sha
      from public.analysis_repository_snapshot
      where job_id = p_job_id and repository_name = v_repo;
      if v_snap_sha is null
         or coalesce(nullif(v_evidence->>'file_path', ''), '') = ''
         or (v_evidence->>'file_path') like '/%'
         or (v_evidence->>'file_path') like '%..%' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      v_start := nullif(v_evidence->>'start_line', '')::integer;
      v_end := nullif(v_evidence->>'end_line', '')::integer;
      if (v_start is not null and v_start < 1)
         or (v_end is not null and v_end < 1)
         or (v_start is not null and v_end is not null and v_start > v_end) then
        raise exception 'EVIDENCE_LINE_INVALID';
      end if;

      select result.id into v_result_id
      from public.ai_review_result result
      join public.review_story story on story.id = result.story_id
      where result.ai_import_record_id = v_import_id
        and story.story_code = v_evidence->>'story_code';
      if v_result_id is null then
        raise exception 'evidence references story without result: %',
          v_evidence->>'story_code';
      end if;

      insert into public.ai_code_evidence (
        ai_review_result_id, repository_name, commit_sha, file_path,
        symbol_name, start_line, end_line, evidence_type, evidence_summary, description
      ) values (
        v_result_id,
        v_repo,
        v_snap_sha,
        v_evidence->>'file_path',
        nullif(v_evidence->>'symbol_name', ''),
        v_start,
        v_end,
        v_evidence->>'evidence_type',
        nullif(btrim(v_evidence->>'evidence_summary'), ''),
        v_evidence->>'description'
      );
    end loop;
  end if;

  update public.review_batch set status = 'REVIEWING'
  where id = v_job.batch_id and status <> 'COMPLETED';

  update public.analysis_job
  set status = 'SUCCEEDED', finished_at = now()
  where id = p_job_id;

  return v_import_id;
end;
$function$;

commit;
