-- V1.23d 产品代码问答：一个会话支持选择**多个**仓库。
--
-- 为什么要改：产品的问题经常天然跨仓。「工单转派之后前端待办列表怎么刷新」横跨
-- kdmanage-backend 与 kdmanage-frontend；让用户开两个会话分别问，等于把"联起来看"这件
-- 事推回给最不熟悉工程细节的人。
--
-- ## 数据结构的变化
--
-- `repository text` → `repositories text[]`；`commit_sha text` → `commit_shas jsonb`
-- （`{"<repo>": "<sha>", ...}`，每个仓库各自冻结一次）。
--
-- **`branch` 仍然是会话级的单值。** 刻意不做"每个仓库各选一个分支"：那会让"这个会话在看
-- 哪一版代码"变成一张需要逐行读的表，而产品要回答的问题是"release 上现在是怎么做的"。
-- 五个仓库共用同一套分支名（feature_dev / feature_sit / release），所以一个分支名足够。
--
-- ## 为什么不保留旧列做兼容
--
-- 旧列**直接删掉**，不留 `repository`。这张表是 V1.23 当天新建的，只在本地跑过冒烟，
-- 云端还没有任何真实会话（云端尚未推送 V1.23 的任何迁移）。留一个永远为空的兼容列，
-- 代价是后面每个读它的地方都要判断"到底该看哪一列"——那种分叉最后总会有人看错。
--
-- 如果执行这份迁移时库里已经有会话行，下面的回填会把单仓库值搬进新列，不丢数据。
--
-- 幂等：`add column if not exists` + `create or replace`。

------------------------------------------------------------------------------
-- 1. 新列 + 回填 + 去掉旧列
------------------------------------------------------------------------------

alter table public.code_qa_conversation
  add column if not exists repositories text[],
  add column if not exists commit_shas jsonb not null default '{}'::jsonb;

-- 回填：把既有单仓库会话搬进数组/映射。只在旧列还存在时执行。
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'code_qa_conversation'
      and column_name = 'repository'
  ) then
    update public.code_qa_conversation
    set repositories = coalesce(repositories, array[repository])
    where repositories is null;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'code_qa_conversation'
        and column_name = 'commit_sha'
    ) then
      update public.code_qa_conversation
      set commit_shas = jsonb_build_object(repository, commit_sha)
      where commit_sha is not null and commit_shas = '{}'::jsonb;
    end if;
  end if;
end $$;

-- 旧约束先拆掉，否则删列会被它挡住。
alter table public.code_qa_conversation
  drop constraint if exists code_qa_conversation_repository_allowed;

alter table public.code_qa_conversation drop column if exists repository;
alter table public.code_qa_conversation drop column if exists commit_sha;

alter table public.code_qa_conversation
  alter column repositories set not null;

/*
 * 仓库集合的校验：非空、无重复、全部在白名单内、有数量上限。
 *
 * 封装成 immutable 函数而不是直接写进 CHECK：**CHECK 约束里不允许子查询**，而去重判定
 * （distinct 计数）必须用子查询。函数体里可以。
 *
 * 上限取白名单的全部数量（`analysis_allowed_repository_count()`）——不写死 5，加仓库时
 * 这条校验自己跟着走。数量上限本身是必要的：每个仓库都要浅克隆一份快照并挂进同一个
 * Agent 的上下文，无上限意味着一次提问可以让 Worker 拉五个仓再加载全部目录树。
 */
create or replace function public.code_qa_repositories_valid(p_repositories text[])
returns boolean
language sql
immutable
as $$
  select p_repositories is not null
     and array_length(p_repositories, 1) is not null
     and array_length(p_repositories, 1) >= 1
     and array_length(p_repositories, 1) <= public.analysis_allowed_repository_count()
     and p_repositories <@ public.analysis_allowed_repository_names()
     -- 无重复：同一个仓库挂两次会让快照与提示词都出现两份。
     and array_length(p_repositories, 1) = (
       select count(distinct r) from unnest(p_repositories) as r
     );
$$;

revoke execute on function public.code_qa_repositories_valid(text[]) from public, anon;
grant execute on function public.code_qa_repositories_valid(text[]) to authenticated, service_role;

alter table public.code_qa_conversation
  drop constraint if exists code_qa_conversation_repositories_valid,
  add constraint code_qa_conversation_repositories_valid
    check (public.code_qa_repositories_valid(repositories));

comment on column public.code_qa_conversation.repositories is
  'V1.23d: one conversation may span several whitelisted repositories, because product '
  'questions often cross backend/frontend. Branch stays a single session-level value.';

comment on column public.code_qa_conversation.commit_shas is
  'V1.23d: {"<repository>": "<sha>"} frozen per repository on the first turn that '
  'resolves it. Never rewritten: a later turn must reference the same code the earlier '
  'answers described.';

------------------------------------------------------------------------------
-- 2. 投影与读接口
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
    -- dsh_session_id 刻意不出给浏览器：它是 Worker 侧的内部定位，产品看不懂也用不着，
    -- 而暴露它等于把 Session 卷上的路径线索交给前端。
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

/*
 * 建会话：仓库参数从单值变成数组。
 *
 * 签名变了（text → text[]），所以必须先 drop 旧重载 —— `create or replace` 改不了签名，
 * 它会留下一条不带新校验的旧调用路径，而那条路径就是绕过多仓库约束的后门。
 */
drop function if exists public.create_code_qa_conversation(text, text, text);

create or replace function public.create_code_qa_conversation(
  p_repositories text[],
  p_branch text,
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
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- 去重 + 排序。排序让提示词与快照顺序稳定（同一组仓库不会因为勾选顺序不同而变成
  -- 两份不同的上下文）；去重在这里做而不是只靠 CHECK，是为了给用户一个宽容的入口。
  select array_agg(distinct r order by r) into v_repositories
  from unnest(coalesce(p_repositories, '{}'::text[])) as r
  where nullif(btrim(r), '') is not null;

  if v_repositories is null or array_length(v_repositories, 1) = 0 then
    raise exception 'CODE_QA_REPOSITORY_REQUIRED';
  end if;

  insert into public.code_qa_conversation (owner_id, title, repositories, branch)
  values (
    auth.uid(),
    coalesce(nullif(btrim(p_title), ''), '新对话'),
    v_repositories,
    p_branch
  )
  returning * into v_new;

  return public.code_qa_conversation_to_jsonb(v_new);
end;
$$;

revoke execute on function public.create_code_qa_conversation(text[], text, text)
  from public, anon;
grant execute on function public.create_code_qa_conversation(text[], text, text)
  to authenticated, service_role;

------------------------------------------------------------------------------
-- 3. Worker 认领：交出仓库集合与已冻结的 SHA 映射
------------------------------------------------------------------------------

create or replace function public.claim_next_code_qa_turn(
  p_worker_id text,
  p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
  v_conversation public.code_qa_conversation;
  v_claim_token uuid;
  v_lease interval;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  v_lease := make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60));

  select * into v_turn
  from public.code_qa_turn
  where status = 'QUEUED'
  order by created_at
  for update skip locked
  limit 1;

  if v_turn.id is null then
    return null;
  end if;

  if v_turn.model_config_id is null
     or v_turn.base_url_snapshot is null
     or v_turn.model_name_snapshot is null then
    update public.code_qa_turn
    set status = 'FAILED',
        stage = 'DONE',
        error_code = 'MODEL_CONFIG_NOT_FOUND',
        error_message = '这一轮没有冻结模型配置',
        finished_at = now()
    where id = v_turn.id;
    return null;
  end if;

  v_claim_token := gen_random_uuid();
  update public.code_qa_turn
  set status = 'RUNNING',
      stage = 'PREPARING_CODE',
      worker_id = p_worker_id,
      claim_token_digest = public.agent_claim_token_digest(v_claim_token),
      lease_expires_at = now() + v_lease,
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = v_turn.id
  returning * into v_turn;

  select * into v_conversation
  from public.code_qa_conversation
  where id = v_turn.conversation_id;

  return jsonb_build_object(
    'turn_id', v_turn.id,
    'worker_id', p_worker_id,
    'claim_token', v_claim_token,
    'conversation_id', v_conversation.id,
    'question', v_turn.question,
    'repositories', to_jsonb(v_conversation.repositories),
    'branch', v_conversation.branch,
    'commit_shas', v_conversation.commit_shas,
    'dsh_session_id', v_conversation.dsh_session_id,
    'skill_catalog_hash', v_conversation.skill_catalog_hash,
    'asked_by', v_turn.asked_by,
    'owner_id', v_conversation.owner_id,
    'model_config_id', v_turn.model_config_id,
    'base_url_snapshot', v_turn.base_url_snapshot,
    'model_name_snapshot', v_turn.model_name_snapshot,
    'request_timeout_ms_snapshot', v_turn.request_timeout_ms_snapshot,
    'network_access_mode_snapshot', v_turn.network_access_mode_snapshot,
    'max_output_tokens_snapshot', v_turn.max_output_tokens_snapshot
  );
end;
$$;

revoke execute on function public.claim_next_code_qa_turn(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_code_qa_turn(text, integer) to service_role;

------------------------------------------------------------------------------
-- 4. 按仓库冻结 commit
------------------------------------------------------------------------------

/*
 * 签名从 `(turn, worker, token, sha)` 变成 `(turn, worker, token, repository, sha)`。
 * 先 drop 旧重载：留着它等于留一条能把 SHA 写到"没有仓库归属"的位置的旧路径。
 */
drop function if exists public.bind_code_qa_conversation_snapshot(uuid, text, uuid, text);

create or replace function public.bind_code_qa_conversation_snapshot(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_repository text,
  p_commit_sha text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
  v_conversation public.code_qa_conversation;
  v_existing text;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  if p_commit_sha is null or p_commit_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'CODE_QA_COMMIT_SHA_INVALID';
  end if;

  select * into v_conversation
  from public.code_qa_conversation
  where id = v_turn.conversation_id
  for update;

  -- 只能给**这个会话选中的**仓库冻结 SHA。否则一个写错仓库名的 Worker 会往映射里塞一个
  -- 永远不会被读到的键，而那种错误没有任何症状。
  if not (p_repository = any (v_conversation.repositories)) then
    raise exception 'CODE_QA_REPOSITORY_NOT_IN_CONVERSATION';
  end if;

  v_existing := v_conversation.commit_shas ->> p_repository;
  if v_existing is not null then
    -- 已经冻结过：返回既有值，不覆盖。会话前几轮的答案是基于那一版说的。
    return v_existing;
  end if;

  update public.code_qa_conversation
  set commit_shas = commit_shas || jsonb_build_object(p_repository, p_commit_sha),
      updated_at = now()
  where id = v_turn.conversation_id;

  return p_commit_sha;
end;
$$;

revoke execute on function public.bind_code_qa_conversation_snapshot(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bind_code_qa_conversation_snapshot(uuid, text, uuid, text, text)
  to service_role;
