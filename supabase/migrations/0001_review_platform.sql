create extension if not exists pgcrypto;

create table if not exists public.user_profile (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'REVIEWER' check (role in ('ADMIN', 'REVIEWER', 'VIEWER')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.review_batch (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  week_code text not null unique,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'WAITING_AI_RESULT', 'REVIEWING', 'COMPLETED')),
  default_branch text,
  remark text,
  created_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.import_file (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  file_type text not null check (file_type in ('SOURCE', 'AI_RESULT', 'TEMPLATE')),
  file_name text not null,
  storage_path text not null,
  file_hash text not null,
  template_version text,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, file_type, file_hash)
);

create table if not exists public.review_story (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  story_code text not null,
  story_name text not null,
  description text,
  acceptance_criteria text,
  owners_text text not null,
  project_name text,
  cloud_name text,
  application_name text,
  iteration_name text,
  release_window text,
  source_status text,
  source_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, story_code)
);

create table if not exists public.ai_import_record (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  import_file_id uuid references public.import_file(id) on delete set null,
  version integer not null,
  baseline_branch text,
  baseline_commit text,
  ai_model text,
  analyzed_at timestamptz,
  imported_by uuid references auth.users(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, version)
);

create table if not exists public.ai_review_result (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.review_story(id) on delete cascade,
  ai_import_record_id uuid not null references public.ai_import_record(id) on delete cascade,
  verdict text check (verdict in ('IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED', 'UNCERTAIN')),
  confidence integer check (confidence is null or (confidence >= 0 and confidence <= 100)),
  summary text,
  implemented_content text,
  missing_content text,
  risks text,
  test_points text,
  ai_remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, ai_import_record_id)
);

create table if not exists public.ai_code_evidence (
  id uuid primary key default gen_random_uuid(),
  ai_review_result_id uuid not null references public.ai_review_result(id) on delete cascade,
  repository_name text not null,
  commit_sha text,
  file_path text not null,
  symbol_name text,
  start_line integer,
  end_line integer,
  evidence_type text not null check (evidence_type in ('现有实现', '缺失依据', '风险依据')),
  description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.human_review (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.review_story(id) on delete cascade,
  ai_review_result_id uuid not null references public.ai_review_result(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id),
  result text not null check (result in ('CORRECT', 'PARTIALLY_CORRECT', 'INCORRECT', 'NEED_DISCUSSION')),
  comment text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (story_id, ai_review_result_id, reviewer_id)
);

create table if not exists public.batch_operation_log (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  action text not null check (action in ('COMPLETE', 'REOPEN')),
  pending_count integer,
  forced boolean not null default false,
  performed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_batch_operation_log_batch on public.batch_operation_log(batch_id);

create index if not exists idx_review_story_batch on public.review_story(batch_id);
create index if not exists idx_review_story_owner on public.review_story using gin (to_tsvector('simple', owners_text));
create index if not exists idx_ai_import_batch_active on public.ai_import_record(batch_id, is_active);
create index if not exists idx_ai_result_import on public.ai_review_result(ai_import_record_id);
create index if not exists idx_ai_evidence_result on public.ai_code_evidence(ai_review_result_id);
create index if not exists idx_human_review_story on public.human_review(story_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_user_profile_updated_at on public.user_profile;
create trigger touch_user_profile_updated_at before update on public.user_profile for each row execute function public.touch_updated_at();
drop trigger if exists touch_review_batch_updated_at on public.review_batch;
create trigger touch_review_batch_updated_at before update on public.review_batch for each row execute function public.touch_updated_at();
drop trigger if exists touch_import_file_updated_at on public.import_file;
create trigger touch_import_file_updated_at before update on public.import_file for each row execute function public.touch_updated_at();
drop trigger if exists touch_review_story_updated_at on public.review_story;
create trigger touch_review_story_updated_at before update on public.review_story for each row execute function public.touch_updated_at();
drop trigger if exists touch_ai_import_record_updated_at on public.ai_import_record;
create trigger touch_ai_import_record_updated_at before update on public.ai_import_record for each row execute function public.touch_updated_at();
drop trigger if exists touch_ai_review_result_updated_at on public.ai_review_result;
create trigger touch_ai_review_result_updated_at before update on public.ai_review_result for each row execute function public.touch_updated_at();
drop trigger if exists touch_human_review_updated_at on public.human_review;
create trigger touch_human_review_updated_at before update on public.human_review for each row execute function public.touch_updated_at();

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profile (id, display_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), 'REVIEWER')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_for_new_user on auth.users;
create trigger create_profile_for_new_user after insert on auth.users for each row execute function public.create_profile_for_new_user();

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.user_profile
    where id = (select auth.uid()) and role = 'ADMIN'
  );
$$;

create or replace function public.ensure_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'ADMIN role required';
  end if;
end;
$$;

create or replace function public.claim_initial_admin()
returns public.user_profile
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.user_profile;
begin
  if v_user_id is null then
    raise exception 'login required';
  end if;

  if exists (select 1 from public.user_profile where role = 'ADMIN' and id <> v_user_id) then
    raise exception 'ADMIN already exists';
  end if;

  insert into public.user_profile (id, role)
  values (v_user_id, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN'
  returning * into v_profile;

  return v_profile;
end;
$$;

alter table public.user_profile enable row level security;
alter table public.review_batch enable row level security;
alter table public.import_file enable row level security;
alter table public.review_story enable row level security;
alter table public.ai_import_record enable row level security;
alter table public.ai_review_result enable row level security;
alter table public.ai_code_evidence enable row level security;
alter table public.human_review enable row level security;
alter table public.batch_operation_log enable row level security;

drop policy if exists "users read own profile" on public.user_profile;
create policy "users read own profile" on public.user_profile for select to authenticated using (id = (select auth.uid()));

drop policy if exists "authenticated read batches" on public.review_batch;
create policy "authenticated read batches" on public.review_batch for select to authenticated using (true);

drop policy if exists "admins insert batches" on public.review_batch;
create policy "admins insert batches" on public.review_batch for insert to authenticated with check (public.is_admin());

drop policy if exists "admins update batches" on public.review_batch;
create policy "admins update batches" on public.review_batch for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read import files" on public.import_file;
create policy "authenticated read import files" on public.import_file for select to authenticated using (true);

drop policy if exists "admins write import files" on public.import_file;
create policy "admins write import files" on public.import_file for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read stories" on public.review_story;
create policy "authenticated read stories" on public.review_story for select to authenticated using (true);

drop policy if exists "admins write stories" on public.review_story;
create policy "admins write stories" on public.review_story for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read ai imports" on public.ai_import_record;
create policy "authenticated read ai imports" on public.ai_import_record for select to authenticated using (true);

drop policy if exists "admins write ai imports" on public.ai_import_record;
create policy "admins write ai imports" on public.ai_import_record for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read ai results" on public.ai_review_result;
create policy "authenticated read ai results" on public.ai_review_result for select to authenticated using (true);

drop policy if exists "admins write ai results" on public.ai_review_result;
create policy "admins write ai results" on public.ai_review_result for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read code evidence" on public.ai_code_evidence;
create policy "authenticated read code evidence" on public.ai_code_evidence for select to authenticated using (true);

drop policy if exists "admins write code evidence" on public.ai_code_evidence;
create policy "admins write code evidence" on public.ai_code_evidence for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated read human reviews" on public.human_review;
create policy "authenticated read human reviews" on public.human_review for select to authenticated using (true);

drop policy if exists "reviewers write own human reviews" on public.human_review;
create policy "reviewers write own human reviews" on public.human_review for insert to authenticated with check (
  reviewer_id = (select auth.uid())
  and not exists (
    select 1 from public.review_story story
    join public.review_batch batch on batch.id = story.batch_id
    where story.id = human_review.story_id and batch.status = 'COMPLETED'
  )
);

drop policy if exists "reviewers update own human reviews" on public.human_review;
create policy "reviewers update own human reviews" on public.human_review for update to authenticated using (reviewer_id = (select auth.uid())) with check (
  reviewer_id = (select auth.uid())
  and not exists (
    select 1 from public.review_story story
    join public.review_batch batch on batch.id = story.batch_id
    where story.id = human_review.story_id and batch.status = 'COMPLETED'
  )
);

drop policy if exists "authenticated read batch operation log" on public.batch_operation_log;
create policy "authenticated read batch operation log" on public.batch_operation_log for select to authenticated using (true);

insert into storage.buckets (id, name, public)
values ('review-files', 'review-files', false)
on conflict (id) do update set public = false;

drop policy if exists "authenticated read review files" on storage.objects;
create policy "authenticated read review files" on storage.objects for select to authenticated using (bucket_id = 'review-files');

drop policy if exists "admins upload review files" on storage.objects;
create policy "admins upload review files" on storage.objects for insert to authenticated with check (bucket_id = 'review-files' and public.is_admin());

drop policy if exists "admins update review files" on storage.objects;
create policy "admins update review files" on storage.objects for update to authenticated using (bucket_id = 'review-files' and public.is_admin()) with check (bucket_id = 'review-files' and public.is_admin());

create or replace function public.confirm_source_import(
  p_batch_id uuid,
  p_file_name text,
  p_storage_path text,
  p_file_hash text,
  p_template_version text,
  p_stories jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file_id uuid;
  v_story jsonb;
  v_batch_status text;
begin
  perform public.ensure_admin();

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status is null then
    raise exception 'batch not found';
  end if;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  if jsonb_typeof(p_stories) <> 'array' or jsonb_array_length(p_stories) = 0 then
    raise exception 'stories must be a non-empty array';
  end if;

  insert into public.import_file (batch_id, file_type, file_name, storage_path, file_hash, template_version, uploaded_by)
  values (p_batch_id, 'SOURCE', p_file_name, p_storage_path, p_file_hash, p_template_version, (select auth.uid()))
  returning id into v_file_id;

  for v_story in select * from jsonb_array_elements(p_stories)
  loop
    insert into public.review_story (
      batch_id,
      story_code,
      story_name,
      description,
      acceptance_criteria,
      owners_text,
      project_name,
      cloud_name,
      application_name,
      iteration_name,
      release_window,
      source_status,
      source_data
    ) values (
      p_batch_id,
      v_story->>'story_code',
      v_story->>'story_name',
      nullif(v_story->>'description', ''),
      nullif(v_story->>'acceptance_criteria', ''),
      coalesce(nullif(v_story->>'owners_text', ''), '未分配'),
      nullif(v_story->>'project_name', ''),
      nullif(v_story->>'cloud_name', ''),
      nullif(v_story->>'application_name', ''),
      nullif(v_story->>'iteration_name', ''),
      nullif(v_story->>'release_window', ''),
      nullif(v_story->>'source_status', ''),
      coalesce(v_story->'source_data', '{}'::jsonb)
    );
  end loop;

  update public.review_batch
  set status = 'WAITING_AI_RESULT'
  where id = p_batch_id and status in ('DRAFT', 'WAITING_AI_RESULT');

  return v_file_id;
end;
$$;

create or replace function public.confirm_ai_result_import(
  p_batch_id uuid,
  p_file_name text,
  p_storage_path text,
  p_file_hash text,
  p_template_version text,
  p_baseline_branch text,
  p_baseline_commit text,
  p_ai_model text,
  p_analyzed_at timestamptz,
  p_results jsonb,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_file_id uuid;
  v_import_id uuid;
  v_version integer;
  v_result jsonb;
  v_evidence jsonb;
  v_story_id uuid;
  v_result_id uuid;
  v_batch_status text;
begin
  perform public.ensure_admin();

  select status into v_batch_status from public.review_batch where id = p_batch_id;
  if v_batch_status is null then
    raise exception 'batch not found';
  end if;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already imported for this batch; delete and recreate the batch to import again';
  end if;

  if jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be an array';
  end if;

  insert into public.import_file (batch_id, file_type, file_name, storage_path, file_hash, template_version, uploaded_by)
  values (p_batch_id, 'AI_RESULT', p_file_name, p_storage_path, p_file_hash, p_template_version, (select auth.uid()))
  returning id into v_file_id;

  select coalesce(max(version), 0) + 1 into v_version from public.ai_import_record where batch_id = p_batch_id;

  update public.ai_import_record set is_active = false where batch_id = p_batch_id;

  insert into public.ai_import_record (
    batch_id,
    import_file_id,
    version,
    baseline_branch,
    baseline_commit,
    ai_model,
    analyzed_at,
    imported_by,
    is_active
  ) values (
    p_batch_id,
    v_file_id,
    v_version,
    nullif(p_baseline_branch, ''),
    nullif(p_baseline_commit, ''),
    nullif(p_ai_model, ''),
    p_analyzed_at,
    (select auth.uid()),
    true
  ) returning id into v_import_id;

  for v_result in select * from jsonb_array_elements(p_results)
  loop
    select id into v_story_id from public.review_story where batch_id = p_batch_id and story_code = v_result->>'story_code';
    if v_story_id is null then
      raise exception 'unknown story code: %', v_result->>'story_code';
    end if;

    insert into public.ai_review_result (
      story_id,
      ai_import_record_id,
      verdict,
      confidence,
      summary,
      implemented_content,
      missing_content,
      risks,
      test_points,
      ai_remark
    ) values (
      v_story_id,
      v_import_id,
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
      select result.id into v_result_id
      from public.ai_review_result result
      join public.review_story story on story.id = result.story_id
      where result.ai_import_record_id = v_import_id and story.story_code = v_evidence->>'story_code';

      if v_result_id is null then
        raise exception 'evidence references story without result: %', v_evidence->>'story_code';
      end if;

      insert into public.ai_code_evidence (
        ai_review_result_id,
        repository_name,
        commit_sha,
        file_path,
        symbol_name,
        start_line,
        end_line,
        evidence_type,
        description
      ) values (
        v_result_id,
        v_evidence->>'repository_name',
        nullif(v_evidence->>'commit_sha', ''),
        v_evidence->>'file_path',
        nullif(v_evidence->>'symbol_name', ''),
        nullif(v_evidence->>'start_line', '')::integer,
        nullif(v_evidence->>'end_line', '')::integer,
        v_evidence->>'evidence_type',
        v_evidence->>'description'
      );
    end loop;
  end if;

  update public.review_batch set status = 'REVIEWING' where id = p_batch_id and status <> 'COMPLETED';
  return v_import_id;
end;
$$;

create or replace function public.set_active_ai_import(p_ai_import_record_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_batch_status text;
begin
  perform public.ensure_admin();

  select batch_id into v_batch_id
  from public.ai_import_record
  where id = p_ai_import_record_id;

  if v_batch_id is null then
    raise exception 'AI import record not found';
  end if;

  select status into v_batch_status from public.review_batch where id = v_batch_id;
  if v_batch_status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;

  update public.ai_import_record set is_active = false where batch_id = v_batch_id;
  update public.ai_import_record set is_active = true where id = p_ai_import_record_id;
  update public.review_batch set status = 'REVIEWING' where id = v_batch_id and status <> 'COMPLETED';

  return p_ai_import_record_id;
end;
$$;

create or replace function public.complete_review_batch(p_batch_id uuid, p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending_count integer;
begin
  perform public.ensure_admin();

  select count(*) into v_pending_count
  from public.review_story story
  left join public.ai_import_record active_import on active_import.batch_id = story.batch_id and active_import.is_active
  left join public.ai_review_result result on result.story_id = story.id and result.ai_import_record_id = active_import.id
  left join public.human_review review on review.story_id = story.id and review.ai_review_result_id = result.id
  where story.batch_id = p_batch_id and result.id is not null and review.id is null;

  if v_pending_count > 0 and not p_force then
    raise exception '仍有 % 条需求未确认', v_pending_count;
  end if;

  update public.review_batch set status = 'COMPLETED', completed_at = now() where id = p_batch_id;

  insert into public.batch_operation_log (batch_id, action, pending_count, forced, performed_by)
  values (p_batch_id, 'COMPLETE', v_pending_count, p_force, (select auth.uid()));

  return v_pending_count;
end;
$$;

create or replace function public.reopen_review_batch(p_batch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();
  update public.review_batch set status = 'REVIEWING', completed_at = null where id = p_batch_id;

  insert into public.batch_operation_log (batch_id, action, performed_by)
  values (p_batch_id, 'REOPEN', (select auth.uid()));

  return p_batch_id;
end;
$$;

revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.ensure_admin() from public, anon, authenticated;
revoke execute on function public.claim_initial_admin() from public, anon;
revoke execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) from public, anon;
revoke execute on function public.set_active_ai_import(uuid) from public, anon;
revoke execute on function public.complete_review_batch(uuid, boolean) from public, anon;
revoke execute on function public.reopen_review_batch(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.claim_initial_admin() to authenticated;
grant execute on function public.confirm_source_import(uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.confirm_ai_result_import(uuid, text, text, text, text, text, text, text, timestamptz, jsonb, jsonb) to authenticated;
grant execute on function public.set_active_ai_import(uuid) to authenticated;
grant execute on function public.complete_review_batch(uuid, boolean) to authenticated;
grant execute on function public.reopen_review_batch(uuid) to authenticated;

grant usage on schema public to anon, authenticated;
grant select on public.user_profile, public.review_batch, public.review_story, public.import_file, public.ai_import_record, public.ai_review_result, public.ai_code_evidence, public.human_review, public.batch_operation_log to authenticated;
grant insert, update on public.review_batch to authenticated;
grant insert, update on public.import_file, public.review_story, public.ai_import_record, public.ai_review_result, public.ai_code_evidence to authenticated;
grant insert, update on public.human_review to authenticated;
