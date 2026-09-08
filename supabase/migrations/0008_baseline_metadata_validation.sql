begin;

create or replace function public.validate_review_batch_default_branch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.default_branch is null or new.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'default_branch must be feature_dev, feature_sit, or release';
  end if;

  if tg_op = 'UPDATE'
    and new.default_branch is distinct from old.default_branch
    and exists (select 1 from public.ai_import_record where batch_id = old.id) then
    raise exception 'default_branch cannot change after AI results are imported';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_review_batch_default_branch on public.review_batch;
create trigger validate_review_batch_default_branch
before insert or update of default_branch on public.review_batch
for each row execute function public.validate_review_batch_default_branch();

create or replace function public.validate_ai_import_metadata()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_configured_branch text;
begin
  select default_branch into v_configured_branch
  from public.review_batch
  where id = new.batch_id;

  if v_configured_branch is null or v_configured_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;

  if new.baseline_branch is distinct from v_configured_branch then
    raise exception 'baseline_branch must match the batch default_branch';
  end if;

  if new.ai_model is null or btrim(new.ai_model) = '' then
    raise exception 'ai_model is required';
  end if;

  if new.analyzed_at is null then
    raise exception 'analyzed_at is required';
  end if;

  if new.baseline_commit is null or btrim(new.baseline_commit) = '' then
    raise exception 'baseline_commit is required';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_ai_import_metadata on public.ai_import_record;
create trigger validate_ai_import_metadata
before insert or update of batch_id, baseline_branch, baseline_commit, ai_model, analyzed_at on public.ai_import_record
for each row execute function public.validate_ai_import_metadata();

create or replace function public.set_review_batch_default_branch(
  p_batch_id uuid,
  p_default_branch text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_branch text;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'default_branch must be feature_dev, feature_sit, or release';
  end if;

  select default_branch into v_existing_branch
  from public.review_batch
  where id = p_batch_id;

  if v_existing_branch in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'default_branch is already configured';
  end if;

  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'default_branch cannot change after AI results are imported';
  end if;

  update public.review_batch
  set default_branch = p_default_branch
  where id = p_batch_id;

  return p_batch_id;
end;
$$;

revoke execute on function public.validate_review_batch_default_branch() from public, anon, authenticated;
revoke execute on function public.validate_ai_import_metadata() from public, anon, authenticated;
revoke execute on function public.set_review_batch_default_branch(uuid, text) from public, anon;
grant execute on function public.set_review_batch_default_branch(uuid, text) to authenticated;

commit;
