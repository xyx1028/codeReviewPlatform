import { describe, expect, it } from 'vitest'
import { toSkillBundleSignedPath } from './download-url'

const SIGNED_PATH =
  '/storage/v1/object/sign/skill-bundles/skill-id/versions/2/archive.zip?token=signed-token'

describe('toSkillBundleSignedPath', () => {
  it.each([
    'http://kong:8000',
    'http://127.0.0.1:54321',
    'https://project-ref.supabase.co',
  ])('removes the storage client origin %s', (origin) => {
    expect(toSkillBundleSignedPath(`${origin}${SIGNED_PATH}`)).toBe(SIGNED_PATH)
  })

  it.each([
    'not-a-url',
    'ftp://kong:8000/storage/v1/object/sign/skill-bundles/archive.zip?token=x',
    'http://kong:8000/storage/v1/object/sign/another-bucket/archive.zip?token=x',
    'http://kong:8000/storage/v1/object/sign/skill-bundles/archive.zip',
    'http://kong:8000/storage/v1/object/sign/skill-bundles/archive.zip?token=x#fragment',
  ])('rejects an unexpected signed URL: %s', (signedUrl) => {
    expect(() => toSkillBundleSignedPath(signedUrl)).toThrow()
  })
})
