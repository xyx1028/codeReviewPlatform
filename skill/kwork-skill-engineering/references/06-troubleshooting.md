# 技能问题排障 Runbook

## 通用取证顺序

1. 确认请求通道、租户/用户、技能名、时间范围和重现步骤；
2. 找到 Controller → Service → Mapper/存储的实际路径；
3. 读取结构化日志，优先关联 `skillId`、`tenantId`、版本、`fileId`、审核 ID；
4. 执行只读数据核对，区分主行、草稿、审核、版本、可见性记录；
5. 对照前端请求/响应和 UI 条件；
6. 结论中区分“代码已证实”“数据已证实”“需环境核实”。

日志文件通常在工作区 `logs/` 下；按实际部署环境确认采集位置。优先搜索 `skill`、`upload`、`doImportSkill`、`review`、`sync`、`tenantId`、`error`。

## 1. ZIP 上传失败或文件未保存

| 检查 | 证据入口 | 可能结论 |
|---|---|---|
| 请求类型/字段 | `OpenSkillController#upload`、浏览器网络请求 | 必须是 `multipart/form-data` 且文件字段为 `file` |
| 基本限制 | `SkillPackageUploadService#upload` | 空文件、后缀、上传大小被拒绝 |
| ZIP 扫描 | `inspectZip`、`readSkillMd` 日志/异常 | 归档无效、条目数/压缩比/单条读取限制触发 |
| 文件转发 | `PackageStorageService#uploadZipResource` | 文件服务器 URL、票据或返回结构异常 |
| 平台发布 | `UploadValidator`、`SkillAppService` | 平台 lint/结构规则与预上传规则不同 |

避免只说“不是流式”。确认实际调用是 `getInputStream`/`getResource` 还是 `getBytes`/Base64；不同入口可以不同。

## 2. 同名判断异常

1. 先分清调用的是 tmanage `exists-by-name`、正式导入内核，还是 kdmanage `check-name`；三者语义可能不同。
2. tmanage 查询应核对：`skill_name`、`tenant_id`、`is_deleted`、`pending_source_skill_id`、合并技能字段。
3. `SkillService#checkExistsBySkillName` 与 `doImportSkill` 都显式限制当前 `tenant_id` 并排除草稿，原厂 `tenant_id=0` 同名记录通常不应让普通租户命中。
4. 查看 `[doImportSkill] START`、`existing HIT/MISS` 日志，确认 `currentTenantId` 和 `fromVendor`。
5. 若怀疑租户拦截器，阅读显式 Wrapper 条件与 `TierTenantInnerInterceptor`/`TenantRewriter`，不要只凭“SELECT 会自动注入”下结论。

只读核对示例：

```sql
SELECT id, skill_name, tenant_id, data_scope, source_skill_id,
       pending_source_skill_id, skill_status, enabled, origin, is_deleted
FROM t_tmanage_skill
WHERE skill_name = :skillName
ORDER BY tenant_id, id;
```

## 3. 原厂技能未显示或同步后不一致

- kdmanage：检查平台技能状态、发布审核结果、`EnterpriseResourceSyncService` 的触发日志与失败记录；
- tmanage：检查 `tenant_id=0`、`data_scope`、`source_skill_id`、包 URL/版本/启停状态；
- 查询路径：确认当前列表是否会读取共享数据，以及前端是否被筛选、可见性或兼容性条件隐藏；
- 运行时：数据库成功写入不等于通知/安装成功，单独查 `importSkillFromBackend` 的通知降噪、事件和下游日志。

## 4. 审核/版本异常

- 判断是新增、未发布主行重新提交，还是已发布主行升级；三条路径不同。
- 已发布主行的租户更新应看草稿行及其 `pending_source_skill_id`，不应直接把主行内容当成待审版本。
- 查审核记录的资源类型、资源 ID、`is_latest`、状态和审核类型；确认资源 ID 是主行还是草稿行。
- 原厂版本问题查看 `SkillVersionSnapshotService`，租户审核问题查看 `ReviewAuditService` 和审核通过后的副作用。

## 5. 可见性/启停不生效

1. 记录是否存在且 `skill_status`/`enabled` 符合预期；
2. `SkillVisibilityService` 关联的人员、组织、群组数据是否齐全；
3. 当前用户的租户、组织/群组上下文是否正确；
4. `SkillPage.tsx` 的前端筛选、分页、标签条件是否隐藏记录；
5. 若是展示名问题，单查 `SkillTenantCustomAttrService` 的覆盖数据与 locale。

## 6. 前后端接口不一致

- 对照前端 `skillApi` 组装的 URL、HTTP 方法、请求字段和响应解包逻辑；
- 对照 Controller 注解、DTO 校验和统一 `Result<T>` 包装；
- 如果接口是新增而非修改，检查调用方注释、鉴权通道、文档和测试；
- 不用临时 `@SkipResultWrapper` 解决前端解析问题，除非响应确实是流、下载或第三方协议例外。

## 输出要求

使用 [诊断报告模板](../templates/diagnostic-report.md) 记录事实、假设、排除项、修复建议和验证。没有数据或日志证据时，只能标为假设。
