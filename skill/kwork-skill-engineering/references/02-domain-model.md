# 技能领域模型与边界

## 1. 核心记录

| 概念 | 主要位置 | 用途 |
|---|---|---|
| 技能主记录 | tmanage `t_tmanage_skill` / `model/entity/Skill.java` | 租户侧或原厂共享的技能元数据与运行包信息 |
| 平台技能 | kdmanage `Skill` 实体及其表 | 原厂技能的创建、导入、审核、版本源头 |
| 版本快照 | `SkillVersion`、`SkillVersionSnapshotService` | 保存版本历史，不能只从主行推断过去版本 |
| 审核记录 | tmanage `ReviewAuditService` / kdmanage `PublishReviewAppService` | 记录提交、审核与发布状态 |
| 可见性记录 | `SkillVisibilityService` 和关联表 | 决定个人、组织、群组或全员是否可见 |
| 租户自定义属性 | `SkillTenantCustomAttrService` | 展示名等租户覆盖数据，避免直接污染原厂主数据 |

## 2. 关键字段

### tenant_id

- tmanage 的租户隔离键；当前租户来自 `TenantContext`。
- `tenant_id = 0` 是原厂/厂商通道的重要边界，`SkillService#isVendorIdentity` 与 `doImportSkill` 使用该语义区分原厂推送。
- 不能只根据租户拦截器推断最终 SQL。查询若显式写 `.eq(Skill::getTenantId, currentTenantId)`，会把结果收窄到当前租户；同名原厂记录不会因此命中。
- 三级表的 SELECT 可见性与普通表不同。先看 `MybatisPlusTenantConfig`、`TierTenantInnerInterceptor`、`interceptor/rewriter/TenantRewriter`，再判断共享数据是否可见。

### source_skill_id

- 定义在 tmanage `Skill` 的 `sourceSkillId` 字段。
- 用于记录来自 kdmanage 的源技能 ID，对账和来源追踪；租户投稿通常为 `NULL`。
- 该字段不是“是否当前租户可修改”的唯一依据；权限和可修改性还取决于 `tenant_id`、通道与审核状态。

### pending_source_skill_id

- 非空时表示草稿行指向一个已发布主行；草稿审核通过后会覆盖主行并由业务流程处理草稿行。
- 需要查“当前生效技能”或做同名占用判断时，通常应过滤该字段非空的草稿行。
- 不要将草稿 ID 当成稳定对外 ID。`SkillService#doImportSkill` 在草稿路径返回前会恢复主行 ID 的语义。

### skill_status / enabled / origin

| 字段 | 典型语义 | 核查点 |
|---|---|---|
| `skill_status` | `DRAFT`、`PENDING_REVIEW`、`PUBLISHED`、`REJECTED` | 状态由哪个通道/审核流程改变 |
| `enabled` | 用户级启停或原厂上下架的可用开关 | 是否与发布状态、通知事件共同变化 |
| `origin` | 如 `TEST`、`FORMAL` 的导入来源 | 测试导入和正式审核流程不能混为一谈 |
| `current_version` | 当前生效版本 | 版本快照与运行包身份是否也变化 |
| `package_hash` / `package_version` | 运行包身份与降噪判断 | 不能只因 URL 改变就认定内容变化 |

## 3. 原厂、租户、草稿的判断顺序

1. 先确认请求/任务中的 `TenantContext.tenantId`；
2. 再看记录的 `tenant_id` 与 `data_scope`；
3. 如需追溯平台来源，检查 `source_skill_id`；
4. 如需当前生效版本，排除或单独处理 `pending_source_skill_id` 非空记录；
5. 最后结合 `skill_status`、`enabled`、审核记录和前端可见性判断用户实际可操作/可见结果。

## 4. 不变量

- 原厂与租户可出现同名技能；同名不是跨来源冲突的充分证据。
- 租户投稿不应直接覆盖已经发布的主行；已发布主行的新提交应走草稿/审核保护逻辑。
- 原厂更新和租户审核通过的通知触发点可能不同；修改时必须保持现有副作用边界。
- 展示名、可见性、i18n 等扩展能力可能保存在关联表或覆盖表，不能仅更新 `Skill` 主实体。
