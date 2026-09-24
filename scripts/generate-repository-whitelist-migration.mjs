#!/usr/bin/env node
/**
 * 生成「把仓库白名单从硬编码清单换成白名单函数」的迁移体。
 *
 * 为什么用生成器而不是手抄：这次要改的 6 个 plpgsql 函数加起来 600 多行，其中
 * `freeze_analysis_job_scope_inputs` 刚被 Linky 那批迁移改过。手抄一遍等于把"当前真实定义"
 * 重新录入一次，任何一个字符的偏差都会静默回退掉别人刚做的改动。
 *
 * 所以输入是 `pg_get_functiondef()` 的输出（数据库里此刻的权威定义），只做**定点替换**。
 *
 * 两条自检，都必须过：
 *
 *   1. 每个替换目标在**未经改动的原文**里恰好出现一次。对原文计数是关键 —— 早先的版本
 *      在"逐条替换的中间状态"上计数，于是前一条替换插入的文本会把后一条的计数搅乱，
 *      报出一个根本不存在的"出现 2 次"。
 *   2. 输出与原文的差异行数必须等于预期（每条规则的 from/to 行数之和）。这一条挡住
 *      "替换成功但顺带吃掉了别的东西"。
 *
 * 用法（仓库根目录）：
 *   node scripts/generate-repository-whitelist-migration.mjs /tmp/v120-fn > /tmp/body.sql
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: generate-repository-whitelist-migration.mjs <dump-dir>')
  process.exit(1)
}

const RULES = {
  analysis_runtime_event_payload: [
    {
      from: `if v_raw in ('kdmanage-backend', 'kdmanage-frontend',
                     'tmanage-backend', 'tmanage-frontend') then`,
      to: `if v_raw = any (public.analysis_allowed_repository_names()) then`,
    },
  ],
  analysis_job_frozen_scope_input_payload: [
    {
      from: `jsonb_build_object(
      'kdmanage-backend',null,'kdmanage-frontend',null,
      'tmanage-backend',null,'tmanage-frontend',null
    )`,
      to: `public.analysis_empty_repository_heads()`,
    },
  ],
  freeze_analysis_job_scope_inputs: [
    {
      from: `from (values
      ('kdmanage-backend'::text),('kdmanage-frontend'::text),
      ('tmanage-backend'::text),('tmanage-frontend'::text)
    ) repositories(repository_name)`,
      to: `from unnest(public.analysis_allowed_repository_names()) as repositories(repository_name)`,
    },
  ],
  save_repository_snapshots: [
    {
      from: `if jsonb_typeof(p_snapshots)<>'array' or jsonb_array_length(p_snapshots)<>4 then
    raise exception 'exactly 4 repository snapshots are required';
  end if;`,
      // 数量由白名单决定。旧 Worker（只送 4 个）打在新库上会命中这一条并明确失败 —— 那是对的：
      // 一个只冻结了 5 仓中 4 仓的 Job，之后的覆盖率与归属分析都建立在缺一块的快照上，
      // 而它在任何报表里看起来都"成功"了。
      to: `if jsonb_typeof(p_snapshots)<>'array'
     or jsonb_array_length(p_snapshots)<>public.analysis_allowed_repository_count() then
    raise exception 'exactly % repository snapshots are required',
      public.analysis_allowed_repository_count();
  end if;`,
    },
    {
      from: `if (select count(distinct value->>'repository_name') from jsonb_array_elements(p_snapshots) value)<>4
     or exists(
       select 1 from jsonb_array_elements(p_snapshots) value
       where value->>'repository_name' not in (
         'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
       ) or lower(coalesce(value->>'commit_sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     ) then`,
      to: `if (select count(distinct value->>'repository_name') from jsonb_array_elements(p_snapshots) value)
       <>public.analysis_allowed_repository_count()
     or exists(
       select 1 from jsonb_array_elements(p_snapshots) value
       where not (value->>'repository_name' = any (public.analysis_allowed_repository_names()))
          or lower(coalesce(value->>'commit_sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     ) then`,
    },
    {
      from: `if (select count(*) from public.analysis_repository_snapshot where job_id=p_job_id)<>4
       or exists(`,
      /*
       * 续跑路径比的是"这个 Job 上次冻结了几仓"，所以基准必须是**本次送来的数量**，
       * 不能是全局白名单长度：一个在扩仓之前冻结的 Job 只有 4 行，拿 5 去比会把它误判成
       * HEAD 漂移。改成 jsonb_array_length 之后，"老 Job 被新 Worker 接管"仍然失败
       * （库里 4 行 vs 送来 5 个），而那恰恰是应该失败的情形 —— 绝不混合两代输入。
       */
      to: `if (select count(*) from public.analysis_repository_snapshot where job_id=p_job_id)
         <>jsonb_array_length(p_snapshots)
       or exists(`,
    },
  ],
  save_analysis_repository_commit_manifest: [
    {
      from: `if p_repository_name not in ('kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend') then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;`,
      to: `if not (p_repository_name = any (public.analysis_allowed_repository_names())) then raise exception 'REPOSITORY_NOT_ALLOWED'; end if;`,
    },
  ],
  save_analysis_repository_merge_requests: [
    {
      from: `v_expected_project := case p_repository_name
    when 'kdmanage-backend' then 'kwork/manage/kdmanage-backend'
    when 'kdmanage-frontend' then 'kwork/manage/kdmanage-frontend'
    when 'tmanage-backend' then 'kwork/manage/tmanage-backend'
    when 'tmanage-frontend' then 'kwork/manage/tmanage-frontend'
    else null
  end;`,
      to: `v_expected_project := public.analysis_repository_gitlab_project(p_repository_name);`,
    },
  ],
}

const ORDER = [
  'analysis_runtime_event_payload',
  'analysis_job_frozen_scope_input_payload',
  'freeze_analysis_job_scope_inputs',
  'save_repository_snapshots',
  'save_analysis_repository_commit_manifest',
  'save_analysis_repository_merge_requests',
]

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

const out = []
for (const name of ORDER) {
  const original = readFileSync(join(dir, `${name}.sql`), 'utf8').trim()
  if (!original.startsWith('CREATE OR REPLACE FUNCTION')) {
    throw new Error(`${name}: dump does not look like a single function definition`)
  }
  if (countOccurrences(original, 'CREATE OR REPLACE FUNCTION') !== 1) {
    throw new Error(`${name}: dump contains more than one definition (overloads?)`)
  }

  // 自检 1：全部目标都对**原文**计数，必须各出现一次。
  for (const [index, rule] of RULES[name].entries()) {
    const hits = countOccurrences(original, rule.from)
    if (hits !== 1) {
      throw new Error(
        `${name}: rule #${index + 1} matched ${hits} time(s) in the pristine definition ` +
          `(expected 1). The live definition changed; review it by hand.`,
      )
    }
  }

  let sql = original
  for (const rule of RULES[name]) {
    /*
     * 必须传**函数**形式的替换值，不能直接传字符串。
     *
     * `String.prototype.replace(string, string)` 会解释替换串里的 `$` 序列，而这些函数体里
     * 有正则字面量 `'^[0-9a-f]{40}([0-9a-f]{24})?$'` —— 那个 `?$'` 结尾恰好构成 `$'`，
     * 含义是"匹配位置之后的全部文本"。直接传字符串时它会把函数剩下的半截**再复制一遍**，
     * 产出一个语法尚可、逻辑重复的定义。函数形式的替换值不做任何 `$` 解释。
     */
    sql = sql.replace(rule.from, () => rule.to)
  }

  if (sql.includes('kdmanage-backend')) {
    throw new Error(`${name}: a hardcoded repository name survived the rewrite`)
  }

  /*
   * 自检 2：往回替换必须逐字节还原原文。
   *
   * 这一条比"数一下差异行数"可靠得多。早先那版量的是"第一处改动到最后一处改动之间的跨度"，
   * 而三处改动分散在函数两端，跨度自然有 70 多行 —— 它报的不是问题，是它自己的度量口径错了。
   * 往回替换能还原，等价于"输出与原文的差异恰好是这几条规则本身"，不多也不少。
   */
  let roundTrip = sql
  for (const rule of [...RULES[name]].reverse()) {
    roundTrip = roundTrip.replace(rule.to, () => rule.from)
  }
  if (roundTrip !== original) {
    throw new Error(
      `${name}: the rewrite is not reversible, so it changed something beyond the rules. ` +
        `Refusing to emit a migration.`,
    )
  }

  out.push(
    `-- ${name}：仅把硬编码仓库清单换成白名单函数调用，其余逐字保持迁移前的权威定义。`,
    sql.endsWith(';') ? sql : `${sql};`,
    '',
  )
}

process.stdout.write(out.join('\n'))
