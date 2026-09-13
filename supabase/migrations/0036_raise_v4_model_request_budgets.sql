-- Raise the V4 model-request budget through a deployable database migration.
--
-- Runtime policy and read-only UI intentionally have different data paths:
--   * build_v4_capability_policy(uuid) overlays ai_model_config resource limits
--     when a new Job freezes its capability_policy_snapshot;
--   * admin_get_v4_capability_policy() starts from the active manifest baseline.
--
-- Do not mutate v4_harness_manifest.default_policy in place: its manifest_hash is
-- frozen and verified by Workers. The admin RPC overlays only the two operational
-- defaults changed here, while the manifest and its contract hash remain intact.

begin;

-- New model configurations inherit the raised V4 limits.
alter table public.ai_model_config
  alter column agent_max_total_requests set default 240,
  alter column agent_max_root_requests set default 120;

-- Migrate configurations that still use the original 160/80 pair. The paired
-- predicate preserves any operator-customized budget instead of overwriting it.
update public.ai_model_config
set
  agent_max_total_requests = 240,
  agent_max_root_requests = 120
where agent_max_total_requests = 160
  and agent_max_root_requests = 80;

-- Keep the ADMIN read-only page aligned with the operational defaults. Actual
-- Job snapshots still come from build_v4_capability_policy(model_config_id), so
-- per-model resource limits remain authoritative for execution.
create or replace function public.admin_get_v4_capability_policy()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_policy jsonb;
begin
  perform public.ensure_admin();

  select manifest.default_policy into v_policy
  from public.v4_harness_manifest manifest
  where manifest.is_active;

  if v_policy is null then
    raise exception 'V4_HARNESS_MANIFEST_MISSING';
  end if;
  if jsonb_typeof(v_policy -> 'modelBudget') is distinct from 'object' then
    raise exception 'V4_HARNESS_MODEL_BUDGET_MISSING';
  end if;

  return jsonb_set(
    jsonb_set(
      v_policy,
      '{modelBudget,maxTotalRequests}',
      '240'::jsonb,
      false
    ),
    '{modelBudget,maxRootRequests}',
    '120'::jsonb,
    false
  );
end;
$$;

revoke execute on function public.admin_get_v4_capability_policy()
  from public, anon;
grant execute on function public.admin_get_v4_capability_policy()
  to authenticated, service_role;

comment on function public.admin_get_v4_capability_policy() is
  'ADMIN only: returns the active V4 manifest policy with operational model-budget defaults overlaid for the read-only UI.';

commit;
