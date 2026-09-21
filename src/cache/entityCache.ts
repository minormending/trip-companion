import type { CardKind, Provenance } from '../domain/types.ts'
import type { CardDraft } from '../content/providers/types.ts'
import type { CacheSnapshot, CacheStore } from './store.ts'

export interface CachedCard {
  draft: CardDraft
  provenance: Provenance
}

function slot(entityKey: string, kind: CardKind): string {
  return `${entityKey}#${kind}`
}

/**
 * Cards are stored against the real-world entity, not the trip that produced
 * them. The hundredth traveller through a station inherits the ninety-nine
 * earlier verifications, which is both the cost lever and the quality moat.
 *
 * Persistence is injected so the same cache runs against the filesystem in the
 * CLI and against localStorage in the browser.
 */
export class EntityCache {
  #snapshot: CacheSnapshot = {}
  #dirty = false
  readonly #store: CacheStore | undefined

  constructor(store?: CacheStore) {
    this.#store = store
  }

  static async open(store?: CacheStore): Promise<EntityCache> {
    const cache = new EntityCache(store)
    if (store) {
      try {
        cache.#snapshot = await store.load()
      } catch {
        cache.#snapshot = {}
      }
    }
    return cache
  }

  get(entityKey: string, kind: CardKind): CachedCard | undefined {
    return this.#snapshot[slot(entityKey, kind)]
  }

  set(entityKey: string, kind: CardKind, value: CachedCard): void {
    this.#snapshot[slot(entityKey, kind)] = value
    this.#dirty = true
  }

  /** Lowers confidence on a card a traveller flagged. Never raises it. */
  flag(entityKey: string, kind: CardKind, penalty = 0.35): boolean {
    const existing = this.#snapshot[slot(entityKey, kind)]
    if (!existing) return false
    existing.provenance.confidence = Math.max(0, existing.provenance.confidence - penalty)
    this.#dirty = true
    return true
  }

  get size(): number {
    return Object.keys(this.#snapshot).length
  }

  async flush(): Promise<void> {
    if (!this.#store || !this.#dirty) return
    await this.#store.save(this.#snapshot)
    this.#dirty = false
  }
}
