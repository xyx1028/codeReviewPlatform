const SKILL_BUNDLE_SIGNED_PATH_PREFIX = '/storage/v1/object/sign/skill-bundles/'
const PATH_VALIDATION_ORIGIN = 'https://signed-path.invalid'

/** 用浏览器可访问的 Supabase origin 还原服务端签发的相对下载路径。 */
export function buildSkillBundleDownloadUrl(signedPath: string, supabaseUrl: string): string {
  if (!signedPath.startsWith(SKILL_BUNDLE_SIGNED_PATH_PREFIX)) {
    throw new Error('下载地址格式无效')
  }

  let relative: URL
  let publicSupabase: URL
  try {
    relative = new URL(signedPath, PATH_VALIDATION_ORIGIN)
    publicSupabase = new URL(supabaseUrl)
  } catch {
    throw new Error('下载地址格式无效')
  }

  if (
    relative.origin !== PATH_VALIDATION_ORIGIN ||
    !relative.pathname.startsWith(SKILL_BUNDLE_SIGNED_PATH_PREFIX) ||
    !relative.searchParams.has('token') ||
    relative.hash !== '' ||
    (publicSupabase.protocol !== 'http:' && publicSupabase.protocol !== 'https:') ||
    publicSupabase.username !== '' ||
    publicSupabase.password !== ''
  ) {
    throw new Error('下载地址格式无效')
  }

  // 不再把规范化后的路径交给 URL resolver，避免 `//host` 被解释为新的 origin。
  return `${publicSupabase.origin}${relative.pathname}${relative.search}`
}

export function getSkillBundleDownloadUrl(signedPath: string): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  if (!supabaseUrl) throw new Error('请先配置 VITE_SUPABASE_URL')
  return buildSkillBundleDownloadUrl(signedPath, supabaseUrl)
}
