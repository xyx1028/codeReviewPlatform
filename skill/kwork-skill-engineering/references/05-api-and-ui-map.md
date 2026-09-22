# 接口与 UI 地图

## 1. tmanage 前端管理通道

| UI/API | 前端入口 | 后端入口 | 说明 |
|---|---|---|---|
| 技能列表/筛选 | `tmanage-frontend/src/pages/SkillPage.tsx` | `SkillController` | 从 `skillApi` 发起；先核对筛选与分页参数 |
| 启用/禁用 | `SkillPage.tsx` | `SkillController` → `SkillService#toggleEnabled` | 启停不必然等于审核/发布状态变化 |
| 可见性 | `VisibilityModal` + `skillApi` | `SkillController` → `SkillVisibilityService` | 看人/组织/群组关联与当前用户上下文 |
| 展示名 | `SkillDisplayNameModal.tsx` | `SkillController` → `SkillTenantCustomAttrService` | 属于租户覆盖属性 |
| 产物管控 | `SkillArtifactControlModal.tsx` | `SkillController` | 确认批量接口与权限边界 |
| 版本诊断 | `SkillVersionDiagnosisModal.tsx`、`api/skillVersion.ts` | `SkillController` / 版本服务 | 用于关联智能体与技能版本问题 |

tmanage API 聚合在 `tmanage-frontend/src/api/index.ts` 的 `skillApi`。修改请求字段或响应字段时，必须同时搜索该对象、调用组件和相关测试。

## 2. tmanage Open/build 通道

| API | Controller 方法 | 用途 |
|---|---|---|
| `/api/open/skill/upload` | `OpenSkillController#upload` | `multipart/form-data` 预上传 ZIP，返回可复用文件信息 |
| `/api/open/skill/exists-by-name` | `OpenSkillController#existsByName` | 当前租户下同名主行检查，不把原厂同名记录作为命中 |
| 直接导入 | `OpenSkillController` 的 direct-import 相关方法 | 按 Token 用户上下文提交租户技能 |
| 测试批量导入 | `OpenSkillController` 的 test-direct-import 相关方法 | 自动批准测试导入 |
| build 技能查询/下载 | `OpenSkillController` 的 list/download 相关方法 | 按当前实现核对鉴权与包下载规则 |

该通道使用 `@TokenVerify(TokenCategory.TENANT_USER)`。不要将其与 `/api/backend/**` 的内部服务鉴权混淆。

## 3. tmanage 后端内部通道

`controller/backend/BackendSkillController.java` 提供服务间技能查询、导入、更新、删除、预览等能力。调用前应确认：

- 请求路径是否为 `/api/backend/**`；
- HMAC/内部鉴权与租户上下文由哪个过滤器注入；
- 返回体是否走统一 `Result<T>` 包装；
- 返回敏感字段是否经过后端内部通道的脱敏策略。

## 4. kdmanage 平台管理通道

| API 组 | 前端 | 后端 | 代表能力 |
|---|---|---|---|
| `/api/v1/skills` | `pages/SkillsPage.tsx` | `controller/SkillController.java` | 分页、创建、导入、更新、详情、预览 |
| `/api/v1/skills/import/parse` | `SkillImportDialog.tsx`、`SkillUpdateDialog.tsx` | `SkillController` → `SkillAppService` | ZIP/Base64 导入预解析与 lint 结果 |
| `/api/v1/skills/import/check-name` | `services/api.ts` 的 `skillApi` | `SkillController` | 平台侧名称检查，语义不要套用到 tmanage 租户同名检查 |
| `/api/v1/skills/*/submit-review` | `services/api.ts` | `SkillController` / 审核服务 | 发起平台发布审核 |
| 技能版本 | `SkillVersionHistoryDialog.tsx` | `SkillVersionController.java` | 查询版本历史/版本辅助信息 |

kdmanage API 聚合在 `kdmanage-frontend/src/services/api.ts` 的 `skillApi`。`SkillImportDialog.tsx` 和 `SkillUpdateDialog.tsx` 是上传 Base64 与 lint/预览 UI 行为的首查入口。

## 5. 接口改动检查

1. Controller 的请求 DTO、返回 DTO 和统一包装是否保持兼容；
2. tmanage 与 kdmanage 是否各自有同名但不同语义的接口；
3. 前端 API 封装、组件调用、Mock/测试是否同步；
4. 新增 Controller 方法的调用方标注、鉴权、审计、i18n 和脱敏是否满足项目规则；
5. 不要把上传路径的内存/流式实现细节直接暴露为不稳定的外部契约。
