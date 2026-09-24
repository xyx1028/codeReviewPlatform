# MCP Hub 实现检查表

## 判据与一致性

- [ ] 没有在别处重写已有判据（`isOAuthFamily`、`requiresLingeeIdentitySelection` 等）
- [ ] 前后端同口径函数已同步（`authMethod.ts`、`mcpServiceAccess.ts`）
- [ ] 白名单两处一致（`OPEN_AUTH_METHODS` / `VISIBLE_AUTH_METHODS`）
- [ ] 多路径都改到了：两种 bundle 格式 + 聚合层；卡片单条路径 + 分页路径

## 契约

- [ ] Harness V2 有对应分支，不是落到静态凭据循环被静默跳过
- [ ] 老链路 `mcp-published-tool` 同步处理
- [ ] 新增 Controller 方法：确认并标注调用方、沿用统一 `Result<T>` 包装（流式/下载除外）
- [ ] 响应字段变更是扩展而非破坏；缺失语义与显式给值的区别已明确

## 数据

- [ ] Flyway 文件名 14 位时间戳、大于目录最大版本、PostgreSQL 语法、幂等
- [ ] 未修改已发布迁移
- [ ] **tmanage：patch 副本 + `datamodel.xml` 登记双份已补，自检五项全 0**
- [ ] 未对已发布表做破坏性变更
- [ ] 三态字段在库里保留三态，只在出口压平
- [ ] 敏感列走既有加密能力（实例凭证 AES / 用户凭据 ENV2），出口掩码

## 测试

- [ ] 相关单元或 MVC 测试编译并通过
- [ ] 扫描并更新了受影响的既有测试
- [ ] 前端 TypeScript 构建 + 对应 Vitest 用例
- [ ] 存量数据回归（老值能读、能编辑保持原值、能下发）

## 交付

- [ ] 列出修改/核查的文件与关键结论的代码证据
- [ ] 列出执行过的验证与未验证的环境前提
- [ ] 列出仍需用户决定的事项
- [ ] 文档已更新（`MCP Hub/` 下对应故事或设计文档）
