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

/**
 * Google, and only Google.
 *
 * This replaced a magic link. The link was the thing people reported being
 * confused by, and the confusion was structural rather than a wording problem:
 * a sign-in that asks for an address, sends you to another application, and
 * depends on you returning to the same browser has three places to lose
 * somebody. OAuth hands that entire problem to a party who has solved it.
 *
 * There is no password here either way. The difference is that nobody has to
 * be told so.
 */
export async function signInWithGoogle(redirectTo: string): Promise<{ error?: string }> {
  const db = supabase()
  if (!db) return { error: 'No backend configured.' }
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  })
  return error ? { error: error.message } : {}
}

/**
 * Call an edge function, which is where anything the browser is not allowed to
 * reach has to happen. The anon key goes in both headers it might be wanted
 * in, so the call works whether or not the function was deployed with JWT
 * verification on.
 */
export async function callFunction(
  name: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : ''
  const key = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : ''
  if (!url || !key) return null

  const query = new URLSearchParams(params).toString()
  // A signed-in caller's own token is better than the anon key: a function
  // that later starts checking who is asking then keeps working unchanged.
  const { data } = (await supabase()?.auth.getSession()) ?? { data: { session: null } }
  const bearer = data.session?.access_token ?? key

  return fetch(`${url}/functions/v1/${name}?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${bearer}` },
    ...(signal ? { signal } : {}),
  })
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut()
}
