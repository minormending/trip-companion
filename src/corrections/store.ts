import type { CardKind } from '../domain/types.ts'

export type CorrectionStatus = 'open' | 'accepted' | 'rejected'

export interface Correction {
  id: string
  /**
   * The real-world entity, not the trip. A correction found on one traveller's
   * trip has to outlive that trip or the dataset never compounds.
   */
  entityKey: string
  cardKind: CardKind
  /** What the traveller said was wrong. Free text, theirs, unedited. */
  claim: string
  /** The card body they were looking at, so review can see what they saw. */
  sawBody: string
  submittedAt: string
  status: CorrectionStatus
  /** Set when review accepts: the text that replaces the card from now on. */
  correctedBody?: string
}

export type CorrectionSnapshot = Record<string, Correction>

export interface CorrectionPersistence {
  load(): Promise<CorrectionSnapshot>
  save(snapshot: CorrectionSnapshot): Promise<void>
}

function slot(entityKey: string, kind: CardKind): string {
  return `${entityKey}#${kind}`
}

export class CorrectionStore {
  #byId: CorrectionSnapshot = {}
  #dirty = false
  readonly #persistence: CorrectionPersistence | undefined

  constructor(persistence?: CorrectionPersistence) {
    this.#persistence = persistence
  }

  static async open(persistence?: CorrectionPersistence): Promise<CorrectionStore> {
    const store = new CorrectionStore(persistence)
    if (persistence) {
      try {
        store.#byId = await persistence.load()
      } catch {
        store.#byId = {}
      }
    }
    return store
  }

  add(correction: Correction): void {
    this.#byId[correction.id] = correction
    this.#dirty = true
  }

  get(id: string): Correction | undefined {
    return this.#byId[id]
  }

  all(): Correction[] {
    return Object.values(this.#byId)
  }

  forCard(entityKey: string, kind: CardKind): Correction[] {
    const key = slot(entityKey, kind)
    return this.all().filter((c) => slot(c.entityKey, c.cardKind) === key)
  }

  openFor(entityKey: string, kind: CardKind): Correction[] {
    return this.forCard(entityKey, kind).filter((c) => c.status === 'open')
  }

  /** The accepted correction that should replace this card, if review made one. */
  acceptedFor(entityKey: string, kind: CardKind): Correction | undefined {
    return this.forCard(entityKey, kind)
      .filter((c) => c.status === 'accepted' && c.correctedBody)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
  }

  resolve(id: string, status: 'accepted' | 'rejected', correctedBody?: string): boolean {
    const existing = this.#byId[id]
    if (!existing || existing.status !== 'open') return false
    existing.status = status
    if (status === 'accepted' && correctedBody) existing.correctedBody = correctedBody
    this.#dirty = true
    return true
  }

  get size(): number {
    return Object.keys(this.#byId).length
  }

  async flush(): Promise<void> {
    if (!this.#persistence || !this.#dirty) return
    await this.#persistence.save(this.#byId)
    this.#dirty = false
  }
}
