-- 修复 V1.37 JSONB 校验函数：以 jsonb_object_keys 统计固定对象键数。

begin;

create or replace function public.is_valid_analysis_detail_items(p_items jsonb)
returns boolean
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_key text;
  v_value jsonb;
  v_item jsonb;
  v_text text;
begin
  if jsonb_typeof(p_items) <> 'object'
     or (select count(*) from jsonb_object_keys(p_items)) <> 5
     or not (p_items ?& array[
       'implemented_content',
       'missing_content',
       'risks',
       'test_points',
       'ai_remark'
     ]) then
    return false;
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_items)
  loop
    if v_key not in ('implemented_content', 'missing_content', 'risks', 'test_points', 'ai_remark')
       or jsonb_typeof(v_value) <> 'array'
       or jsonb_array_length(v_value) > 12 then
      return false;
    end if;

    for v_item in select value from jsonb_array_elements(v_value)
    loop
      if jsonb_typeof(v_item) <> 'string' then
        return false;
      end if;

      v_text := v_item #>> '{}';
      if v_text <> btrim(v_text)
         or char_length(v_text) not between 1 and 500
         or v_text ~ E'[\\r\\n]' then
        return false;
      end if;
    end loop;

    if exists (
      select 1
      from jsonb_array_elements_text(v_value) as item(value)
      group by item.value
      having count(*) > 1
    ) then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

commit;
