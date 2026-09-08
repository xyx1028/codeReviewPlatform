create or replace function public.delete_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();

  if not exists (select 1 from public.review_batch where id = p_batch_id) then
    raise exception 'batch not found';
  end if;

  delete from public.review_batch where id = p_batch_id;
end;
$$;

revoke execute on function public.delete_review_batch(uuid) from public, anon;
grant execute on function public.delete_review_batch(uuid) to authenticated;

drop policy if exists "admins delete review files" on storage.objects;
create policy "admins delete review files" on storage.objects for delete to authenticated using (bucket_id = 'review-files' and public.is_admin());
