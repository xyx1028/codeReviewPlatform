#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [documentPath] = process.argv.slice(2)
if (!documentPath) {
  console.error('用法：npm run version:check -- <最终执行方案路径>')
  process.exit(1)
}

const resolvedDocumentPath = resolve(documentPath)
const documentText = readFileSync(resolvedDocumentPath, 'utf8')
const versionSourcePath = resolve('src/lib/product-version.ts')
const versionSource = readFileSync(versionSourcePath, 'utf8')

const documentVersion = documentText.match(
  /^#\s+需求开发评审一致性平台\s+(V\d+\.\d+)[：:]/m,
)?.[1]
const productVersion = versionSource.match(
  /export\s+const\s+PRODUCT_VERSION\s*=\s*['"](V\d+\.\d+)['"]/,
)?.[1]

if (!documentVersion) {
  console.error(`无法从最终执行方案标题解析版本：${resolvedDocumentPath}`)
  process.exit(1)
}
if (!productVersion) {
  console.error(`无法从产品版本常量解析版本：${versionSourcePath}`)
  process.exit(1)
}

console.log(`需求文档版本：${documentVersion}`)
console.log(`管理员展示版本：${productVersion}`)

if (documentVersion !== productVersion) {
  console.error(`版本不同步：文档为 ${documentVersion}，产品为 ${productVersion}`)
  process.exit(1)
}

console.log('版本同步校验通过。')
