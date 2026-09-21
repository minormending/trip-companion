import { createClient, type User } from '@supabase/supabase-js'

/**
 * Injected at build time. Both blank means no backend is configured, and the
 * app runs exactly as it did before: everything local, nothing shared. That is
 * a supported mode, not a degraded one — the Pages deploy ran that way for
 * several phases and must keep working.
 */
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

function make(url: string, key: string) {
  return createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    // This app owns the `trip` schema. `public` holds the shared platform layer
    // that every app in this database uses: profiles, rate_limit, moderation.
    db: { schema: 'trip' },
  })
}

/** Inferred rather than hand-written: the client's type carries its schema. */
export type AppClient = ReturnType<typeof make>

let client: AppClient | null | undefined

export function supabase(): AppClient | null {
  if (client === undefined) {
    const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : ''
    const key = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : ''
    client = url && key ? make(url, key) : null
  }
  return client
}

export function backendConfigured(): boolean {
  return supabase() !== null
}

export async function currentUser(): Promise<User | null> {
  const db = supabase()
  if (!db) return null
  const { data } = await db.auth.getUser()
  return data.user ?? null
}

/** Magic link: no password to store, and no password to leak. */
export async function signIn(email: string, redirectTo: string): Promise<{ error?: string }> {
  const db = supabase()
  if (!db) return { error: 'No backend configured.' }
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  })
  return error ? { error: error.message } : {}
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut()
}
