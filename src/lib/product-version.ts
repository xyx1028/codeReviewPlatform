/**
 * 管理员“查看当前版本”的唯一事实来源。
 *
 * 每次完成版本化最终执行方案时必须由 version-display-sync Skill 同步，并通过
 * `npm run version:check -- <最终执行方案路径>` 校验。
 */
export const PRODUCT_VERSION = 'V1.30'
