-- V1.23b 产品代码问答：修正技能状态过滤，并给 Worker 一条取当前技能目录的通道。
--
-- 两件事：
--
-- 1. **修 bug：`code_qa_catalog()` 用了不存在的状态值 `'ENABLED'`。**
--    `review_skill.status` 的合法值是 DRAFT / VALIDATING / PUBLISHED / DISABLED /
--    VALIDATION_FAILED（见 20260917100000 的 CHECK）。`'ENABLED'` 永远匹配不到任何行，
--    所以问答页的「可用模块技能」会**永远是空的，而且没有任何错误**——正是那种写错了
--    只会静静变没用的缺陷。口径改为与 `current_skill_catalog_entries()` 完全一致
--    （`status = 'PUBLISHED'`），那是平台里"哪些技能对 Agent 可见"的既有单一事实来源。
--
-- 2. **新增 `get_code_qa_skill_catalog(turn, worker, token)`。**
--    Worker 要把技能目录物化进 per-turn 的 `DSH_HOME/skills/`，需要归档定位
--    （bucket / object key / sha256 / manifest）。它复用
--    `current_skill_catalog_entries()` 与 `current_skill_catalog_hash()`，返回形状与
--    `get_story_task_skill_snapshot` 逐字一致，这样 Worker 侧可以直接用同一个
--    `parseFrozenSkillCatalog` 解析 —— 两种形状会立刻产生第二份解析代码，然后漂移。
--
--    与评审那条路的**根本差异**：评审用的是 Job 冻结的目录（同一批次前后可比），
--    问答用的是**当前**目录（产品问的是"现在"，而且问答没有批次可冻结）。代价是会话
--    中途技能发版后，续跑会话的技能目录身份会变 —— 那由 `skill_catalog_hash` 比对
--    发现并拒绝续跑，而不是静默换一套知识。
--
-- 幂等：全部 create or replace。

------------------------------------------------------------------------------
-- 1. 修正 code_qa_catalog 的技能状态过滤
------------------------------------------------------------------------------

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

  /*
   * 口径与 current_skill_catalog_entries() 一致：`status = 'PUBLISHED'`。
   *
   * 这里只暴露给人看的元数据（名称、描述、何时使用），不含归档定位、hash 或容量水位 ——
   * 问答的使用者是产品经理（多数是 VIEWER），那些字段对他没有意义，回出去只是扩大暴露面。
   */
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
    where skill.status = 'PUBLISHED'
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

comment on function public.code_qa_catalog() is
  'V1.23: repositories, branches and the human-readable metadata of currently '
  'published skills, for the product code Q&A page. Skill filter must stay in sync '
  'with current_skill_catalog_entries() (status = PUBLISHED); an invalid status '
  'value silently yields an empty skill list with no error.';

------------------------------------------------------------------------------
-- 2. Worker 侧：当前技能目录（含归档定位）
------------------------------------------------------------------------------

/*
 * 返回形状与 `get_story_task_skill_snapshot` 逐字一致，于是 Worker 侧共用
 * `parseFrozenSkillCatalog`。差别只有两处，都是刻意的：
 *
 *   * `job_id` 恒为 null（问答没有批次）；
 *   * `snapshot_id` 用 `review_skill_version.id`。冻结路径上那是
 *     `analysis_job_skill_snapshot.id`，而问答没有快照行 —— 版本 id 是同等稳定的身份，
 *     且不可变（发布后版本行不可改）。
 *
 * 门禁是 claim token，与其它 Worker 侧 RPC 一致：只有正持有这一轮租约的 Worker 能取。
 */
create or replace function public.get_code_qa_skill_catalog(
  p_turn_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries jsonb;
begin
  perform public.assert_code_qa_turn_claim(p_turn_id, p_worker_id, p_claim_token);

  v_entries := public.current_skill_catalog_entries();

  return jsonb_build_object(
    'job_id', null,
    'snapshot_version', 0,
    'catalog_hash', public.current_skill_catalog_hash(),
    'bundles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'snapshot_id', entry->>'version_id',
        'name', entry->>'name',
        'description', entry->>'description',
        'when_to_use', entry->>'when_to_use',
        'version', (entry->>'version')::integer,
        'archive_bucket', entry->>'archive_bucket',
        'archive_object_key', entry->>'archive_object_key',
        'archive_sha256', entry->>'archive_sha256',
        'archive_size_bytes', (entry->>'archive_size_bytes')::bigint,
        'bundle_hash', entry->>'bundle_hash',
        'bundle_manifest', entry->'bundle_manifest',
        'expanded_size_bytes', (entry->>'expanded_size_bytes')::bigint,
        'file_count', (entry->>'file_count')::integer,
        'contains_scripts', (entry->>'contains_scripts')::boolean
      ) order by entry->>'name'), '[]'::jsonb)
      from jsonb_array_elements(v_entries) as entry
    )
  );
end;
$$;

revoke execute on function public.get_code_qa_skill_catalog(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_code_qa_skill_catalog(uuid, text, uuid) to service_role;

comment on function public.get_code_qa_skill_catalog(uuid, text, uuid) is
  'V1.23: the CURRENT published skill catalog (not a frozen job snapshot), shaped '
  'exactly like get_story_task_skill_snapshot so the worker can reuse one parser. '
  'Code QA has no batch to freeze against; the conversation stores the catalog hash '
  'so a later turn can refuse to resume against a different skill set.';
