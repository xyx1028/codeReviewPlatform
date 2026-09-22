# 技能关键流程

## 1. 原厂技能：kdmanage → tmanage

```text
kdmanage 前端 SkillsPage/导入或更新弹窗
  → /api/v1/skills
  → SkillController
  → SkillAppService（解析、校验、存储、主数据/版本处理）
  → PublishReviewAppService（发布审核）
  → EnterpriseResourceSyncService（按当前实现触发资源同步）
  → tmanage 后端内部接口
  → SkillService#importSkillFromBackend
  → 原厂记录 tenant_id=0 / data_scope=VENDOR 的 upsert、快照与通知
```

核查点：

- 审核完成状态、同步任务/事件是否成功；
- `source_skill_id` 是否正确回填；
- tmanage 当前租户查询是否按预期展示共享原厂记录；
- 原厂更新的包 hash、版本和启停变化是否触发正确通知。

## 2. 租户 ZIP 预上传：multipart 流转发

```text
OpenSkillController#upload
  → SkillPackageUploadService#upload
  → inspectZip(MultipartFile)
  → PackageStorageService#uploadZipResource(file.getResource(), ...)
  → 文件服务器
  → SkillPackageTempStore 保存可复用 fileId 与必要元数据
```

当前 tmanage 预上传服务的关键事实：

- Controller 接受 `multipart/form-data`，不是 JSON Base64；
- `inspectZip` 使用 `MultipartFile#getInputStream` 和 `ZipInputStream` 扫描；
- 只将 `skill.md` 内容读入内存，代码限制单条读取大小；
- ZIP 转发给文件服务器走 `Resource`，主上传链未调用 `MultipartFile#getBytes()`；
- 这并不代表 Servlet 容器完全不落临时文件，也不代表所有历史导入路径都不用 Base64。排查时必须确认实际入口。

## 3. 租户正式导入与审核

```text
Open/Backend/租户前端的直接导入请求
  → SkillService#directImport... / doDirectImport
  → parseAndUpload（具体路径按请求确认）
  → SkillService#doImportSkill
  → 主行新增、未发布主行覆盖，或已发布主行创建/覆盖草稿
  → ReviewAuditService#submitSkillForReview
  → 审核通过后触发相应安装/更新通知
```

`doImportSkill` 的核心分支：

- 原厂通道：`TenantContext.tenantId == 0`，可直接覆盖原厂主行；
- 租户通道且主行未发布：覆盖主行并重新登记审核；
- 租户通道且主行已发布：更新或创建 `pending_source_skill_id` 指向主行的草稿；
- 新增租户技能：设置租户数据范围并提交审核。

## 4. 测试批量导入

`SkillService#batchTestDirectImportFromBackend` 逐条调用 `doSingleTestDirectImport`，外层事务失败会回滚整批。成功时：

- 查找同租户、未删除、非草稿主行；
- 命中则覆盖，未命中则新增；
- 设为 `PUBLISHED`、`enabled=1`、`origin=TEST`；
- 创建 `AUTO_APPROVED` 审核留痕；
- 通知运行环境并在更新时发布版本变更事件。

不要将测试批量导入的行为推广到租户正式投稿或原厂同步。

## 5. 可见性、展示名与启停

```text
SkillPage.tsx
  → skillApi
  → SkillController
  → SkillVisibilityService / SkillTenantCustomAttrService / SkillService#toggleEnabled
  → 关联表或覆盖属性
  → 后续列表查询按用户、组织、群组与状态过滤
```

排查“列表看不见”时，至少区分：记录存在、状态/启停、可见性关联、当前用户上下文、前端筛选条件、接口分页条件。

## 6. 版本和运行包副作用

- `SkillVersionSnapshotService` 记录原厂通道的版本快照；不要只改主行后假设历史已更新。
- `SkillService#importSkillFromBackend` 用 `package_hash`、`package_version`、多语言标识判断是否需要降噪跳过通知。
- 审核流程、同步流程和运行时通知是独立步骤；问题定位时分别找证据，不能把“数据库已更新”当成“运行时已安装”。
