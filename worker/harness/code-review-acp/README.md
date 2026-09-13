# V4 Harness Manifest

## 唯一人工维护入口

当前 DeepSeek Harness 能力、工具权限和平台默认策略统一维护在：

`worker/harness/code-review-acp/v4-capability-contract.json`

不要直接修改以下派生内容：

- 数据库 `v4_harness_manifest.default_policy`；
- 管理页面返回的默认策略；
- Worker 的 `V4_DEFAULT_POLICY`。

Worker 会直接读取 manifest 中的 `defaultPolicy`。数据库通过版本化迁移保存该文件的部署副本，管理页面读取数据库当前激活版本。

## Manifest 包含什么

| 字段 | 用途 |
|---|---|
| `manifestRevision` | Manifest 发布版本。每次升级能力或默认策略都必须递增。 |
| `harnessVersion` | 当前适配的 `@deepseek-ai/dsh` 精确版本。 |
| `bundles` | 使用的 Harness bundles。 |
| `defaultPolicy` | 20 个能力开关及沙箱、Agent、预算、Web、Session 默认值。 |
| `enabledPlugins` | 必须启用的 Harness 插件。 |
| `disabledPlugins` | 明确禁用或由平台替代的插件。 |
| `platformPlugins` | 平台自有治理插件。 |
| `modelTools` | 模型可能看到的完整工具清单及副作用分类。 |
| `roleTools` | 每种 Agent 角色允许使用的工具。 |
| `brokerRoutes` | Broker 路由及所需权限。 |
| `errorCodes` | 稳定治理错误码。 |

## 升级 DeepSeek Harness

1. 升级 `package.json` 中所有相关 `@deepseek-ai/dsh*` 精确版本并更新 lockfile。
2. 对照新版本的 bundle、插件和真实工具清单，修改 `v4-capability-contract.json`。
3. 修改 `harnessVersion`，并递增 `manifestRevision`。
4. 检查新增工具的角色权限、是否修改数据、是否允许并行以及 Broker 权限。
5. 生成新的数据库迁移，例如：

   ```bash
   npm run harness:manifest:new-migration -- 0032
   ```

   迁移编号必须是当前最新编号的下一个编号；已执行过的旧迁移不能修改。
6. 执行一致性检查和测试：

   ```bash
   npm run harness:manifest:check
   npm run test:worker -- --run worker/src/__tests__/v4-capability-contract.test.ts
   npm run build
   ```

7. 通过维护窗口完成切换，避免新旧 manifest 混跑：
   1. 暂停创建新任务；
   2. 等待旧 revision 的排队/运行任务完成，无法排空的任务需先取消；
   3. 停止旧 Worker；
   4. 执行新数据库迁移，并部署匹配该 revision 的 Worker 和应用；
   5. 确认 Worker 注册的 `capability_contract_hash` 与 active manifest 一致后，再恢复任务创建。

已完成任务仍保留创建时冻结的策略、Harness 版本和 manifest hash 用于审计；当前 Worker 只执行与自身 manifest hash 一致的任务，不会用新能力配置继续执行旧 revision 的排队任务。

## 防漂移机制

`npm run harness:manifest:check` 会检查：

- Manifest 版本和结构；
- 所有默认能力是否开启；
- `harnessVersion` 是否与安装依赖一致；
- 最新数据库迁移是否由当前 manifest 生成；
- 数据库默认策略是否与 manifest 完全一致；
- Manifest 语义摘要是否一致。

该检查已接入前端构建、Worker 构建和 Worker 测试。只修改 manifest 而忘记生成迁移时，构建会直接失败。
