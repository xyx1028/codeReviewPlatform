-- V1.27：产品代码问答会话级模型单选。
--
-- 新会话必须显式选择一个启用且密钥可用的模型；之后每一轮只从这个会话模型冻结
-- 调用快照，绝不因为平台默认选型变化而悄悄换模型。历史会话没有该字段时保留 V1.23c
-- 的自动选型路径，避免前滚后旧会话无法继续提问。

------------------------------------------------------------------------------
-- 1. 会话模型事实
------------------------------------------------------------------------------

alter table public.code_qa_conversation
  add column if not exists selected_model_config_id uuid
    references public.ai_model_config(id) on delete restrict,
  add column if not exists selected_model_display_name text;

create index if not exists idx_code_qa_conversation_selected_model
  on public.code_qa_conversation(selected_model_config_id)
  where selected_model_config_id is not null;

comment on column public.code_qa_conversation.selected_model_config_id is
  'V1.27: model explicitly selected when this code Q&A conversation was created. '
  'Every later turn must use this config; NULL only preserves legacy pre-V1.27 conversations.';

comment on column public.code_qa_conversation.selected_model_display_name is
  'V1.27: display name snapshot taken with the session model selection; no secret or endpoint is stored here.';

-- 模型的端点或名称一旦被会话选择就不能再改。显示名和密钥轮换仍按既有规则可更新；
-- 轮次已有完整调用快照，密钥仅在 Worker 领取时读取。
create or replace function public.enforce_code_qa_selected_model_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.base_url is distinct from old.base_url or new.model_name is distinct from old.model_name)
     and exists (
       select 1
       from public.code_qa_conversation conversation
       where conversation.selected_model_config_id = old.id
     ) then
    raise exception 'base_url/model_name are immutable once selected by a code Q&A conversation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_code_qa_selected_model_immutable on public.ai_model_config;
create trigger enforce_code_qa_selected_model_immutable
before update of base_url, model_name on public.ai_model_config
for each row execute function public.enforce_code_qa_selected_model_immutable();

revoke execute on function public.enforce_code_qa_selected_model_immutable()
  from public, anon, authenticated;
grant execute on function public.enforce_code_qa_selected_model_immutable() to service_role;

------------------------------------------------------------------------------
-- 2. 浏览器投影与建会话 RPC
------------------------------------------------------------------------------

create or replace function public.code_qa_conversation_to_jsonb(
  p_conversation public.code_qa_conversation
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p_conversation.id,
    'title', p_conversation.title,
    'repositories', to_jsonb(p_conversation.repositories),
    'branch', p_conversation.branch,
    'commit_shas', p_conversation.commit_shas,
    'selected_model_config_id', p_conversation.selected_model_config_id,
    'selected_model_display_name', p_conversation.selected_model_display_name,
    'has_session', p_conversation.dsh_session_id is not null,
    'created_at', p_conversation.created_at,
    'updated_at', p_conversation.updated_at,
    'last_turn_at', p_conversation.last_turn_at
  );
$$;

revoke execute on function public.code_qa_conversation_to_jsonb(public.code_qa_conversation)
  from public, anon;
grant execute on function public.code_qa_conversation_to_jsonb(public.code_qa_conversation)
  to authenticated, service_role;

-- 签名加入模型 ID，必须删除旧重载；保留它会留下无需选择模型的绕过入口。
drop function if exists public.create_code_qa_conversation(text[], text, text);

create or replace function public.create_code_qa_conversation(
  p_repositories text[],
  p_branch text,
  p_model_config_id uuid,
  p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new public.code_qa_conversation;
  v_repositories text[];
  v_model public.ai_model_config;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_model_config_id is null then
    raise exception 'MODEL_CONFIG_REQUIRED';
  end if;

  select * into v_model
  from public.ai_model_config
  where id = p_model_config_id
  for key share;

  if v_model.id is null then
    raise exception 'MODEL_CONFIG_NOT_FOUND';
  end if;
  if not v_model.enabled then
    raise exception 'MODEL_CONFIG_DISABLED';
  end if;
  if not public.model_config_has_api_key(v_model.api_key_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  select array_agg(distinct r order by r) into v_repositories
  from unnest(coalesce(p_repositories, '{}'::text[])) as r
  where nullif(btrim(r), '') is not null;

  if v_repositories is null or array_length(v_repositories, 1) = 0 then
    raise exception 'CODE_QA_REPOSITORY_REQUIRED';
  end if;

  insert into public.code_qa_conversation (
    owner_id, title, repositories, branch,
    selected_model_config_id, selected_model_display_name
  ) values (
    auth.uid(),
    coalesce(nullif(btrim(p_title), ''), '新对话'),
    v_repositories,
    p_branch,
    v_model.id,
    v_model.display_name
  )
  returning * into v_new;

  return public.code_qa_conversation_to_jsonb(v_new);
end;
$$;

revoke execute on function public.create_code_qa_conversation(text[], text, uuid, text)
  from public, anon;
grant execute on function public.create_code_qa_conversation(text[], text, uuid, text)
  to authenticated, service_role;

------------------------------------------------------------------------------
-- 3. 入队时从会话模型冻结调用快照
------------------------------------------------------------------------------

create or replace function public.request_code_qa_turn(
  p_conversation_id uuid,
  p_question text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.code_qa_conversation;
  v_model public.ai_model_config;
  v_new public.code_qa_turn;
begin
  v_conversation := public.assert_code_qa_conversation_owner(p_conversation_id);

  if nullif(btrim(p_question), '') is null then
    raise exception 'CODE_QA_QUESTION_REQUIRED';
  end if;

  if exists (
    select 1 from public.code_qa_turn
    where conversation_id = p_conversation_id and status in ('QUEUED', 'RUNNING')
  ) then
    raise exception 'CODE_QA_TURN_IN_FLIGHT';
  end if;

  if v_conversation.selected_model_config_id is not null then
    select * into v_model
    from public.ai_model_config
    where id = v_conversation.selected_model_config_id;

    if v_model.id is null then
      -- 外键会阻止正常删除；此分支是防御性兜底，不能回退到其它模型。
      raise exception 'MODEL_CONFIG_NOT_FOUND';
    end if;
    if not v_model.enabled then
      raise exception 'MODEL_CONFIG_DISABLED';
    end if;
    if not public.model_config_has_api_key(v_model.api_key_secret_id) then
      raise exception 'MODEL_SECRET_MISSING';
    end if;
  else
    -- V1.27 前创建的历史会话没有用户选择事实，保留已有自动选型语义以保证兼容。
    select cfg.* into v_model
    from public.analysis_job job
    join public.ai_model_config cfg on cfg.id = job.model_config_id
    where cfg.enabled
      and public.model_config_has_api_key(cfg.api_key_secret_id)
    order by job.created_at desc, job.id desc
    limit 1;

    if v_model.id is null then
      select * into v_model
      from public.ai_model_config
      where enabled
        and public.model_config_has_api_key(api_key_secret_id)
      order by created_at desc, id desc
      limit 1;
    end if;

    if v_model.id is null then
      if exists (select 1 from public.ai_model_config where enabled) then
        raise exception 'MODEL_SECRET_MISSING';
      end if;
      raise exception 'MODEL_CONFIG_NOT_FOUND';
    end if;
  end if;

  insert into public.code_qa_turn (
    conversation_id, asked_by, question, status, stage,
    model_config_id, base_url_snapshot, model_name_snapshot,
    request_timeout_ms_snapshot, network_access_mode_snapshot, max_output_tokens_snapshot
  ) values (
    p_conversation_id, auth.uid(), btrim(p_question), 'QUEUED', 'QUEUED',
    v_model.id, v_model.base_url, v_model.model_name,
    v_model.request_timeout_ms, v_model.network_access_mode, v_model.max_output_tokens
  )
  returning * into v_new;

  update public.code_qa_conversation
  set last_turn_at = now(),
      updated_at = now(),
      title = case
        when title = '新对话' then left(btrim(p_question), 60)
        else title
      end
  where id = p_conversation_id;

  return jsonb_build_object(
    'id', v_new.id,
    'conversation_id', v_new.conversation_id,
    'question', v_new.question,
    'status', v_new.status,
    'stage', v_new.stage,
    'created_at', v_new.created_at
  );
exception when unique_violation then
  raise exception 'CODE_QA_TURN_IN_FLIGHT';
end;
$$;

revoke execute on function public.request_code_qa_turn(uuid, text) from public, anon;
grant execute on function public.request_code_qa_turn(uuid, text) to authenticated, service_role;
