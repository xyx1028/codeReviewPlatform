-- V1.23 产品代码问答：会话 + 轮次（轮次同时是 Worker 队列行）
--
-- 这一版给产品经理一个对话入口，去问"某个仓库某个分支上，这个功能是怎么实现的"。
-- 回答由 Worker 侧的 DeepSeek Harness 会话产生：Agent 在钉死 commit 的只读快照上自己
-- grep / 读文件 / 按需调平台技能，所以这里**不存任何代码内容**，只存问题、答案和证据。
--
-- 设计要点（与 skill_ai_optimization 那条队列同构，差异都是刻意的）：
--
--   1. **仓库与分支挂在会话上，不在轮次上。** DSH 会话的历史是连续的，中途换仓库会让
--      模型带着 A 仓的上下文解释 B 仓的代码。换仓库就开新会话。
--   2. **commit_sha 在首轮冻结到会话行。** 多轮对话里"你刚才说的那个方法"必须指向同一份
--      代码；每轮重新解析分支头会让上一轮的引用悄悄失效。
--   3. **dsh_session_id 也在会话行上。** 第二轮起 Worker 用它 session/load 续跑，模型才
--      真的记得上文。它是 Worker 写入的事实，浏览器只读。
--   4. **stage 是事实阶段，不是计时器猜的。** 由 Worker 在真实转换点上报。
--
-- 幂等：全部 create ... if not exists / create or replace / drop policy if exists。

------------------------------------------------------------------------------
-- 1. 会话表
------------------------------------------------------------------------------

create table if not exists public.code_qa_conversation (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  title              text not null default '新对话',
  repository         text not null,
  branch             text not null,
  -- 首轮解析分支头之后由 Worker 冻结；在此之前为 null（页面显示"待拉取"）。
  commit_sha         text,
  -- DSH 会话 id。为 null 表示下一轮要 session/new。
  dsh_session_id     text,
  -- 首轮物化的技能目录身份。与当前目录不一致时拒绝续跑，而不是静默退化成空技能目录。
  skill_catalog_hash text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_turn_at       timestamptz
);

comment on table public.code_qa_conversation is
  'V1.23: one product-manager code Q&A conversation. Repository, branch and the '
  'resolved commit SHA are frozen per conversation (not per turn) so multi-turn '
  'references stay valid; dsh_session_id lets the worker resume the same DeepSeek '
  'Harness session on later turns. No code content is ever stored here.';

-- `create table if not exists` 对已存在的表是 no-op，所以新列必须显式 alter。
alter table public.code_qa_conversation
  add column if not exists commit_sha text,
  add column if not exists dsh_session_id text,
  add column if not exists skill_catalog_hash text;

-- 仓库与分支必须在白名单内。单一事实来源是 analysis_allowed_repository_names()，
-- 分支沿用 Worker 侧 ALLOWED_BRANCHES 的三个值。
alter table public.code_qa_conversation
  drop constraint if exists code_qa_conversation_repository_allowed,
  add constraint code_qa_conversation_repository_allowed
    check (repository = any (public.analysis_allowed_repository_names()));

alter table public.code_qa_conversation
  drop constraint if exists code_qa_conversation_branch_allowed,
  add constraint code_qa_conversation_branch_allowed
    check (branch in ('feature_dev', 'feature_sit', 'release'));

alter table public.code_qa_conversation
  drop constraint if exists code_qa_conversation_title_not_blank,
  add constraint code_qa_conversation_title_not_blank
    check (btrim(title) <> '' and length(title) <= 200);

create index if not exists idx_code_qa_conversation_owner
on public.code_qa_conversation(owner_id, coalesce(last_turn_at, created_at) desc);

alter table public.code_qa_conversation enable row level security;

-- 会话行本身可以让 owner 直读（列表页要它），但写入一律走 RPC：
-- 只给 select，不给 insert/update/delete —— 否则浏览器能把 commit_sha 或
-- dsh_session_id 改成别的值，而那两个是 Worker 侧的事实。
drop policy if exists code_qa_conversation_owner_select on public.code_qa_conversation;
create policy code_qa_conversation_owner_select
on public.code_qa_conversation
for select
to authenticated
using (owner_id = auth.uid());

------------------------------------------------------------------------------
-- 2. 轮次表（= 队列行）
------------------------------------------------------------------------------

create table if not exists public.code_qa_turn (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references public.code_qa_conversation(id) on delete cascade,
  asked_by           uuid references auth.users(id) on delete set null,
  question           text not null,
  status             text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  -- 真实阶段。只有 Worker 在实际转换点上报，页面照抄，不自己猜。
  stage              text not null default 'QUEUED'
    check (stage in ('QUEUED', 'PREPARING_CODE', 'EXPLORING', 'GENERATING', 'DONE')),
  worker_id          text,
  claim_token_digest text,
  lease_expires_at   timestamptz,
  heartbeat_at       timestamptz,
  -- 模型快照。入队时冻结，理由与 skill_ai_optimization 相同：Worker 是 service_role，
  -- 拿不到 authenticated-only 的 admin_* RPC，必须在这里就把调模型要的东西全给它。
  model_config_id    uuid references public.ai_model_config(id) on delete set null,
  base_url_snapshot           text,
  model_name_snapshot         text,
  request_timeout_ms_snapshot integer,
  network_access_mode_snapshot text,
  max_output_tokens_snapshot  integer,
  answer             text,
  -- commit_sha / files_read[] / skills_used[] / tool_call_count / resumed / update_count
  evidence           jsonb not null default '{}'::jsonb,
  error_code         text,
  error_message      text,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

comment on table public.code_qa_turn is
  'V1.23: one question/answer turn, and at the same time the worker queue row. '
  'The worker claims a QUEUED turn, prepares the conversation''s pinned snapshot, '
  'resumes (or creates) the DSH session and sends one session/prompt. Stores the '
  'answer text and a verifiable evidence object -- never code content.';

alter table public.code_qa_turn
  add column if not exists stage text not null default 'QUEUED',
  add column if not exists max_output_tokens_snapshot integer,
  add column if not exists evidence jsonb not null default '{}'::jsonb;

alter table public.code_qa_turn
  drop constraint if exists code_qa_turn_question_not_blank,
  add constraint code_qa_turn_question_not_blank
    check (btrim(question) <> '' and length(question) <= 4000);

create index if not exists idx_code_qa_turn_conversation
on public.code_qa_turn(conversation_id, created_at);

create index if not exists idx_code_qa_turn_queue
on public.code_qa_turn(status, created_at)
where status = 'QUEUED';

-- 同一会话同一时刻只允许一轮在飞。由唯一索引兜底而不是"先查再插"。
-- 它同时保证了 DSH 会话不会被两个 Worker 同时 load（那会破坏 JSONL 的单写者约束）。
create unique index if not exists uq_code_qa_turn_inflight
on public.code_qa_turn(conversation_id)
where status in ('QUEUED', 'RUNNING');

alter table public.code_qa_turn enable row level security;
-- 不开放任何 RLS 策略：只通过下面的 security definer RPC 读写。

------------------------------------------------------------------------------
-- 3. 归属校验与认领门禁
------------------------------------------------------------------------------

/*
 * 会话归属。所有 authenticated RPC 的第一句都是它。
 *
 * 不依赖 RLS：这些 RPC 是 security definer，RLS 对它们不生效。门禁必须显式写出来。
 */
create or replace function public.assert_code_qa_conversation_owner(p_conversation_id uuid)
returns public.code_qa_conversation
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.code_qa_conversation;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_conversation
  from public.code_qa_conversation
  where id = p_conversation_id;

  -- 不存在与不属于我，都回同一个错误码：否则这个 RPC 变成一个可以探测
  -- "某个 uuid 是否存在"的接口。
  if v_conversation.id is null or v_conversation.owner_id is distinct from auth.uid() then
    raise exception 'CODE_QA_CONVERSATION_NOT_FOUND';
  end if;

  return v_conversation;
end;
$$;

revoke execute on function public.assert_code_qa_conversation_owner(uuid) from public, anon;
grant execute on function public.assert_code_qa_conversation_owner(uuid) to authenticated, service_role;

create or replace function public.assert_code_qa_turn_claim(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns public.code_qa_turn
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
begin
  select * into v_turn
  from public.code_qa_turn
  where id = p_turn_id
  for update;

  if v_turn.id is null
     or v_turn.status <> 'RUNNING'
     or v_turn.worker_id is distinct from p_worker_id
     or v_turn.lease_expires_at is null
     or v_turn.lease_expires_at < now()
     or p_claim_token is null
     or v_turn.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  return v_turn;
end;
$$;

revoke execute on function public.assert_code_qa_turn_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_code_qa_turn_claim(uuid, text, uuid) to service_role;

------------------------------------------------------------------------------
-- 4. 目录：仓库 / 分支 / 可用技能
------------------------------------------------------------------------------

/*
 * 问答页要的三份清单。
 *
 * 技能这一份刻意**不复用** admin_list_review_skills()：那个 RPC 做 ensure_admin()，
 * 而问答的使用者是产品经理（多数是 VIEWER）。这里只暴露"有哪些模块技能、各自管什么"
 * 这类给人看的元数据，不含归档定位、hash、上传记录或容量水位。
 */
create or replace function public.code_qa_catalog()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_skills jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb) into v_skills
  from (
    select jsonb_build_object(
      'name', skill.name,
      'display_name', skill.display_name,
      'description', version.description,
      'when_to_use', version.when_to_use
    ) as row
    from public.review_skill skill
    join public.review_skill_version version on version.id = skill.current_version_id
    where skill.status = 'ENABLED'
  ) entries;

  return jsonb_build_object(
    'repositories', public.analysis_repository_catalog(),
    'branches', jsonb_build_array('feature_dev', 'feature_sit', 'release'),
    'skills', v_skills
  );
end;
$$;

revoke execute on function public.code_qa_catalog() from public, anon;
grant execute on function public.code_qa_catalog() to authenticated, service_role;

------------------------------------------------------------------------------
-- 5. 会话的读写（authenticated）
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
    'repository', p_conversation.repository,
    'branch', p_conversation.branch,
    'commit_sha', p_conversation.commit_sha,
    -- dsh_session_id 刻意不出给浏览器：它是 Worker 侧的内部定位，产品看不懂也用不着，
    -- 而暴露它等于把 Session 卷上的路径线索交给前端。
    'has_session', p_conversation.dsh_session_id is not null,
    'created_at', p_conversation.created_at,
    'updated_at', p_conversation.updated_at,
    'last_turn_at', p_conversation.last_turn_at
  );
$$;

-- 默认情况下新函数对 PUBLIC 可执行。这个投影函数只是个纯变换，但"能执行"就意味着
-- anon 可以把任意构造的行喂进来 —— 而且名字带 code_qa 的东西一律不留给匿名角色，
-- 省掉"这个够不够危险"的逐个判断。
revoke execute on function public.code_qa_conversation_to_jsonb(public.code_qa_conversation)
  from public, anon;
grant execute on function public.code_qa_conversation_to_jsonb(public.code_qa_conversation)
  to authenticated, service_role;

create or replace function public.create_code_qa_conversation(
  p_repository text,
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
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  insert into public.code_qa_conversation (owner_id, title, repository, branch)
  values (
    auth.uid(),
    coalesce(nullif(btrim(p_title), ''), '新对话'),
    p_repository,
    p_branch
  )
  returning * into v_new;

  return public.code_qa_conversation_to_jsonb(v_new);
end;
$$;

revoke execute on function public.create_code_qa_conversation(text, text, text) from public, anon;
grant execute on function public.create_code_qa_conversation(text, text, text)
  to authenticated, service_role;

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

  select coalesce(jsonb_agg(row order by sort_key desc), '[]'::jsonb) into v_rows
  from (
    select
      public.code_qa_conversation_to_jsonb(conversation)
        || jsonb_build_object('turn_count', (
             select count(*) from public.code_qa_turn turn
             where turn.conversation_id = conversation.id
           )) as row,
      coalesce(conversation.last_turn_at, conversation.created_at) as sort_key
    from public.code_qa_conversation conversation
    where conversation.owner_id = auth.uid()
  ) entries;

  return v_rows;
end;
$$;

revoke execute on function public.list_code_qa_conversations() from public, anon;
grant execute on function public.list_code_qa_conversations() to authenticated, service_role;

/*
 * 会话 + 全部轮次。前端轮询它。
 *
 * 轮次里不回 claim_token_digest / worker_id / 模型快照：那些是调度与审计事实，
 * 产品页面不需要，回出去只会扩大暴露面。
 */
create or replace function public.get_code_qa_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_conversation public.code_qa_conversation;
  v_turns jsonb;
begin
  v_conversation := public.assert_code_qa_conversation_owner(p_conversation_id);

  select coalesce(jsonb_agg(row order by created_at), '[]'::jsonb) into v_turns
  from (
    select jsonb_build_object(
      'id', turn.id,
      'question', turn.question,
      'status', turn.status,
      'stage', turn.stage,
      'answer', turn.answer,
      'evidence', turn.evidence,
      'error_code', turn.error_code,
      'error_message', turn.error_message,
      'model_label', model.display_name,
      'created_at', turn.created_at,
      'started_at', turn.started_at,
      'finished_at', turn.finished_at
    ) as row,
    turn.created_at
    from public.code_qa_turn turn
    left join public.ai_model_config model on model.id = turn.model_config_id
    where turn.conversation_id = p_conversation_id
  ) entries;

  return public.code_qa_conversation_to_jsonb(v_conversation)
    || jsonb_build_object('turns', v_turns);
end;
$$;

revoke execute on function public.get_code_qa_conversation(uuid) from public, anon;
grant execute on function public.get_code_qa_conversation(uuid) to authenticated, service_role;

create or replace function public.rename_code_qa_conversation(
  p_conversation_id uuid,
  p_title text
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

  if nullif(btrim(p_title), '') is null then
    raise exception 'CODE_QA_TITLE_REQUIRED';
  end if;

  update public.code_qa_conversation
  set title = btrim(p_title), updated_at = now()
  where id = p_conversation_id
  returning * into v_updated;

  return public.code_qa_conversation_to_jsonb(v_updated);
end;
$$;

revoke execute on function public.rename_code_qa_conversation(uuid, text) from public, anon;
grant execute on function public.rename_code_qa_conversation(uuid, text)
  to authenticated, service_role;

/*
 * 删除自己的会话。
 *
 * 在飞轮次挡住删除：Worker 正持有这个会话的 DSH session 与租约，删掉父行会让它在
 * 提交结果时撞 FK 失败，而那条失败没有任何地方能显示给用户。让用户先等一轮结束
 * （通常几十秒）比留一个不可解释的错误好。
 */
create or replace function public.delete_code_qa_conversation(p_conversation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_code_qa_conversation_owner(p_conversation_id);

  if exists (
    select 1 from public.code_qa_turn
    where conversation_id = p_conversation_id and status in ('QUEUED', 'RUNNING')
  ) then
    raise exception 'CODE_QA_TURN_IN_FLIGHT';
  end if;

  delete from public.code_qa_conversation where id = p_conversation_id;
  return true;
end;
$$;

revoke execute on function public.delete_code_qa_conversation(uuid) from public, anon;
grant execute on function public.delete_code_qa_conversation(uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 6. 入队一轮（authenticated）
------------------------------------------------------------------------------

/*
 * 模型选择：**最早创建的启用配置**。
 *
 * 与技能优化那条"跟着产出证据的那个模型"不同 —— 问答没有"证据出自哪个模型"这层因果。
 * 这里要的是确定性：同一时刻所有问答落在同一个模型上，答案口径一致，而"随便挑一个"会
 * 随管理员增删配置悄悄换模型。
 *
 * 没有启用配置、或配置没有 Key 时**入队即失败**（直接抛错，不建行）：让轮次进队列等一个
 * 永远不会好的条件，等于给用户一个永远转的进度条。
 */
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

  select * into v_model
  from public.ai_model_config
  where enabled
  order by created_at, id
  limit 1;

  if v_model.id is null then
    raise exception 'MODEL_CONFIG_NOT_FOUND';
  end if;
  if not public.model_config_has_api_key(v_model.api_key_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
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
      -- 第一个问题顺手当标题（截断），省掉"新对话"这种没信息的列表项。
      title = case
        when title = '新对话'
          then left(btrim(p_question), 60)
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
  -- 竞态兜底：两次几乎同时的提交都通过了上面的 exists 检查。
  raise exception 'CODE_QA_TURN_IN_FLIGHT';
end;
$$;

revoke execute on function public.request_code_qa_turn(uuid, text) from public, anon;
grant execute on function public.request_code_qa_turn(uuid, text) to authenticated, service_role;

------------------------------------------------------------------------------
-- 7. Worker 侧（service_role）
------------------------------------------------------------------------------

/*
 * 认领一轮。
 *
 * 返回值里带上 Worker 跑完这一轮需要的**全部**定位信息：仓库、分支、会话已冻结的 SHA、
 * DSH session id、技能目录身份、模型快照。理由与 skill_ai_optimization 相同 —— Worker 是
 * service_role，auth.uid() 是 null，它调不了任何 authenticated-only 的 RPC。
 *
 * claim_token 只在这次返回里出现一次，落库的只有摘要。
 */
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
    -- 入队时就该冻结好。冻不住说明这一行是被别的路径插进来的，直接判失败而不是
    -- 让 Worker 拿到半份数据去猜。
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
    'repository', v_conversation.repository,
    'branch', v_conversation.branch,
    'commit_sha', v_conversation.commit_sha,
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

create or replace function public.heartbeat_code_qa_turn(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);
  update public.code_qa_turn
  set lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60)),
      heartbeat_at = now()
  where id = p_turn_id;
  return true;
end;
$$;

revoke execute on function public.heartbeat_code_qa_turn(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_code_qa_turn(uuid, text, uuid, integer) to service_role;

/*
 * 上报真实阶段。页面照抄这个值。
 *
 * 只接受向前的阶段，不接受回退：PREPARING_CODE → EXPLORING → GENERATING。回退会让页面
 * 上的文字来回跳，而那种跳动只能是上报点写错了，不是真实发生的事。
 */
create or replace function public.report_code_qa_turn_stage(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_stage text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
  v_order constant text[] := array['QUEUED', 'PREPARING_CODE', 'EXPLORING', 'GENERATING', 'DONE'];
  v_current integer;
  v_next integer;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  v_current := array_position(v_order, v_turn.stage);
  v_next := array_position(v_order, p_stage);
  if v_next is null then
    raise exception 'CODE_QA_STAGE_INVALID';
  end if;
  if v_next <= v_current then
    return false;
  end if;

  update public.code_qa_turn set stage = p_stage where id = p_turn_id;
  return true;
end;
$$;

revoke execute on function public.report_code_qa_turn_stage(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.report_code_qa_turn_stage(uuid, text, uuid, text) to service_role;

/*
 * 首轮把解析出的 commit SHA 冻结到会话行。
 *
 * **只允许写一次。** 已经有值时不覆盖，直接返回既有值 —— 会话的代码基线一旦定下，
 * 后面每一轮都必须指向它（§5.4）。返回值让 Worker 能发现"我解析的 SHA 和会话冻结的
 * 不一致"，那种情况下它必须用会话冻结的那个。
 */
create or replace function public.bind_code_qa_conversation_snapshot(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_commit_sha text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
  v_existing text;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  if p_commit_sha is null or p_commit_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'CODE_QA_COMMIT_SHA_INVALID';
  end if;

  select commit_sha into v_existing
  from public.code_qa_conversation
  where id = v_turn.conversation_id
  for update;

  if v_existing is not null then
    return v_existing;
  end if;

  update public.code_qa_conversation
  set commit_sha = p_commit_sha, updated_at = now()
  where id = v_turn.conversation_id;

  return p_commit_sha;
end;
$$;

revoke execute on function public.bind_code_qa_conversation_snapshot(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.bind_code_qa_conversation_snapshot(uuid, text, uuid, text)
  to service_role;

/*
 * 把 DSH session id（与首轮的技能目录身份）写回会话，供后续轮 session/load 续跑。
 *
 * 允许覆盖：会话在某一轮因为卷被清理而无法续跑时，Worker 会新建一个 DSH 会话并用新 id
 * 覆盖。覆盖是事实变化，不是错误 —— 但它必须伴随一条 resumed=false 的证据，页面才能
 * 让用户知道"这一轮开始模型不记得更早的上文了"。
 */
create or replace function public.bind_code_qa_conversation_session(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_dsh_session_id text,
  p_skill_catalog_hash text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  if nullif(btrim(p_dsh_session_id), '') is null then
    raise exception 'CODE_QA_SESSION_ID_REQUIRED';
  end if;

  update public.code_qa_conversation
  set dsh_session_id = btrim(p_dsh_session_id),
      skill_catalog_hash = coalesce(nullif(btrim(p_skill_catalog_hash), ''), skill_catalog_hash),
      updated_at = now()
  where id = v_turn.conversation_id;

  return true;
end;
$$;

revoke execute on function public.bind_code_qa_conversation_session(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bind_code_qa_conversation_session(uuid, text, uuid, text, text)
  to service_role;

create or replace function public.get_model_secret_for_code_qa_turn(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  perform public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  select cfg.api_key_secret_id into v_secret_id
  from public.code_qa_turn turn
  join public.ai_model_config cfg on cfg.id = turn.model_config_id
  where turn.id = p_turn_id;

  if v_secret_id is null or not public.model_config_has_api_key(v_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  return v_secret;
end;
$$;

revoke execute on function public.get_model_secret_for_code_qa_turn(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_model_secret_for_code_qa_turn(uuid, text, uuid) to service_role;

create or replace function public.submit_code_qa_turn_result(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_answer text,
  p_evidence jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  if nullif(btrim(p_answer), '') is null then
    -- 空答案不是成功。让它落成 SUCCEEDED 会在页面上显示一个空气泡，而用户无从判断
    -- 是模型没话说还是链路断了。
    raise exception 'CODE_QA_ANSWER_EMPTY';
  end if;

  update public.code_qa_turn
  set status = 'SUCCEEDED',
      stage = 'DONE',
      answer = p_answer,
      evidence = coalesce(p_evidence, '{}'::jsonb),
      error_code = null,
      error_message = null,
      finished_at = now()
  where id = p_turn_id;

  update public.code_qa_conversation
  set last_turn_at = now(), updated_at = now()
  where id = v_turn.conversation_id;

  return true;
end;
$$;

revoke execute on function public.submit_code_qa_turn_result(uuid, text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_code_qa_turn_result(uuid, text, uuid, text, jsonb)
  to service_role;

create or replace function public.submit_code_qa_turn_failure(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_evidence jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_turn public.code_qa_turn;
begin
  v_turn := public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  update public.code_qa_turn
  set status = 'FAILED',
      stage = 'DONE',
      error_code = coalesce(nullif(btrim(p_error_code), ''), 'CODE_QA_FAILED'),
      error_message = left(coalesce(p_error_message, ''), 1000),
      evidence = coalesce(p_evidence, '{}'::jsonb),
      finished_at = now()
  where id = p_turn_id;

  update public.code_qa_conversation
  set last_turn_at = now(), updated_at = now()
  where id = v_turn.conversation_id;

  return true;
end;
$$;

revoke execute on function public.submit_code_qa_turn_failure(uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_code_qa_turn_failure(uuid, text, uuid, text, text, jsonb)
  to service_role;

/*
 * 回收失联租约。
 *
 * 必须有：一条唯一索引让同一会话只能有一轮在飞，所以一个崩掉的 Worker 留下的 RUNNING
 * 行会永久堵住那个会话 —— 用户看到的是一个永远转的进度条，而且没法提下一个问题。
 */
create or replace function public.reclaim_stale_code_qa_turn_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    update public.code_qa_turn
    set status = 'QUEUED',
        stage = 'QUEUED',
        worker_id = null,
        claim_token_digest = null,
        lease_expires_at = null,
        heartbeat_at = null
    where status = 'RUNNING'
      and lease_expires_at is not null
      and lease_expires_at < now()
    returning 1
  )
  select count(*) into v_count from stale;
  return coalesce(v_count, 0);
end;
$$;

revoke execute on function public.reclaim_stale_code_qa_turn_leases()
  from public, anon, authenticated;
grant execute on function public.reclaim_stale_code_qa_turn_leases() to service_role;
