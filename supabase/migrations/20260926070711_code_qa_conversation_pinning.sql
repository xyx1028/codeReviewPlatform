-- V1.30：产品代码问答会话置顶。
--
-- pinned_at 是每个 owner 的会话置顶事实：非空即已置顶，并以时间决定置顶组内顺序。
-- 不给浏览器表级 update；所有变更经 owner 校验后的 authenticated RPC 完成。

alter table public.code_qa_conversation
  add column if not exists pinned_at timestamptz;

comment on column public.code_qa_conversation.pinned_at is
  'V1.30: non-null means this owner has pinned the code Q&A conversation; timestamp orders pinned conversations newest first.';

create index if not exists idx_code_qa_conversation_owner_pinned
  on public.code_qa_conversation(owner_id, pinned_at desc)
  where pinned_at is not null;

-- 所有浏览器投影共用此函数；只暴露状态，不暴露排序实现细节。
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
    'is_pinned', p_conversation.pinned_at is not null,
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

-- 置顶会话永远位于普通会话之前；各组内保持自身的稳定业务顺序。
create or replace function public.list_code_qa_conversations()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select coalesce(jsonb_agg(row order by pinned_at desc nulls last, activity_at desc), '[]'::jsonb)
    into v_rows
  from (
    select
      public.code_qa_conversation_to_jsonb(conversation)
        || jsonb_build_object('turn_count', (
             select count(*) from public.code_qa_turn turn
             where turn.conversation_id = conversation.id
           )) as row,
      conversation.pinned_at,
      coalesce(conversation.last_turn_at, conversation.created_at) as activity_at
    from public.code_qa_conversation conversation
    where conversation.owner_id = auth.uid()
  ) entries;

  return v_rows;
end;
$$;

revoke execute on function public.list_code_qa_conversations() from public, anon;
grant execute on function public.list_code_qa_conversations() to authenticated, service_role;

create or replace function public.set_code_qa_conversation_pinned(
  p_conversation_id uuid,
  p_is_pinned boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated public.code_qa_conversation;
begin
  perform public.assert_code_qa_conversation_owner(p_conversation_id);

  if p_is_pinned is null then
    raise exception 'CODE_QA_PINNED_REQUIRED';
  end if;

  update public.code_qa_conversation
  set pinned_at = case
                    when p_is_pinned then coalesce(pinned_at, now())
                    else null
                  end,
      updated_at = now()
  where id = p_conversation_id
  returning * into v_updated;

  return public.code_qa_conversation_to_jsonb(v_updated);
end;
$$;

revoke execute on function public.set_code_qa_conversation_pinned(uuid, boolean)
  from public, anon;
grant execute on function public.set_code_qa_conversation_pinned(uuid, boolean)
  to authenticated, service_role;