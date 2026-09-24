/**
 * V1.19 技能 AI 优化的**本地全链路**验证。
 *
 * 单测已经覆盖了"拒不拒该拒的东西"，但有一整类问题它们看不见，因为它们只在真实组件的
 * 接缝上出现：
 *
 *   * RPC 参数名拼错（`p_staging_object_key` vs `p_object_key`）—— 单测里假的 JobsDb 照样通过；
 *   * staging key 形状与 `admin_register_skill_upload` 里那条校验不一致；
 *   * Worker 用 service_role 调 `admin_*` RPC 时 `auth.uid()` 是 null，于是 `ensure_admin()`
 *     必然拒绝（这一条正是把 Edge Function 换成直接调三个 actor 化 RPC 的原因）；
 *   * Edge Function 读两个归档解 diff 时，中央目录/CRC/UTF-8 那三道闸门对**我们自己打的包**
 *     是不是真的放行。
 *
 * 所以这个测试用真实的本地 Supabase（REST + Storage + Edge Runtime）跑完整条链路：
 *
 *   建技能 → 上传并发布 V1 → 冻结一个 Job → 写入评审结论与人工复核
 *     → 入队优化 → Worker 认领并执行（只有模型是假的）
 *     → Edge Function 取 diff → 用真实管理员 JWT 发布 V2
 *
 * 模型是唯一被替换的组件：它的契约由单测逐条守住，而这里要验证的是"除模型之外的一切"。
 *
 * 默认跳过（需要本地 Supabase 在跑）：
 *
 * ```bash
 * RUN_V119_LOCAL_INTEGRATION=1 npx vitest run worker/src/__tests__/v119-skill-ai-optimization.integration.test.ts
 * ```
 *
 * 它会在 afterAll 里按 id 精确清理自己建的行与对象，不留数据。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { runSkillAiOptimization } from '../ai/skills/skill-ai-optimizer.js'
import { validateSkillArchive } from '../ai/skills/bundle-validator.js'
import { SupabaseSkillStorageClient } from '../ai/skills/skill-storage.js'
import { writeSkillArchive } from '../ai/skills/zip-writer.js'
import { SKILL_BUNDLE_LIMITS } from '../ai/skills/skill-limits.js'
import { SupabaseDbClient } from '../db/client.js'
import { JobsDb, type SkillAiOptimizationClaim } from '../db/jobs.js'
import { Logger } from '../logger.js'
import type { ChatCompletionResult } from '../model-connectivity/chat-completion.js'

const enabled = process.env.RUN_V119_LOCAL_INTEGRATION === '1'
const localIt = enabled ? it : it.skip
/** 第二个用例还需要一个**正在运行的本地 Worker 容器**，所以单独开关。 */
const loopIt = enabled && process.env.RUN_V119_WORKER_LOOP === '1' ? it : it.skip
const DB_CONTAINER = process.env.LOCAL_SUPABASE_DB_CONTAINER ?? 'supabase_db_codeReviewPlatform'
const WORKER_ID = 'v119-local-integration'
const BUCKET = 'skill-bundles'
const silentLogger = new Logger({ sink: () => undefined, minLevel: 'error' })

/** 唯一后缀：同一个库上重复跑不会因为技能名/邮箱撞车而失败。 */
const RUN = randomUUID().slice(0, 8)
const SKILL_NAME = `v119-e2e-${RUN}`
const ADMIN_EMAIL = `v119-e2e-${RUN}@example.invalid`
const ADMIN_PASSWORD = `v119-${randomUUID()}`

const ORIGINAL_BODY = [
  '# BOS 单据评审要点',
  '',
  '1. 确认单据状态流转完整。',
  '2. 确认字段校验存在。',
  '',
  '需要时读取 references/domain-model.md。',
].join('\n')

const OPTIMIZED_BODY = [
  '# BOS 单据评审要点',
  '',
  '1. 确认单据状态流转完整。',
  '2. 确认字段校验存在。',
  '3. **确认数据权限校验**：历史评审里有人工标错的案例，只校验了登录而没校验数据权限。',
  '',
  '需要时读取 references/domain-model.md。',
].join('\n')

function entryMarkdown(body: string): string {
  return [
    '---',
    `name: ${SKILL_NAME}`,
    'description: BOS 单据领域的评审要点与操作规则',
    'whenToUse: 评审 BOS 单据相关需求时',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 一次性 psql。装置阶段要用它，是因为 `enqueue_analysis_job` 的门禁看 `auth.uid()`。 */
function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec', '-i', DB_CONTAINER,
      'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-U', 'postgres', '-d', 'postgres', '-c', sql,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ).trim()
}

/** 以某个管理员身份跑一段 SQL（设置 request.jwt.claims，等价于浏览器那条路）。 */
function psqlAsAdmin(adminId: string, sql: string): string {
  return psql(
    `begin; select set_config('request.jwt.claims', ` +
      `json_build_object('sub', ${quoteSql(adminId)}, 'role', 'authenticated')::text, true); ` +
      `${sql} commit;`,
  )
}

interface LocalEnv {
  url: string
  anonKey: string
  serviceRoleKey: string
}

function resolveLocalEnv(): LocalEnv {
  const fromEnv = {
    url: process.env.LOCAL_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '',
    anonKey: process.env.LOCAL_SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? '',
  }
  if (fromEnv.url !== '' && fromEnv.anonKey !== '' && fromEnv.serviceRoleKey !== '') return fromEnv
  // 没给就问 CLI 要。测试只在本地跑，这比要求每个人手抄三个值可靠。
  const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8' })
  const read = (name: string): string => {
    const match = new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm').exec(status)
    if (match === null) throw new Error(`supabase status did not report ${name}`)
    return match[1]!
  }
  return { url: read('API_URL'), anonKey: read('ANON_KEY'), serviceRoleKey: read('SERVICE_ROLE_KEY') }
}

interface Fixture {
  env: LocalEnv
  service: SupabaseClient
  jobsDb: JobsDb
  storage: SupabaseSkillStorageClient
  adminId: string
  adminJwt: string
  skillId: string
  batchId: string
  jobId: string
  modelConfigId: string
  v1ObjectKey: string
  createdObjectKeys: string[]
}

let fixture: Fixture | null = null

async function publishV1(f: Omit<Fixture, 'v1ObjectKey' | 'jobId'>): Promise<string> {
  const archive = writeSkillArchive(
    [
      { path: 'SKILL.md', bytes: Buffer.from(entryMarkdown(ORIGINAL_BODY), 'utf8') },
      { path: 'references/domain-model.md', bytes: Buffer.from('# 领域模型\n\n单据主子表。\n', 'utf8') },
    ],
    { compressionRatio: SKILL_BUNDLE_LIMITS.compressionRatio },
  )
  const validated = validateSkillArchive({ archive, expectedSkillName: SKILL_NAME })

  const stagingKey = `staging/${f.adminId}/${randomUUID()}.zip`
  const uploadId = await f.jobsDb.registerSkillUpload({
    actorId: f.adminId,
    skillId: f.skillId,
    stagingObjectKey: stagingKey,
  })
  await f.storage.uploadStagingArchive(stagingKey, archive)
  f.createdObjectKeys.push(stagingKey)
  await f.jobsDb.recordSkillUploadValidation({
    actorId: f.adminId,
    uploadId,
    archiveSha256: validated.archiveSha256,
    archiveSizeBytes: validated.archiveSizeBytes,
    bundleManifest: validated.manifest,
    expandedSizeBytes: validated.expandedSizeBytes,
    fileCount: validated.fileCount,
    containsScripts: validated.containsScripts,
    entryFrontmatter: validated.frontmatter,
  })

  const objectKey = `${f.skillId}/versions/1/${validated.archiveSha256.replace('sha256:', '')}.zip`
  const copied = await f.service.storage.from(BUCKET).copy(stagingKey, objectKey)
  if (copied.error !== null) throw new Error(`copy to official key failed: ${copied.error.message}`)
  f.createdObjectKeys.push(objectKey)

  const published = await f.service.rpc('admin_publish_review_skill_version', {
    p_actor_id: f.adminId,
    p_upload_id: uploadId,
    p_archive_object_key: objectKey,
    p_acknowledge_scripts: false,
  })
  if (published.error !== null) throw new Error(`publish failed: ${published.error.message}`)
  return objectKey
}

beforeAll(async () => {
  if (!enabled) return
  const env = resolveLocalEnv()
  const service = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 真实的管理员账号：Edge Function 的 requireAdmin 要一个能通过 auth.getUser() 的 JWT。
  const created = await service.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  })
  if (created.error !== null || created.data.user === null) {
    throw new Error(`could not create the test admin: ${created.error?.message ?? 'no user'}`)
  }
  const adminId = created.data.user.id
  psql(
    `insert into public.user_profile (id, role) values (${quoteSql(adminId)}, 'ADMIN') ` +
      `on conflict (id) do update set role = 'ADMIN';`,
  )
  const signedIn = await createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  if (signedIn.error !== null || signedIn.data.session === null) {
    throw new Error(`could not sign in the test admin: ${signedIn.error?.message ?? 'no session'}`)
  }

  const modelConfigId = randomUUID()
  const batchId = randomUUID()
  psql(
    `select public.admin_vault_create_secret(` +
      `${quoteSql(`v119-e2e-${RUN}-not-a-real-key`)}, ${quoteSql(`v119_e2e_${RUN}`)});`,
  )
  psql(
    `insert into public.ai_model_config (` +
      `id, display_name, base_url, model_name, api_key_secret_id, enabled, ` +
      `max_parallel_tasks, request_timeout_ms, network_access_mode, created_by) values (` +
      `${quoteSql(modelConfigId)}, ${quoteSql(`V119 e2e ${RUN}`)}, ` +
      `'http://127.0.0.1:9/v1', 'v119-fake-model', ` +
      `(select id from vault.secrets where name = ${quoteSql(`v119_e2e_${RUN}`)}), ` +
      `true, 2, 60000, 'DIRECT', ${quoteSql(adminId)});`,
  )
  psql(
    `insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by) ` +
      `values (${quoteSql(batchId)}, ${quoteSql(`V119 e2e ${RUN}`)}, '2026-W39', 'feature_dev', ` +
      `${quoteSql(modelConfigId)}, ${quoteSql(adminId)});`,
  )
  psql(
    `insert into public.review_story (batch_id, story_code, story_name, owners_text, source_data) ` +
      `values (${quoteSql(batchId)}, ${quoteSql(`V119-${RUN}-1`)}, '权限校验需求', 'dev-a', '{}'::jsonb), ` +
      `(${quoteSql(batchId)}, ${quoteSql(`V119-${RUN}-2`)}, '状态流转需求', 'dev-b', '{}'::jsonb);`,
  )

  const jobsDb = new JobsDb(
    new SupabaseDbClient({ supabaseUrl: env.url, supabaseServiceRoleKey: env.serviceRoleKey }),
  )
  const storage = new SupabaseSkillStorageClient({
    supabaseUrl: env.url,
    supabaseServiceRoleKey: env.serviceRoleKey,
  })

  const createdSkill = await service.rpc('admin_create_review_skill', {
    p_actor_id: adminId,
    p_name: SKILL_NAME,
    p_display_name: `V119 端到端技能 ${RUN}`,
  })
  if (createdSkill.error !== null) {
    throw new Error(`could not create the skill: ${createdSkill.error.message}`)
  }
  const skillId = String(createdSkill.data)

  const partial = {
    env,
    service,
    jobsDb,
    storage,
    adminId,
    adminJwt: signedIn.data.session.access_token,
    skillId,
    batchId,
    modelConfigId,
    createdObjectKeys: [] as string[],
  }
  const v1ObjectKey = await publishV1(partial)

  /*
   * 冻结一个 Job。
   *
   * 这一步会把**当前全部已发布且启用**的技能冻进快照（包含本地库里原有的技能），
   * 那正是 V1.6 的既有行为；本次只关心我们这个技能的那一行。
   */
  const jobId = psqlAsAdmin(adminId, `select public.enqueue_analysis_job(${quoteSql(batchId)});`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f-]{36}$/.test(line))
    .pop()
  if (jobId === undefined) throw new Error('enqueue_analysis_job did not return a job id')

  // 评审结论 + 一条人工标错的复核：这是优化唯一的真实输入。
  psql(
    `with import as (` +
      `insert into public.ai_import_record (batch_id, version, is_active, imported_by, ` +
      `baseline_branch, baseline_commit, ai_model, analyzed_at) values (` +
      `${quoteSql(batchId)}, 1, true, ${quoteSql(adminId)}, 'feature_dev', ` +
      `${quoteSql('9'.repeat(40))}, 'v119-fake-model', now()) returning id` +
      `), story_a as (select id from public.review_story where batch_id = ${quoteSql(batchId)} ` +
      `and story_code = ${quoteSql(`V119-${RUN}-1`)}` +
      `), story_b as (select id from public.review_story where batch_id = ${quoteSql(batchId)} ` +
      `and story_code = ${quoteSql(`V119-${RUN}-2`)}` +
      `), result_a as (` +
      `insert into public.ai_review_result (story_id, ai_import_record_id, verdict, confidence, summary) ` +
      `select story_a.id, import.id, 'IMPLEMENTED', 90, '认为权限校验已实现' ` +
      `from story_a, import returning id, story_id` +
      `), result_b as (` +
      `insert into public.ai_review_result (story_id, ai_import_record_id, verdict, confidence, summary) ` +
      `select story_b.id, import.id, 'UNCERTAIN', 40, '无法确定状态流转是否完整' ` +
      `from story_b, import returning id` +
      `) insert into public.human_review (story_id, ai_review_result_id, reviewer_id, result, comment) ` +
      `select result_a.story_id, result_a.id, ${quoteSql(adminId)}, 'INCORRECT', ` +
      `'实际只校验了登录，没校验数据权限' from result_a;`,
  )

  fixture = { ...partial, jobId, v1ObjectKey }
}, 120000)

afterAll(async () => {
  if (fixture === null) return
  const f = fixture
  /*
   * 清理顺序是被实测逼出来的，每一步都有一个会挡住它的东西：
   *
   *   1. 先删 Job —— 有 Job 快照引用时技能不允许删（V1.6 的既有门禁）；
   *   2. 再删技能 —— 它会 cascade 掉 upload 行与本次的优化请求行，并交回待删归档对象；
   *   3. 归档对象要显式删 —— 数据库删除不会动 Storage；
   *   4. `batch_operation_log` 是 append-only 且 `performed_by` 是 `no action`，
   *      不清掉它 `admin_delete_user` 会以 `USER_HAS_REFERENCES` 拒绝（这是产品的正确
   *      行为，这里只是把测试自己写下的那几行按 performed_by 精确删掉）。
   */
  try {
    psql(`delete from public.analysis_job where id = ${quoteSql(f.jobId)};`)
    const deleted = await f.service.rpc('admin_delete_review_skill', {
      p_actor_id: f.adminId,
      p_skill_id: f.skillId,
    })
    if (deleted.error !== null) {
      throw new Error(`admin_delete_review_skill failed: ${deleted.error.message}`)
    }
    const objects = ((deleted.data ?? {}) as { objects?: { object_key: string }[] }).objects ?? []
    const keys = Array.from(
      new Set([...f.createdObjectKeys, ...objects.map((entry) => entry.object_key)]),
    )
    if (keys.length > 0) await f.service.storage.from(BUCKET).remove(keys)
    psql(`delete from public.review_batch where id = ${quoteSql(f.batchId)};`)
    psql(`delete from public.ai_model_config where id = ${quoteSql(f.modelConfigId)};`)
    psql(`delete from public.batch_operation_log where performed_by = ${quoteSql(f.adminId)};`)
    psql(`delete from public.user_profile where id = ${quoteSql(f.adminId)};`)
    const removedUser = await f.service.auth.admin.deleteUser(f.adminId)
    if (removedUser.error !== null) {
      throw new Error(`deleteUser failed: ${removedUser.error.message}`)
    }
  } catch (error) {
    // 清理失败不该把一次通过的验证说成失败；把原因打出来让人手工收尾。
    console.warn('v119 integration cleanup incomplete:', (error as Error).message)
  }
}, 120000)

describe('V1.19 技能 AI 优化 · 本地全链路', () => {
  localIt(
    '证据聚合 → 入队 → Worker 执行 → Edge Function diff → 管理员发布 V2',
    async () => {
      const f = fixture
      if (f === null) throw new Error('fixture was not prepared')

      // ---- 1. 证据聚合（浏览器那条路：authenticated + ensure_admin）-------
      const evidenceRaw = psqlAsAdmin(
        f.adminId,
        `select public.admin_get_skill_review_evidence(${quoteSql(f.skillId)})::text;`,
      )
      const evidence = JSON.parse(evidenceRaw.split('\n').filter((line) => line.startsWith('{')).pop()!)
      expect(evidence.referenced_job_count).toBe(1)
      expect(evidence.verdict_counts.IMPLEMENTED).toBe(1)
      expect(evidence.verdict_counts.UNCERTAIN).toBe(1)
      expect(evidence.human_review_counts.INCORRECT).toBe(1)
      // 人工标错的那条必须排在抽样第一位。
      expect(evidence.sample_findings[0].human_review_result).toBe('INCORRECT')
      // 用到这个技能的批次必须列出来（批次名 + 周次，而不是 Job id）。
      expect(evidence.referenced_batches).toHaveLength(1)
      expect(evidence.referenced_batches[0].batch_name).toBe(`V119 e2e ${RUN}`)
      expect(evidence.referenced_batches[0].week_code).toBe('2026-W39')
      expect(evidence.referenced_batches[0].skill_version).toBe(1)
      expect(evidence.referenced_batches[0].result_count).toBe(2)

      // ---- 2. 入队（幂等）-------------------------------------------------
      const enqueueSql = `select public.admin_enqueue_skill_ai_optimization(${quoteSql(f.skillId)})::text;`
      const first = JSON.parse(
        psqlAsAdmin(f.adminId, enqueueSql).split('\n').filter((l) => l.startsWith('{')).pop()!,
      )
      const second = JSON.parse(
        psqlAsAdmin(f.adminId, enqueueSql).split('\n').filter((l) => l.startsWith('{')).pop()!,
      )
      expect(first.status).toBe('QUEUED')
      expect(second.id).toBe(first.id)

      // ---- 3. Worker 认领：模型快照必须来自产出证据的那个 Job 的模型 -------
      const claim: SkillAiOptimizationClaim | null =
        await f.jobsDb.claimNextSkillAiOptimization(WORKER_ID)
      expect(claim).not.toBeNull()
      expect(claim!.request_id).toBe(first.id)
      expect(claim!.skill_name).toBe(SKILL_NAME)
      expect(claim!.requested_by).toBe(f.adminId)
      expect(claim!.archive_object_key).toBe(f.v1ObjectKey)
      expect(claim!.model_name_snapshot).toBe('v119-fake-model')
      expect(claim!.base_url_snapshot).toBe('http://127.0.0.1:9/v1')

      // 心跳与证据读取都受 claim_token 门禁，这里用真实 RPC 验证一次。
      expect(
        await f.jobsDb.heartbeatSkillAiOptimization({
          requestId: claim!.request_id,
          workerId: WORKER_ID,
          claimToken: claim!.claim_token,
        }),
      ).toBe(true)
      const workerEvidence = await f.jobsDb.getSkillReviewEvidenceForOptimization({
        requestId: claim!.request_id,
        workerId: WORKER_ID,
        claimToken: claim!.claim_token,
      })
      // Worker 侧与管理员侧必须是同一份数字，否则"AI 依据这些证据改的"无从核对。
      expect(workerEvidence.referenced_job_count).toBe(evidence.referenced_job_count)
      expect(workerEvidence.human_review_counts.INCORRECT).toBe(1)
      expect(workerEvidence.sample_findings[0]!.human_review_comment).toContain('数据权限')
      expect(workerEvidence.referenced_batches[0]!.batch_name).toBe(`V119 e2e ${RUN}`)

      /*
       * ---- 4. 执行（只有模型是假的）--------------------------------------
       *
       * 第一次故意返回一份**不合规**的输出（把脚本放到根目录，角色 OTHER 不允许 .sh），
       * 用来验证"AI 改完必须自检、不通过要继续改"这条在真实链路上成立：Worker 会把拒绝原因
       * 回灌给模型，第二次才产出草稿。
       */
      let promptSeen = ''
      let modelCalls = 0
      const outcome = await runSkillAiOptimization(claim!, {
        jobsDb: f.jobsDb,
        storage: f.storage,
        workerId: WORKER_ID,
        modelProxy: null,
        logger: silentLogger,
        callModel: async (input): Promise<ChatCompletionResult> => {
          modelCalls += 1
          promptSeen = input.userPrompt
          const content =
            modelCalls === 1
              ? JSON.stringify({
                  summary: '第一次故意放错目录',
                  files: { 'inspect.sh': '#!/bin/sh\necho nope\n' },
                })
              : JSON.stringify({
                  summary: '依据 1 条人工标错的结论补充了数据权限校验要点，并拆出一份检查清单',
                  files: {
                    'SKILL.md': entryMarkdown(OPTIMIZED_BODY),
                    'templates/checklist.md': '- [ ] 数据权限逐条核对\n',
                  },
                  deletedFiles: ['references/domain-model.md'],
                })
          return { content, latencyMs: 5, promptTokens: 100, completionTokens: 200 }
        },
      })
      expect(outcome.status).toBe('SUCCEEDED')
      // 自检真的发生过：第一次被拒、第二次才过。
      expect(modelCalls).toBe(2)
      expect(outcome.modelAttempts).toBe(2)
      expect(outcome.changedPaths).toEqual([
        'SKILL.md',
        'references/domain-model.md',
        'templates/checklist.md',
      ])
      // 第二次提示词里必须带着第一次的拒绝原因，否则模型只是在重新抽一次签。
      expect(promptSeen).toContain('上一次的输出被结构检查拒绝了')
      expect(promptSeen).toContain('inspect.sh')
      // 模型确实看到了当前正文与那条人工意见。
      expect(promptSeen).toContain('确认字段校验存在')
      expect(promptSeen).toContain('实际只校验了登录，没校验数据权限')

      const taskAfter = JSON.parse(
        psqlAsAdmin(
          f.adminId,
          `select public.admin_get_skill_ai_optimization_task(${quoteSql(f.skillId)})::text;`,
        )
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .pop()!,
      )
      expect(taskAfter.status).toBe('SUCCEEDED')
      expect(taskAfter.result_upload_id).toBe(outcome.uploadId)
      expect(taskAfter.ai_summary).toContain('数据权限')
      expect(taskAfter.model_attempts).toBe(2)
      // 草稿必须是 VALIDATED：走的是与人工上传完全相同的那一条校验 RPC。
      expect(
        psql(
          `select status from public.review_skill_upload where id = ${quoteSql(outcome.uploadId!)};`,
        ),
      ).toBe('VALIDATED')
      const stagingKey = psql(
        `select staging_object_key from public.review_skill_upload where id = ${quoteSql(outcome.uploadId!)};`,
      )
      f.createdObjectKeys.push(stagingKey)

      // ---- 5. Edge Function 取 diff（真实管理员 JWT）----------------------
      const diffResponse = await fetch(`${f.env.url}/functions/v1/skill-bundle-admin`, {
        method: 'POST',
        headers: {
          apikey: f.env.anonKey,
          Authorization: `Bearer ${f.adminJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'optimization-diff', request_id: first.id }),
      })
      const diffBody = (await diffResponse.json()) as {
        error?: string
        skill_name?: string
        ai_summary?: string
        model_attempts?: number
        contains_scripts?: boolean
        file_count?: number | null
        files?: { path: string; before: string | null; after: string | null; binary?: boolean }[]
      }
      expect(diffResponse.status, `diff failed: ${diffBody.error ?? ''}`).toBe(200)
      expect(diffBody.skill_name).toBe(SKILL_NAME)
      expect(diffBody.model_attempts).toBe(2)
      expect(diffBody.contains_scripts).toBe(false)
      // 原 2 个文件，删 1 加 1 = 2。
      expect(diffBody.file_count).toBe(2)
      expect(diffBody.files).toHaveLength(3)
      const byPath = new Map((diffBody.files ?? []).map((file) => [file.path, file]))
      // 改写：两侧都有正文，且都是从**两个真实归档**里解出来的。
      expect(byPath.get('SKILL.md')!.before).toContain('确认字段校验存在')
      expect(byPath.get('SKILL.md')!.before).not.toContain('确认数据权限校验')
      expect(byPath.get('SKILL.md')!.after).toContain('确认数据权限校验')
      // 新增：before 为 null。
      expect(byPath.get('templates/checklist.md')!.before).toBeNull()
      expect(byPath.get('templates/checklist.md')!.after).toContain('数据权限逐条核对')
      // 删除：after 为 null。
      expect(byPath.get('references/domain-model.md')!.before).toContain('领域模型')
      expect(byPath.get('references/domain-model.md')!.after).toBeNull()

      // ---- 6. 管理员确认发布 V2（既有发布链路，原样复用）-----------------
      const publishResponse = await fetch(`${f.env.url}/functions/v1/skill-bundle-admin`, {
        method: 'POST',
        headers: {
          apikey: f.env.anonKey,
          Authorization: `Bearer ${f.adminJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'publish',
          upload_id: outcome.uploadId,
          acknowledge_scripts: true,
        }),
      })
      const publishBody = (await publishResponse.json()) as {
        error?: string
        version?: number
        version_id?: string
      }
      expect(publishResponse.status, `publish failed: ${publishBody.error ?? ''}`).toBe(200)
      expect(publishBody.version).toBe(2)
      expect(
        psql(
          `select version from public.review_skill_version v ` +
            `join public.review_skill s on s.current_version_id = v.id ` +
            `where s.id = ${quoteSql(f.skillId)};`,
        ),
      ).toBe('2')
      // description 来自新 SKILL.md 的 frontmatter，不是任何调用方自报的文本。
      expect(
        psql(
          `select description from public.review_skill_version ` +
            `where id = ${quoteSql(publishBody.version_id!)};`,
        ),
      ).toBe('BOS 单据领域的评审要点与操作规则')
      // 已冻结的 Job 快照仍然指向 V1：发布只影响之后新建的 Job。
      expect(
        psql(
          `select source_version from public.analysis_job_skill_snapshot ` +
            `where job_id = ${quoteSql(f.jobId)} and source_skill_id = ${quoteSql(f.skillId)};`,
        ),
      ).toBe('1')

      // 正式对象 key 与新归档的内容寻址一致（确定性打包器的价值就在这里）。
      f.createdObjectKeys.push(
        psql(
          `select archive_object_key from public.review_skill_version ` +
            `where id = ${quoteSql(publishBody.version_id!)};`,
        ),
      )
    },
    180000,
  )

  /**
   * 真实 Worker 进程里的循环是不是真的挂上了。
   *
   * 上面那个用例在**测试进程内**调 `runSkillAiOptimization`，所以它证明不了
   * `worker/src/index.ts` 的 `skillAiOptimizationLoop` 有没有被真正挂载、容器里的
   * service-role 客户端能不能调到这三个新 RPC。这一条专门验证那件事：入队之后**什么都不做**，
   * 只等运行中的容器把它推到终态。
   *
   * 期望的终态是"模型连不上"（装置里的 base_url 指向一个必然拒连的端口），而**不是**
   * 参数名写错、RPC 不存在或权限不足 —— 后者会以 SKILL_OPTIMIZATION_FAILED 出现，
   * 所以断言里把它排除掉。
   *
   * ```bash
   * RUN_V119_LOCAL_INTEGRATION=1 RUN_V119_WORKER_LOOP=1 npx vitest run \
   *   worker/src/__tests__/v119-skill-ai-optimization.integration.test.ts
   * ```
   */
  loopIt(
    '运行中的 Worker 容器能认领并推进任务到终态（证明循环真的挂上了）',
    async () => {
      const f = fixture
      if (f === null) throw new Error('fixture was not prepared')

      const queued = JSON.parse(
        psqlAsAdmin(
          f.adminId,
          `select public.admin_enqueue_skill_ai_optimization(${quoteSql(f.skillId)})::text;`,
        )
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .pop()!,
      )
      expect(queued.status).toBe('QUEUED')

      const deadline = Date.now() + 90000
      let status = 'QUEUED'
      let errorCode = ''
      while (Date.now() < deadline) {
        const row = psql(
          `select status || '|' || coalesce(error_code, '') ` +
            `from public.skill_ai_optimization_request where id = ${quoteSql(queued.id)};`,
        )
        ;[status, errorCode] = row.split('|')
        if (status === 'SUCCEEDED' || status === 'FAILED') break
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }

      expect(status, 'a running worker container must pick the task up').toBe('FAILED')
      // 连不上假模型端点是预期结果；参数/权限错会落成通用失败码。
      expect(
        ['MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT', 'MODEL_PROXY_UNREACHABLE'],
        `unexpected terminal error_code: ${errorCode}`,
      ).toContain(errorCode)
      // 终态必须释放租约，否则这个技能会被一条死任务永久占住（唯一索引只允许一条在飞）。
      expect(
        psql(
          `select coalesce(worker_id, 'released') || '|' || coalesce(claim_token_digest, 'released') ` +
            `from public.skill_ai_optimization_request where id = ${quoteSql(queued.id)};`,
        ),
      ).toBe('released|released')
    },
    150000,
  )
})
