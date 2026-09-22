# 技能工程地图

## 1. 阅读顺序

1. 从请求入口或页面开始；
2. 进入对应 Service，确认状态分支与副作用；
3. 看 Entity/DTO/Mapper 及迁移，核对持久化字段；
4. 回到另一端确认 API 契约、路由和显示条件；
5. 需要运行时安装或同步证据时，再沿事件/通知继续追踪。

## 2. tmanage 后端（租户侧）

根路径：`tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/`

| 关注点 | 首选入口 | 关键协作者 |
|---|---|---|
| 租户控制台技能管理 | `controller/SkillController.java` | `service/SkillService.java`、`SkillVisibilityService.java`、`SkillTenantCustomAttrService.java` |
| build/Open ZIP 预上传与直接导入 | `controller/open/OpenSkillController.java` | `SkillPackageUploadService.java`、`PackageStorageService.java`、`SkillService.java` |
| 内部服务接口 | `controller/backend/BackendSkillController.java` | `SkillService.java` |
| 技能类型 | `controller/SkillTypeController.java`、`controller/backend/BackendSkillTypeController.java` | `SkillType`、相关 Service |
| 企业中心技能共享 | `enterprise/controller/EcSkillShareController.java` | `enterprise/` 下的共享服务 |
| 主数据与来源 | `model/entity/Skill.java` | `mapper/SkillMapper.java`、`service/SkillService.java` |
| 版本/审核 | `SkillVersionSnapshotService.java`、`SkillVersionCompareService.java`、`ReviewAuditService.java` | `SkillVersion` 与审核实体/Mapper |

关键方法：

- `SkillPackageUploadService#upload`：检查文件基本信息、流式扫描 ZIP 内的 `skill.md`、将 `Resource` 转发至文件服务器。
- `SkillService#checkExistsBySkillName`：按当前 `tenant_id`、未删除主行检查同名，排除草稿行。
- `SkillService#batchTestDirectImportFromBackend`：测试批量导入，写入 `origin=TEST` 并记录自动审核。
- `SkillService#importSkillFromBackend` / `doImportSkill`：原厂推送与租户投稿共用的 upsert 内核；通知由入口/审核语义决定。

## 3. tmanage 前端（租户控制台）

根路径：`tmanage-frontend/src/`

| 关注点 | 代码入口 |
|---|---|
| 技能列表与操作 | `pages/SkillPage.tsx` |
| 技能类型 | `pages/SkillTypePage.tsx` |
| API 聚合 | `api/index.ts` 中的 `skillApi` |
| 版本诊断 | `api/skillVersion.ts`、`components/SkillVersionDiagnosisModal.tsx` |
| 展示名 | `components/SkillDisplayNameModal.tsx` |
| 可见性 | `pages/SkillPage.tsx` 通过通用 `VisibilityModal` 调用 `skillApi` |
| 产物管控 | `components/SkillArtifactControlModal.tsx` |
| 智能体绑定 | `components/SkillBindingModal.tsx` |

企业中心子前端位于 `tmanage-frontend/enterprise-center-frontend/src/`；共享、导入或预检问题先看 `pages/SkillPage.tsx` 与 `components/modals/Skill*Modal.tsx`。

## 4. kdmanage 后端（平台/原厂侧）

根路径：`kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/`

| 关注点 | 首选入口 | 关键协作者 |
|---|---|---|
| 原厂技能管理 API | `controller/SkillController.java` | `service/SkillAppService.java` |
| 技能类型 | `controller/SkillTypeController.java` | `SkillType`、类型服务 |
| 版本历史 | `controller/SkillVersionController.java` | 版本服务/仓储 |
| ZIP 存储与导入解析 | `SkillAppService.java` | `SkillPackageStorageService.java`、`common/util/UploadValidator.java` |
| 发布审核 | `PublishReviewAppService.java` | 发布审核 Mapper/实体 |
| 向租户侧资源同步 | `EnterpriseResourceSyncService.java` | tmanage 后端接口客户端与事件/任务调用点 |
| 主数据 | `model/entity/Skill.java` | `mapper/SkillMapper.java`、版本/多语言 Mapper |

## 5. kdmanage 前端（平台控制台）

根路径：`kdmanage-frontend/src/`

| 关注点 | 代码入口 |
|---|---|
| 原厂技能列表 | `pages/SkillsPage.tsx` |
| 技能类型 | `pages/SkillTypesPage.tsx` |
| 导入/预解析 | `components/skill-dialog/SkillImportDialog.tsx` |
| 更新、ZIP 变更与预览 | `components/skill-dialog/SkillUpdateDialog.tsx`、`SkillMdDrawer.tsx` |
| 版本历史 | `components/skill-dialog/SkillVersionHistoryDialog.tsx` |
| API 定义 | `services/api.ts` 中的 `skillApi` |
| 路由/菜单 | `router/index.tsx` |

## 6. 定位纪律

- 代码中同时存在前端上传、open/build 上传、内部导入和历史兼容路径时，先确认实际请求命中的 Controller，不能只用一个 Service 名称推断全链路。
- `SkillService` 是租户侧主要内核，但页面行为还受前端筛选、可见性和接口返回字段影响。
- `SkillAppService` 负责平台侧导入/更新，但发布审核和同步可能由独立服务触发；需沿当前调用链确认。
