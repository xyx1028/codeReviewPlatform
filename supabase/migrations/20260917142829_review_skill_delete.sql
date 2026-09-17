-- 20260917142829_review_skill_delete.sql
--
-- V1.6 增量：删除技能。
--
-- 背景：V1.6 只给了「停用」。停用后技能仍占着 name 唯一约束，也仍留在列表里 ——
-- 管理员上传错了一个包、或者建了一个不要的草稿，没有任何办法把它清掉。
--
-- 边界（本迁移的全部意义都在这里）：
--
-- 1. **被任何 Analysis Job 冻结过的技能不能删。** `analysis_job_skill_snapshot`
--    是评审结果的证据链：某次评审当时到底给了模型哪些技能，只能靠它回答。删掉源技能
--    会让历史 Job 的快照指向一个不存在的东西，而那份快照恰恰是不可变的。
--    数据库层面本来就有 FK RESTRICT 兜底，这里额外显式检查，是为了给出
--    `SKILL_REFERENCED_BY_JOB` 这个可判定的错误码，而不是抛一条 FK 违约文本。
--
-- 2. **删除是真删，不是软删。** 软删会留下"名字还被占着但看不见"的状态 —— 那正是
--    现在「停用」已经造成的问题，再叠一层只会更糟。要保留证据的场景由第 1 条覆盖：
--    有证据的删不掉，删得掉的没有证据。
--
-- 3. **归档对象由调用方删。** 与 `expire_review_skill_uploads` 同一约定：数据库返回
--    待删的 bucket/key，实际删除走 Storage API。数据库不假装自己能删对象存储。
--
-- 幂等：全部 `create or replace`；`admin_list_review_skills` 签名不变，直接替换。

------------------------------------------------------------------------------
-- 1. 删除 RPC
------------------------------------------------------------------------------

create or replace function public.admin_delete_review_skill(
  p_actor_id uuid,
  p_skill_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_skill public.review_skill;
  v_objects jsonb;
  v_version_count integer;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  select * into v_skill from public.review_skill where id = p_skill_id for update;
  if v_skill.id is null then
    raise exception 'SKILL_NOT_FOUND';
  end if;

  -- 证据链保护：被任何 Job 冻结过就不能删。
  if exists (
    select 1 from public.analysis_job_skill_snapshot snapshot
    where snapshot.source_skill_id = p_skill_id
  ) then
    raise exception 'SKILL_REFERENCED_BY_JOB';
  end if;

  select count(*) into v_version_count
  from public.review_skill_version where skill_id = p_skill_id;

  -- 收集待删对象：已发布版本的正式归档 + 尚未消费的 staging 归档。
  select coalesce(jsonb_agg(entry), '[]'::jsonb) into v_objects
  from (
    select jsonb_build_object('bucket', version.archive_bucket, 'object_key', version.archive_object_key) as entry
    from public.review_skill_version version
    where version.skill_id = p_skill_id
      and version.archive_object_key is not null
    union all
    select jsonb_build_object('bucket', upload.staging_bucket, 'object_key', upload.staging_object_key) as entry
    from public.review_skill_upload upload
    where upload.skill_id = p_skill_id
      and upload.staging_object_key is not null
  ) objects;

  -- review_skill.current_version_id 与 review_skill_version.skill_id 互相 RESTRICT，
  -- 所以必须先解开这个环，再删版本行。
  update public.review_skill set current_version_id = null where id = p_skill_id;
  delete from public.review_skill_version where skill_id = p_skill_id;
  -- review_skill_upload.skill_id 是 CASCADE，随技能行一起走。
  delete from public.review_skill where id = p_skill_id;

  return jsonb_build_object(
    'deleted', true,
    'skill_name', v_skill.name,
    'version_count', v_version_count,
    'objects', v_objects
  );
end;
$$;

comment on function public.admin_delete_review_skill(uuid, uuid) is
  '删除技能及其全部版本；被任何 Analysis Job 冻结过的技能拒绝删除（SKILL_REFERENCED_BY_JOB）。'
  '返回待删除的归档对象列表，实际删除由调用方走 Storage API。';

------------------------------------------------------------------------------
-- 2. 列表增加 referenced_by_job：让「删除」按钮能在点之前就知道删不了
------------------------------------------------------------------------------
--
-- 基于 pg_get_functiondef() 原文增量插入一个字段，不重写函数体：这个函数里的容量水位
-- 口径（只统计 status='PUBLISHED' 且有 current_version 的技能）是 §14.1 顶部那几行的
-- 唯一来源，凭记忆重写会静默改掉它。

create or replace function public.admin_list_review_skills()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limits jsonb := public.skill_bundle_limits();
  v_skills jsonb;
  v_enabled record;
begin
  perform public.ensure_admin();

  select coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb) into v_skills
  from (
    select jsonb_build_object(
      'id', skill.id,
      'name', skill.name,
      'display_name', skill.display_name,
      'status', skill.status,
      'current_version_id', skill.current_version_id,
      'current_version', version.version,
      'description', version.description,
      'when_to_use', version.when_to_use,
      'file_count', version.file_count,
      'archive_size_bytes', version.archive_size_bytes,
      'expanded_size_bytes', version.expanded_size_bytes,
      'contains_scripts', coalesce(version.contains_scripts, false),
      'bundle_hash', version.bundle_hash,
      'published_at', version.published_at,
      'published_by_name', publisher.display_name,
      'updated_at', skill.updated_at,
      'referenced_by_job', exists (
        select 1 from public.analysis_job_skill_snapshot snapshot
        where snapshot.source_skill_id = skill.id
      ),
      'version_count', (
        select count(*) from public.review_skill_version v where v.skill_id = skill.id
      ),
      'latest_upload', (
        select jsonb_build_object(
          'id', upload.id,
          'status', upload.status,
          'error_code', upload.error_code,
          'error_message', upload.error_message,
          'file_count', upload.file_count,
          'archive_size_bytes', upload.archive_size_bytes,
          'expanded_size_bytes', upload.expanded_size_bytes,
          'contains_scripts', upload.contains_scripts,
          'bundle_manifest', upload.bundle_manifest,
          'entry_frontmatter', upload.entry_frontmatter,
          'created_at', upload.created_at
        )
        from public.review_skill_upload upload
        where upload.skill_id = skill.id and upload.status <> 'CONSUMED'
        order by upload.created_at desc limit 1
      )
    ) as row
    from public.review_skill skill
    left join public.review_skill_version version on version.id = skill.current_version_id
    left join public.user_profile publisher on publisher.id = version.published_by
  ) rows;

  select
    count(*) as bundles,
    coalesce(sum(version.archive_size_bytes), 0) as archive_bytes,
    coalesce(sum(version.expanded_size_bytes), 0) as expanded_bytes,
    coalesce(sum(
      octet_length(skill.name) + octet_length(version.description)
        + octet_length(coalesce(version.when_to_use, ''))
    ), 0) as render_bytes,
    count(*) filter (where version.contains_scripts) as script_bundles
  into v_enabled
  from public.review_skill skill
  join public.review_skill_version version on version.id = skill.current_version_id
  where skill.status = 'PUBLISHED';

  return jsonb_build_object(
    'limits', v_limits,
    'skills', v_skills,
    'capacity', jsonb_build_object(
      'enabled_bundles', v_enabled.bundles,
      'archive_bytes', v_enabled.archive_bytes,
      'expanded_bytes', v_enabled.expanded_bytes,
      'catalog_render_bytes', v_enabled.render_bytes,
      'script_bundles', v_enabled.script_bundles,
      'catalog_hash', public.current_skill_catalog_hash()
    )
  );
end;
$$;

------------------------------------------------------------------------------
-- 3. 权限
------------------------------------------------------------------------------

revoke execute on function public.admin_delete_review_skill(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admin_delete_review_skill(uuid, uuid) to service_role;
