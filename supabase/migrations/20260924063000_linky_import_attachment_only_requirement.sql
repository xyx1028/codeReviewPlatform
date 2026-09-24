-- V1.20 修订之二：需求正文为空但有附件时允许导入。
--
-- 实测撞到的真实数据：`US-2026-010727` 在 Linky 里 `gf_description` 与 `description` 都是
-- null，但挂了一个 `MCP服务页原型.html` 附件 —— 这条需求的内容就在附件里。
--
-- 上一版的 `LINKY_IMPORT_STORY_TEXT_REQUIRED` 会把它整条挡掉，于是"需求写在附件里"的
-- 团队根本没法用这个平台。而拦它的初衷是"别让 AI 在不知道需求内容的情况下判断代码" ——
-- 有附件时这个初衷并没有被违反：附件会随批次冻结、分析时物化进 workspace，Agent 读得到。
--
-- 所以门禁改成「至少要有一个需求来源」：正文或附件，二者有其一即可，两者都没有才拒绝。

begin;

create or replace function public.commit_linky_batch_story(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_story jsonb,
  p_attachments jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
  v_code text := btrim(coalesce(p_story ->> 'story_code', ''));
  v_detail text := nullif(btrim(coalesce(p_story ->> 'requirement_detail', '')), '');
  v_team jsonb := case when jsonb_typeof(p_story -> 'team') = 'object' then p_story -> 'team' else null end;
  v_attachment_count integer :=
    case when jsonb_typeof(p_attachments) = 'array' then jsonb_array_length(p_attachments) else 0 end;
  v_story_id uuid;
  v_attachments integer := 0;
  v_bytes bigint := 0;
begin
  v_request := public.assert_linky_batch_import_claim(p_request_id, p_worker_id, p_claim_token);

  if v_code = '' then raise exception 'LINKY_IMPORT_STORY_CODE_REQUIRED'; end if;
  if not (v_code = any(v_request.story_codes)) then
    -- 只允许提交这张单子上勾选过的故事，防止一个 Worker 往批次里塞别的需求。
    raise exception 'LINKY_IMPORT_STORY_NOT_REQUESTED';
  end if;
  if v_detail is null and v_attachment_count = 0 then
    -- 正文和附件都没有：这条需求在上游就是空的，导进来只会让 AI 去猜。
    raise exception 'LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE';
  end if;

  insert into public.review_story (
    batch_id, story_code, story_name, owners_text, requirement_handlers, test_handlers,
    project_name, iteration_name, release_window, source_status, source_data,
    source_system, requirement_detail, subject_name, linky_issue_id,
    linky_workspace_id, linky_workspace_name, story_url, synced_at
  ) values (
    v_request.batch_id,
    v_code,
    coalesce(nullif(btrim(coalesce(p_story ->> 'title', '')), ''), v_code),
    coalesce(
      nullif(public.linky_team_names(v_team, 'dev'), ''),
      nullif(btrim(coalesce(p_story ->> 'assignee_name', '')), ''),
      '未分配'
    ),
    public.linky_team_names(v_team, 'req'),
    public.linky_team_names(v_team, 'test'),
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'workspace_name', '')), ''),
      v_request.workspace_name
    ),
    nullif(btrim(coalesce(p_story ->> 'iteration', '')), ''),
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'release_window', '')), ''),
      v_request.release_window
    ),
    nullif(btrim(coalesce(p_story ->> 'status_label', '')), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'LINKY',
      'imported_by_request', to_jsonb(p_request_id),
      'linky_issue_id', p_story -> 'issue_id',
      'workspace_id', p_story -> 'workspace_id',
      'workspace_name', p_story -> 'workspace_name',
      'iteration', p_story -> 'iteration',
      'release_window', p_story -> 'release_window',
      'subject', p_story -> 'subject_name',
      'status_label', p_story -> 'status_label',
      'assignee', p_story -> 'assignee_name',
      'team', v_team,
      'team_resolve_error', p_story -> 'team_resolve_error',
      'field_values', p_story -> 'field_values',
      'list_item', p_story -> 'list_item'
    )),
    'LINKY',
    v_detail,
    nullif(btrim(coalesce(p_story ->> 'subject_name', '')), ''),
    nullif(p_story ->> 'issue_id', '')::uuid,
    nullif(p_story ->> 'workspace_id', '')::uuid,
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'workspace_name', '')), ''),
      v_request.workspace_name
    ),
    nullif(btrim(coalesce(p_story ->> 'story_url', '')), ''),
    now()
  )
  on conflict (batch_id, story_code) do update set
    story_name = excluded.story_name,
    owners_text = excluded.owners_text,
    requirement_handlers = excluded.requirement_handlers,
    test_handlers = excluded.test_handlers,
    project_name = excluded.project_name,
    iteration_name = excluded.iteration_name,
    release_window = excluded.release_window,
    source_status = excluded.source_status,
    source_data = excluded.source_data,
    source_system = excluded.source_system,
    requirement_detail = excluded.requirement_detail,
    subject_name = excluded.subject_name,
    linky_issue_id = excluded.linky_issue_id,
    linky_workspace_id = excluded.linky_workspace_id,
    linky_workspace_name = excluded.linky_workspace_name,
    story_url = excluded.story_url,
    synced_at = excluded.synced_at,
    updated_at = now()
  returning id into v_story_id;

  -- 附件按本次抓取结果整段重放：上游删了的附件不该留在批次里。
  delete from public.review_story_attachment where story_id = v_story_id;
  if v_attachment_count > 0 then
    insert into public.review_story_attachment (
      story_id, linky_attachment_id, filename, content_type, size_bytes,
      storage_path, content_sha256
    )
    select
      v_story_id,
      btrim(item ->> 'linky_attachment_id'),
      btrim(item ->> 'filename'),
      nullif(btrim(coalesce(item ->> 'content_type', '')), ''),
      nullif(item ->> 'size_bytes', '')::bigint,
      btrim(item ->> 'storage_path'),
      lower(btrim(item ->> 'sha256'))
    from jsonb_array_elements(p_attachments) as entry(item)
    where coalesce(item ->> 'linky_attachment_id', '') <> ''
      and coalesce(item ->> 'filename', '') <> ''
      and coalesce(item ->> 'storage_path', '') <> ''
      and lower(btrim(coalesce(item ->> 'sha256', ''))) ~ '^[0-9a-f]{64}$'
    on conflict (story_id, linky_attachment_id) do nothing;
    select count(*), coalesce(sum(size_bytes), 0) into v_attachments, v_bytes
    from public.review_story_attachment where story_id = v_story_id;
  end if;

  -- 正文和附件行都落空时拒绝：附件数组非空但每一条都形状不合法（少 sha256 之类）
  -- 也算"没有需求来源"，不能因为 p_attachments 长度非零就放行。
  if v_detail is null and coalesce(v_attachments, 0) = 0 then
    raise exception 'LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE';
  end if;

  update public.linky_batch_import_request
  set stories_committed = stories_committed + 1,
      attachments_stored = attachments_stored + coalesce(v_attachments, 0),
      bytes_downloaded = bytes_downloaded + coalesce(v_bytes, 0),
      updated_at = now()
  where id = p_request_id;

  return v_story_id;
end;
$$;

revoke execute on function public.commit_linky_batch_story(uuid, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_linky_batch_story(uuid, text, uuid, jsonb, jsonb)
  to service_role;

comment on function public.commit_linky_batch_story(uuid, text, uuid, jsonb, jsonb) is
  'V1.20：逐条提交一个批次需求。门禁是「至少一个需求来源」—— 正文或附件有其一即可；'
  '两者都没有以 LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE 拒绝。';

commit;
