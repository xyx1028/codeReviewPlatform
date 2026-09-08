begin;

create or replace function public.delete_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  delete from public.review_batch where id = p_batch_id;
end;
$$;

commit;
