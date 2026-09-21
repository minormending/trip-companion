import type { CachedCard } from './entityCache.ts'

export type CacheSnapshot = Record<string, CachedCard>

/** Where a cache persists. Keeps the cache itself free of platform imports. */
export interface CacheStore {
  load(): Promise<CacheSnapshot>
  save(snapshot: CacheSnapshot): Promise<void>
}
