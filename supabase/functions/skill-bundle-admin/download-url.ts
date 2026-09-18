const SKILL_BUNDLE_SIGNED_PATH_PREFIX = '/storage/v1/object/sign/skill-bundles/'

/**
 * storage-js 会把 SUPABASE_URL 拼进 signedUrl；本地 Edge Runtime 中这个值是容器地址。
 * 响应给浏览器前先移除 origin，同时确认签名确实属于预期的私有 bucket 端点。
 */
export function toSkillBundleSignedPath(signedUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(signedUrl)
  } catch {
    throw new Error('storage returned an invalid signed URL')
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.pathname.startsWith(SKILL_BUNDLE_SIGNED_PATH_PREFIX) ||
    !parsed.searchParams.has('token') ||
    parsed.hash !== ''
  ) {
    throw new Error('storage returned an unexpected signed URL')
  }

  return `${parsed.pathname}${parsed.search}`
}
