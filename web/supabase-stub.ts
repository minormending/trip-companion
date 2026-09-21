/**
 * Stands in for @supabase/supabase-js in a build with no backend configured.
 *
 * The real library is about 220kB, and in local-only mode nothing ever calls
 * it. Shipping it anyway would put a fifth of a megabyte of dead code into a
 * bundle whose whole purpose is to be downloaded before a trip and used with
 * no signal.
 */
export function createClient(): never {
  throw new Error('This build has no backend configured.')
}
