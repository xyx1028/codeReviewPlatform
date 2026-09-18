import { describe, expect, it } from 'vitest'
import { buildSkillBundleDownloadUrl } from '../skill-download-url'

const SIGNED_PATH =
  '/storage/v1/object/sign/skill-bundles/skill-id/versions/2/archive.zip?token=signed-token'

describe('buildSkillBundleDownloadUrl', () => {
  it('uses the browser-accessible local Supabase origin', () => {
    expect(buildSkillBundleDownloadUrl(SIGNED_PATH, 'http://127.0.0.1:54321')).toBe(
      `http://127.0.0.1:54321${SIGNED_PATH}`,
    )
  })

  it('uses the public hosted Supabase origin and ignores a trailing slash', () => {
    expect(buildSkillBundleDownloadUrl(SIGNED_PATH, 'https://project-ref.supabase.co/')).toBe(
      `https://project-ref.supabase.co${SIGNED_PATH}`,
    )
  })

  it.each([
    'http://kong:8000/storage/v1/object/sign/skill-bundles/archive.zip?token=x',
    '//attacker.example/storage/v1/object/sign/skill-bundles/archive.zip?token=x',
    '/storage/v1/object/sign/another-bucket/archive.zip?token=x',
    '/storage/v1/object/sign/skill-bundles/archive.zip',
    '/storage/v1/object/sign/skill-bundles/archive.zip?token=x#fragment',
    '/storage/v1/object/sign/skill-bundles/../../../../..//attacker.example/payload?token=x',
    '/storage/v1/object/sign/skill-bundles/..\\..\\..\\..\\attacker.example/payload?token=x',
    '/storage/v1/object/sign/skill-bundles/%2e%2e/%2e%2e//attacker.example/payload?token=x',
  ])('rejects an invalid or non-relative signed path: %s', (signedPath) => {
    expect(() =>
      buildSkillBundleDownloadUrl(signedPath, 'https://project-ref.supabase.co'),
    ).toThrow('下载地址格式无效')
  })
})
