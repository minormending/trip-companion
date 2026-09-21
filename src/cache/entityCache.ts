import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CardKind, Provenance } from '../domain/types.ts'
import type { CardDraft } from '../content/providers/types.ts'

export interface CachedCard {
  draft: CardDraft
  provenance: Provenance
}

type Store = Record<string, CachedCard>

function slot(entityKey: string, kind: CardKind): string {
  return `${entityKey}#${kind}`
}

/**
 * Cards are stored against the real-world entity, not the trip that produced
 * them. The hundredth traveller through a station inherits the ninety-nine
 * earlier verifications, which is both the cost lever and the quality moat.
 */
export class EntityCache {
  #store: Store = {}
  #dirty = false

  readonly #path: string | undefined

  constructor(path?: string) {
    this.#path = path
  }

  static async open(path?: string): Promise<EntityCache> {
    const cache = new EntityCache(path)
    if (path) await cache.#load(path)
    return cache
  }

  async #load(path: string): Promise<void> {
    try {
      const raw = await readFile(path, 'utf8')
      this.#store = JSON.parse(raw) as Store
    } catch {
      this.#store = {}
    }
  }

  get(entityKey: string, kind: CardKind): CachedCard | undefined {
    return this.#store[slot(entityKey, kind)]
  }

  set(entityKey: string, kind: CardKind, value: CachedCard): void {
    this.#store[slot(entityKey, kind)] = value
    this.#dirty = true
  }

  /** Lowers confidence on a card a traveller flagged. Never raises it. */
  flag(entityKey: string, kind: CardKind, penalty = 0.35): boolean {
    const existing = this.#store[slot(entityKey, kind)]
    if (!existing) return false
    existing.provenance.confidence = Math.max(0, existing.provenance.confidence - penalty)
    this.#dirty = true
    return true
  }

  get size(): number {
    return Object.keys(this.#store).length
  }

  async flush(): Promise<void> {
    if (!this.#path || !this.#dirty) return
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#store, null, 2)}\n`, 'utf8')
    this.#dirty = false
  }
}
