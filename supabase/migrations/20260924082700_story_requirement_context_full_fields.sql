------------------------------------------------------------------------------
-- V1.21：需求全量上下文冻结
--
-- 问题（2026-09-24 实测）：AI 分析时拿到的需求信息只有编号、标题、项目、正文和
-- 关联特性。库里明明已经冻结了迭代、发布窗口、需求状态、开发/需求/测试负责人、
-- 故事链接与 Linky 的全部原始结构化字段，但它们没有任何一条进入提示词：
--
--   * review_story_requirement_context() 只产出 5 个键
--     （detailed_description / related_features / source_status / iteration / attachments）；
--   * Worker 的 buildScopedStoryDescription 又只取其中 3 个
--     （detailed_description / related_features / release_window），
--     而 release_window 这个键**从来不存在**于 requirement_context —— 那一行是死代码，
--     source_status 与 iteration 则被白名单丢掉。
--
-- 这个迁移负责把"冻结面"补齐：凡是 review_story 上属于需求内容的列，全部进
-- requirement_context。Worker 侧的渲染改造（中文标签 + 需求快照文件 + 附件必读）
-- 在同一版本的 worker/src/ai 里完成。
--
-- 只改函数体，签名不变。grant 与 20260924051800 一致地重新声明一次，保证本文件
-- 可以在任何既有状态上重复应用。
--
-- 对既有数据的影响：analysis_job_story_snapshot 的 requirement_context 与 input_hash
-- 都由 freeze_analysis_job_scope_inputs 在冻结时**算一次写库**，读取路径不重算，
-- 所以历史批次与在途 Job 完全不受影响；新键只出现在此后新建的 Analysis Job 上。
-- 同一个 task 不会被重新冻结，因此也不存在 story_input_hash 漂移导致 Session
-- 拒绝续跑的情况。
------------------------------------------------------------------------------

create or replace function public.review_story_requirement_context(p_story public.review_story)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    -- 身份与来源：模型需要知道这条需求在源系统里是什么、从哪条通道进来的。
    'story_code', to_jsonb(p_story.story_code),
    'story_name', to_jsonb(nullif(btrim(coalesce(p_story.story_name, '')), '')),
    'source_system', to_jsonb(coalesce(p_story.source_system, 'EXCEL')),
    'story_url', to_jsonb(nullif(btrim(coalesce(p_story.story_url, '')), '')),

    -- 正文与验收口径。
    -- LINKY 取结构化列；EXCEL 历史批次回退到 source_data 里字面叫「详细描述」的那一列
    -- —— 旧批次重跑的行为与 V1.20 之前保持一致。两者都空就让这个键缺席：需求真的
    -- 没有正文时不许用标题伪造一份。
    -- review_story 上没有 description / acceptance_criteria 列（0005 已删除），所以
    -- 验收标准只可能来自 Excel 行里那一列；Linky 不提供验收口径，它躺在附件里。
    'detailed_description', coalesce(
      to_jsonb(nullif(btrim(coalesce(p_story.requirement_detail, '')), '')),
      p_story.source_data -> '详细描述'
    ),
    'acceptance_criteria', p_story.source_data -> '验收标准',
    'related_features', coalesce(
      to_jsonb(nullif(btrim(coalesce(p_story.subject_name, '')), '')),
      p_story.source_data -> '关联特性'
    ),

    -- 计划与状态。发布窗口是 V1.21 新增的键：Worker 早就在读它，只是以前没人写。
    'source_status', to_jsonb(nullif(btrim(coalesce(p_story.source_status, '')), '')),
    'iteration', to_jsonb(nullif(btrim(coalesce(p_story.iteration_name, '')), '')),
    'release_window', to_jsonb(nullif(btrim(coalesce(p_story.release_window, '')), '')),

    -- 归属。project_name / application_name 虽然也从 StoryTask 单独传给提示词，
    -- 但 requirement_context 是"冻结的需求事实"这一份的唯一载体，缺了它就无法凭
    -- 快照复现当时的输入。cloud_name 在 0040 之后不再由导入侧供值，这里只是把
    -- 历史行里已经有的值如实带上，不新造来源。
    'project_name', to_jsonb(nullif(btrim(coalesce(p_story.project_name, '')), '')),
    'cloud_name', to_jsonb(nullif(btrim(coalesce(p_story.cloud_name, '')), '')),
    'application_name', to_jsonb(nullif(btrim(coalesce(p_story.application_name, '')), '')),

    -- 三类负责人。判断"谁应该实现这条需求"时是真实输入，不是装饰信息。
    'developers', to_jsonb(nullif(btrim(coalesce(p_story.owners_text, '')), '')),
    'requirement_handlers', to_jsonb(nullif(btrim(coalesce(p_story.requirement_handlers, '')), '')),
    'test_handlers', to_jsonb(nullif(btrim(coalesce(p_story.test_handlers, '')), '')),

    -- 源系统原始字段全量。
    --   LINKY：field_values（Linky 的结构化字段原文，含平台没有单独建列的那些）；
    --   EXCEL：整行 source_data（Excel 行本身就是需求原文）。
    -- 刻意不含 LINKY 的 list_item：它是列表端点的投影，字段都已在上面的键里，
    -- 重复给只会让上下文变长。
    'source_fields', case
      when coalesce(p_story.source_system, 'EXCEL') = 'LINKY'
        then nullif(p_story.source_data -> 'field_values', 'null'::jsonb)
      else nullif(p_story.source_data, '{}'::jsonb)
    end,

    'attachments', (
      select jsonb_agg(
        jsonb_build_object(
          'filename', attachment.filename,
          'content_type', attachment.content_type,
          'size_bytes', attachment.size_bytes,
          'sha256', attachment.content_sha256,
          'storage_path', attachment.storage_path
        )
        order by attachment.filename, attachment.linky_attachment_id
      )
      from public.review_story_attachment attachment
      where attachment.story_id = p_story.id
    )
  ));
$$;

comment on function public.review_story_requirement_context(public.review_story) is
  'AI 分析用的需求冻结上下文（V1.21 起为全量）：身份、正文、验收、关联特性、状态、'
  '迭代、发布窗口、归属、三类负责人、源系统原始字段与附件清单。'
  'freeze_analysis_job_scope_inputs 的 requirement_context 与 input_hash 共用它，'
  '避免两份表达式漂移。';

revoke execute on function public.review_story_requirement_context(public.review_story)
  from public, anon;
grant execute on function public.review_story_requirement_context(public.review_story)
  to authenticated, service_role;
