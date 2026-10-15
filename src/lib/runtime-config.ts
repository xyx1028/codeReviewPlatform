/**
 * Browser configuration whose values are available before the application
 * module graph starts. `index.html` loads /runtime-config.js first.
 *
 * Local Vite development keeps using VITE_* as a fallback. Company Linux
 * mounts a runtime-config.js over the image default, so its CI build does not
 * need to know the Supabase domain or client anon key.
 */
export interface RuntimeConfigInput {
  supabaseUrl?: string
  supabaseAnonKey?: string
  wechatLoginEnabled?: boolean
  linkyApiBaseUrl?: string
}

declare global {
  interface Window {
    __CRP_RUNTIME_CONFIG__?: RuntimeConfigInput
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const injected = typeof window === 'undefined' ? undefined : window.__CRP_RUNTIME_CONFIG__

export const runtimeConfig = Object.freeze({
  supabaseUrl: text(injected?.supabaseUrl) ?? text(import.meta.env.VITE_SUPABASE_URL),
  supabaseAnonKey: text(injected?.supabaseAnonKey) ?? text(import.meta.env.VITE_SUPABASE_ANON_KEY),
  wechatLoginEnabled:
    typeof injected?.wechatLoginEnabled === 'boolean'
      ? injected.wechatLoginEnabled
      : import.meta.env.VITE_WECHAT_LOGIN_ENABLED === 'true',
  linkyApiBaseUrl: text(injected?.linkyApiBaseUrl) ?? text(import.meta.env.VITE_LINKY_API_BASE_URL),
})
