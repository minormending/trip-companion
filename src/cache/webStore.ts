import type { CacheSnapshot, CacheStore } from './store.ts'

/**
 * Browser persistence. Private windows and blocked site data make every access
 * throw, so both sides swallow failures and the app runs cacheless instead.
 */
export class LocalStorageStore implements CacheStore {
  readonly #key: string

  constructor(key = 'trip-companion:entities') {
    this.#key = key
  }

  async load(): Promise<CacheSnapshot> {
    try {
      const raw = globalThis.localStorage?.getItem(this.#key)
      return raw ? (JSON.parse(raw) as CacheSnapshot) : {}
    } catch {
      return {}
    }
  }

  async save(snapshot: CacheSnapshot): Promise<void> {
    try {
      globalThis.localStorage?.setItem(this.#key, JSON.stringify(snapshot))
    } catch {
      /* quota, private mode, or blocked site data: carry on without a cache */
    }
  }
}
