-- V1.20 修订之三：删除已停用的镜像层。
--
-- 背景：V1.20 首版把看板做成"平台镜像 + 定时同步"，当天按产品反馈改成浏览器直连 Linky
-- （需求随时在变，看板要的是现在的样子）。改完之后这三张表与它们专属的函数**没有任何
-- 读写方**：前端不再查镜像，Worker 第 5 条轮询消费的是 linky_batch_import_request。
--
-- 用户已确认删除（2026-09-24）。镜像数据本身是可再生的（它就是 Linky 的副本），
-- 唯一不可再生的东西 —— 批次里冻结的需求与附件 —— 在 review_story / review_story_attachment /
-- bucket story-attachments 里，本迁移一个字都不动它们。
--
-- 顺序刻意如此：先把还在引用镜像表的函数改掉，再删表。否则 drop 能成功（PG 不追踪函数体
-- 里的依赖），但那个函数会在下一次被调用时才炸 —— 那是最难排查的一类故障。

begin;

------------------------------------------------------------------------------
-- 1. 去掉唯一一个还引用镜像表的现役函数里的那半边条件
------------------------------------------------------------------------------

create or replace function public.unreferenced_story_attachment_paths(p_paths text[])
returns text[]
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(array_agg(candidate.path order by candidate.path), array[]::text[])
  from unnest(coalesce(p_paths, array[]::text[])) as candidate(path)
  where not exists (
    select 1 from public.review_story_attachment attachment
    where attachment.storage_path = candidate.path
  );
$$;

comment on function public.unreferenced_story_attachment_paths(text[]) is
  'V1.20：判定哪些附件对象没有被任何批次引用（可安全回收）。'
  '镜像层删除后只需要看 review_story_attachment 一张表。';

------------------------------------------------------------------------------
-- 2. 删镜像层专属的 RPC
--
-- 逐个点名而不是批量循环：漏掉一个会留下一个"能调用但底表已不存在"的函数，
-- 而多写一个不存在的名字只是 if exists 空转。
------------------------------------------------------------------------------

drop function if exists public.enqueue_linky_sync(text, uuid, text, text);
drop function if exists public.get_linky_sync(uuid);
drop function if exists public.get_linky_catalog_facets(uuid);
drop function if exists public.import_linky_stories_from_catalog(uuid, uuid[], boolean);
drop function if exists public.claim_next_linky_sync(text, integer);
drop function if exists public.heartbeat_linky_sync(uuid, text, uuid, integer);
drop function if exists public.assert_linky_sync_claim(uuid, text, uuid);
drop function if exists public.upsert_linky_story_catalog(uuid, text, uuid, jsonb);
drop function if exists public.upsert_linky_story_detail(uuid, text, uuid, uuid, jsonb, jsonb);
drop function if exists public.record_linky_catalog_attachment(
  uuid, text, uuid, uuid, text, text, text, bigint, text
);
drop function if exists public.complete_linky_sync(
  uuid, text, uuid, integer, integer, integer, integer, bigint
);
drop function if exists public.fail_linky_sync(uuid, text, uuid, text, text);
drop function if exists public.release_linky_sync_claim(uuid, text, uuid);
drop function if exists public.list_linky_catalog_attachments_for_cleanup(integer, integer);
drop function if exists public.mark_linky_catalog_attachment_purged(uuid);
drop function if exists public.linky_catalog_attachment_is_referenced(text);
drop function if exists public.linky_sync_scope_key(text, uuid, text, text);

------------------------------------------------------------------------------
-- 3. 删镜像表
--
-- linky_story_catalog_attachment 先删（它 references catalog）。
-- 不用 cascade：真有别的对象挂在上面，应该让这条迁移失败并让人来看一眼，
-- 而不是静默连带删掉一个我没预料到的东西。
------------------------------------------------------------------------------

drop table if exists public.linky_story_catalog_attachment;
drop table if exists public.linky_story_catalog;
drop table if exists public.linky_sync_request;

------------------------------------------------------------------------------
-- 4. 保留下来的东西（写清楚，免得下次有人以为一起删了）
--
--   review_story 的结构化列（requirement_detail / subject_name / linky_* / source_system…）
--   review_story_attachment            批次里冻结的附件元数据
--   bucket story-attachments           附件字节（key 现在是 batch/<batch_id>/…）
--   review_story_requirement_context() 冻结函数与它共用的需求上下文
--   linky_team_names()                 team → owners_text 的拼接（导入 RPC 在用）
--   linky_batch_import_request 与它的 11 个 RPC   现役导入链路
------------------------------------------------------------------------------

comment on table public.review_story_attachment is
  'V1.20：批次内冻结的需求附件元数据。storage_path 指向 story-attachments 的 '
  'batch/<batch_id>/<attachment_id>.<ext>；content_sha256 由平台在导入时算，'
  'Worker 物化到 attempt workspace 时重算比对。';

commit;
