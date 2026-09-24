import { describe, it, expect } from 'vitest'
import {
  assertBranch,
  assertRepositoryName,
  getRepositoryUrl,
  normalizeGitLabBaseUrl,
  isBranchName,
  isRepositoryName,
  REPOSITORIES,
  REPOSITORY_NAMES,
  ALLOWED_BRANCHES,
} from '../git/repositories.js'

describe('branch enum validation', () => {
  it('accepts the three allowed branches', () => {
    for (const b of ALLOWED_BRANCHES) {
      expect(isBranchName(b)).toBe(true)
      expect(assertBranch(b)).toBe(b)
    }
  })

  it('rejects unknown or malformed branches', () => {
    for (const b of ['main', 'master', 'FEATURE_DEV', 'feature-dev', '', null, 123]) {
      expect(isBranchName(b as unknown)).toBe(false)
    }
    expect(() => assertBranch('main')).toThrow(/branch not allowed/)
  })
})

describe('repository whitelist', () => {
  it('has exactly the five reviewed repositories', () => {
    expect(REPOSITORY_NAMES).toHaveLength(5)
    expect(new Set(REPOSITORY_NAMES)).toEqual(
      new Set([
        'kdmanage-backend',
        'kdmanage-frontend',
        'kwork-server',
        'tmanage-backend',
        'tmanage-frontend',
      ]),
    )
  })

  it('resolves whitelisted names to kingdee git URLs', () => {
    for (const r of REPOSITORIES) {
      expect(getRepositoryUrl(r.name)).toBe(r.url)
      expect(r.url.startsWith('https://git.kingdee.com/kwork/')).toBe(true)
      expect(isRepositoryName(r.name)).toBe(true)
      expect(assertRepositoryName(r.name)).toBe(r.name)
    }
  })

  /*
   * 路径不是从名字推导出来的，这一条把它钉死。
   *
   * 前四个仓在 `kwork/manage/` 下，`kwork-server` 直接在 `kwork/` 下。任何"用名字拼前缀"的
   * 简化都会让 kwork-server 指向一个不存在的 `kwork/manage/kwork-server.git`，而表现是
   * 准备阶段 clone 失败 —— 一个看起来像网络问题的错误。
   */
  it('keeps each repository path explicit rather than derived from its name', () => {
    const byName = new Map(REPOSITORIES.map((r) => [r.name, r.path]))
    expect(byName.get('kwork-server')).toBe('/kwork/kwork-server.git')
    expect(byName.get('kdmanage-backend')).toBe('/kwork/manage/kdmanage-backend.git')
    expect(byName.get('tmanage-frontend')).toBe('/kwork/manage/tmanage-frontend.git')
  })

  it('supports a trusted custom origin while keeping every repository path fixed', () => {
    expect(getRepositoryUrl('kdmanage-backend', 'http://git-mock:8080')).toBe(
      'http://git-mock:8080/kwork/manage/kdmanage-backend.git',
    )
    expect(normalizeGitLabBaseUrl('https://git.kingdee.com/')).toBe('https://git.kingdee.com')
  })

  it('rejects unsafe GitLab base URLs', () => {
    for (const value of [
      'ftp://git.example.com',
      'https://user:password@git.example.com',
      'https://git.example.com/attacker-controlled',
      'https://git.example.com?token=value',
      'https://git.example.com#fragment',
      'not-a-url',
    ]) {
      expect(() => normalizeGitLabBaseUrl(value)).toThrow(/invalid GITLAB_BASE_URL/)
    }
  })

  it('rejects arbitrary repository names and URLs', () => {
    expect(isRepositoryName('evil-repo')).toBe(false)
    expect(isRepositoryName('https://attacker.example/repo.git')).toBe(false)
    expect(() => getRepositoryUrl('evil-repo')).toThrow(/not in whitelist/)
    expect(() => getRepositoryUrl('https://attacker.example/x.git')).toThrow(/not in whitelist/)
    expect(() => assertRepositoryName('nope')).toThrow(/not in whitelist/)
  })
})
