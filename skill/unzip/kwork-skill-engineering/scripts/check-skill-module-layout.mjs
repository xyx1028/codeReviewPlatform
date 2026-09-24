#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = process.argv[2] ? resolve(process.argv[2]) : null;

if (!workspace) {
  console.error(JSON.stringify({ ok: false, error: 'usage: node scripts/check-skill-module-layout.mjs <workspace-root>' }));
  process.exit(2);
}

const groups = {
  tmanageBackend: [
    'tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/controller/SkillController.java',
    'tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/controller/open/OpenSkillController.java',
    'tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/service/SkillService.java',
    'tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/service/SkillPackageUploadService.java'
  ],
  tmanageFrontend: [
    'tmanage-frontend/src/pages/SkillPage.tsx',
    'tmanage-frontend/src/api/index.ts'
  ],
  kdmanageBackend: [
    'kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/controller/SkillController.java',
    'kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/service/SkillAppService.java',
    'kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/common/util/UploadValidator.java'
  ],
  kdmanageFrontend: [
    'kdmanage-frontend/src/pages/SkillsPage.tsx',
    'kdmanage-frontend/src/services/api.ts',
    'kdmanage-frontend/src/components/skill-dialog/SkillImportDialog.tsx'
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
