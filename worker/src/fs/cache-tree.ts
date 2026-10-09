/**
 * 共享的缓存目录遍历工具。
 *
 * 技能包 cache 与仓库快照 cache 是两套独立的 cache，但它们的目录形态完全一样：
 * 发布后是只读树、回收按容量 LRU、回收无损。这两件事（量体积、解锁只读树）各写一份
 * 的代价是其中一份修了 bug 另一份不会修 —— `relaxTree` 里"自底向上 chmod"那条注释
 * 就是实测踩出来的，复制一份就等于复制一次踩坑的机会。
 */

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目录内全部常规文件的字节数之和。读不到的条目跳过，不让回收因为一个坏条目整体失败。 */
export function directorySize(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) stack.push(path)
      else total += stats.size
    }
  }
  return total
}

/**
 * 恢复可写权限，让 `rm -r` 能删掉一棵只读树。
 *
 * cache 目录发布后是 0500/0400。删除一个目录里的条目需要**目录**的写权限，所以不先
 * 放宽权限的 `rmSync` 会在只读子目录上失败 —— 而"回收静默失败"的表现是磁盘慢慢满，
 * 一个月后才有人发现。
 */
export function relaxTree(root: string): void {
  if (!existsSync(root)) return
  const stack = [root]
  const dirs: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    dirs.push(current)
    let names: string[]
    try {
      chmodSync(current, 0o700)
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      try {
        const stats = statSync(path)
        if (stats.isDirectory()) stack.push(path)
        else chmodSync(path, 0o600)
      } catch {
        continue
      }
    }
  }
  for (const dir of dirs.reverse()) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      continue
    }
  }
}
