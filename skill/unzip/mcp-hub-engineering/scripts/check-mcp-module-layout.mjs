#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = process.argv[2] ? resolve(process.argv[2]) : null;

if (!workspace) {
  console.error(JSON.stringify({ ok: false, error: 'usage: node scripts/check-mcp-module-layout.mjs <workspace-root>' }));
  process.exit(2);
}

const TM = 'tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage';
const KD = 'kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage';

const groups = {
  kdmanageBackend: [
    `${KD}/service/mcphub/McpHubService.java`,
    `${KD}/service/mcphub/McpAuthMethods.java`,
    `${KD}/service/McpClientService.java`,
    `${KD}/service/McpEnterpriseResourceSyncService.java`,
    `${KD}/job/McpHubToolRefreshJob.java`
  ],
  kdmanageFrontend: [
    'kdmanage-frontend/src/components/mcp-hub/authMethod.ts',
    'kdmanage-frontend/src/pages/McpHubPage.tsx',
    'kdmanage-frontend/src/pages/McpHubDetailModal.tsx'
  ],
  tmanageBackend: [
    `${TM}/service/McpHubService.java`,
    `${TM}/service/McpCredentialsV2Service.java`,
    `${TM}/service/McpHubProductToolsService.java`,
    `${TM}/service/McpHubProductToolsAggregationService.java`,
    `${TM}/service/McpPersonalAuthService.java`,
    `${TM}/service/McpOAuthService.java`,
    `${TM}/service/McpCredentialMigrationService.java`,
    `${TM}/identity/McpLingeeIdentityResolver.java`,
    `${TM}/controller/McpPersonalAuthController.java`,
    `${TM}/task/McpToolCatalogRefreshJob.java`
  ],
  tmanageFrontend: [
    'tmanage-frontend/src/pages/McpServicePage.tsx',
    'tmanage-frontend/src/components/McpInstanceEnableModal.tsx',
    'tmanage-frontend/src/utils/mcpServiceAccess.ts'
  ],
  docsAndGuards: [
    'MCP Hub/设计/架构与数据流.md',
    'MCP Hub/设计/表设计.md',
    '.kiro/scripts/check-tmanage-patch-mirror.sh'
  ]
};

const result = {};
let ok = true;

for (const [group, paths] of Object.entries(groups)) {
  const missing = paths.filter((relativePath) => !existsSync(resolve(workspace, relativePath)));
  result[group] = { expected: paths.length, missing };
  ok &&= missing.length === 0;
}

console.log(JSON.stringify({ workspace, ok, groups: result }, null, 2));
process.exitCode = ok ? 0 : 1;
