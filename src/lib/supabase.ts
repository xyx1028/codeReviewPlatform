import { createClient } from '@supabase/supabase-js'
import { runtimeConfig } from './runtime-config'
import { captureRecoveryLanding } from './password-recovery'

const { supabaseUrl, supabaseAnonKey } = runtimeConfig

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

// 必须在 createClient 之前：detectSessionInUrl 会把恢复链接的 hash 换成会话并清掉 URL，
// 之后就再也看不出"这是一次密码重置落地"了。
captureRecoveryLanding()

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null

export function requireSupabase() {
  if (!supabase) {
    throw new Error('请先配置 Supabase 浏览器地址和 anon key')
  }
  return supabase
}
