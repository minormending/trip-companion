import type { CorrectionPersistence, CorrectionSnapshot } from './store.ts'

/**
 * Browser persistence. Corrections held here reach nobody else — there is no
 * backend in v1 — so they are also exportable, which is how they actually get
 * back to whoever reviews them. Section 5 of the spec treats that as the
 * cold-start seeding path.
 */
export class LocalStorageCorrections implements CorrectionPersistence {
  readonly #key: string

  constructor(key = 'trip-companion:corrections') {
    this.#key = key
  }

  async load(): Promise<CorrectionSnapshot> {
    try {
      const raw = globalThis.localStorage?.getItem(this.#key)
      return raw ? (JSON.parse(raw) as CorrectionSnapshot) : {}
    } catch {
      return {}
    }
  }

  async save(snapshot: CorrectionSnapshot): Promise<void> {
    try {
      globalThis.localStorage?.setItem(this.#key, JSON.stringify(snapshot))
    } catch {
      /* private mode or blocked site data: the flag is lost, the app is not */
    }
  }
}
