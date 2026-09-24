# 技能需求改造 Playbook

## 1. 新增或调整 ZIP 校验

首查：`kdmanage` 的 `UploadValidator`、`SkillAppService`，以及 `tmanage` 的 `SkillPackageUploadService`。

- 明确改的是平台发布规范、租户预上传规范，还是两者；
- 保持 ZIP 根路径、UTF-8、路径安全、文件白名单和压缩炸弹防护；
- 不因方便而把文件整包读入内存；
- 需要新增脚本类型时，同时评估发布确认、安全扫描和运行时执行边界；
- 为有效、外层目录、非法 frontmatter、超限、恶意路径等情况补测试。

## 2. 新增技能字段或状态

影响面：实体、DTO/VO、Mapper/SQL、Flyway、Service 的导入/审核/同步分支、前端类型/API/表单/列表、i18n、测试。

- 新增 Flyway 文件名必须使用真实当前时间生成的 14 位时间戳，且大于目录最大版本；
- 使用 PostgreSQL 语法：`COMMENT ON`、`CREATE INDEX`，不使用 MySQL 内联 `COMMENT`、`ADD INDEX`、`MODIFY COLUMN`；
- 不改已发布迁移文件，修正另建新迁移；
- 确认字段是否需要跨端同步、版本快照、草稿复制和 i18n 覆盖。

## 3. 修改导入、审核或版本行为

首查：`SkillService#doImportSkill`、`ReviewAuditService`、`SkillVersionSnapshotService`、kdmanage 的 `SkillAppService` 与 `PublishReviewAppService`。

必须列出并分别验证：

1. 原厂通道（`tenant_id=0`）；
2. 租户首次投稿；
3. 租户未发布主行再次提交；
4. 租户已发布主行升级产生草稿；
5. 测试批量导入（`origin=TEST`）；
6. 审核通过、驳回与重复提交；
7. 运行时通知/同步失败的事务边界。

## 4. 调整同名或来源逻辑

- 使用 `tenant_id`、`data_scope`、`source_skill_id`、`pending_source_skill_id` 共同判断；
- 明确目标是“当前租户是否占用”“原厂是否存在”“是否允许覆盖”还是“列表是否可见”；
- 检查 Wrapper 是否显式锁定当前租户，及租户拦截器对该表的最终作用；
- 不以全局名称唯一约束替代多租户/草稿语义；
- 增加原厂与租户同名、草稿存在、软删除、并发或重复提交的回归测试。

## 5. 修改前端页面或接口

- 从 `SkillPage.tsx` / `SkillsPage.tsx` 和各自 `skillApi` 开始，追踪到 Controller；
- 新增 Controller 方法：确认调用方、标注调用方、沿用统一响应包装、补接口测试；
- 修改既有响应字段：先确认兼容性，必要时扩展字段而不是破坏旧字段；
- 涉及敏感数据：复用 `manage-sensitive`，不要手工脱敏；
- 更新字段、操作文案和报错时，核对前后端 i18n 资源和测试。

## 6. 最小验证矩阵

| 改动 | 至少验证 |
|---|---|
| Service/Controller | 相关单元或 MVC 测试编译并通过；扫描受影响测试调用 |
| 前端组件/API | TypeScript 构建、对应 Vitest 用例、页面关键交互 |
| Flyway | 文件名、最大版本、PG 语法、幂等性与迁移目录风格 |
| ZIP 校验 | 合法包与关键非法包回归 |
| 同步/审核 | 主行/草稿/原厂/租户/测试导入的分支测试 |
| 诊断修复 | 原始复现步骤、日志证据、修复后回归与无关路径检查 |

完整实施前先填 [需求分析模板](../templates/requirement-analysis.md)，完成后逐项勾选 [实现检查表](../templates/implementation-checklist.md)。
