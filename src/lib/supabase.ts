import { createClient } from '@supabase/supabase-js'
import { runtimeConfig } from './runtime-config'

const { supabaseUrl, supabaseAnonKey } = runtimeConfig

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

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
