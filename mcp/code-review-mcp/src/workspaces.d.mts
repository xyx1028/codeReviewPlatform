/**
 * 类型声明。只为让前端的 `workspace-presets-sync.test.ts` 能在 tsc 下 import 这份清单
 * —— 那条测试负责强制"前端与 MCP 两份清单完全一致"。
 *
 * 这里只声明类型，不复制数据：清单的唯一内容来源是 `workspaces.mjs`。
 */
export declare const LINKY_WORKSPACE_PRESETS: readonly string[]
export declare function filterWorkspaces(
  keyword: string | null | undefined,
  presets?: readonly string[],
): string[]
