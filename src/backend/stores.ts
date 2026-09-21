import type { SupabaseClient } from '@supabase/supabase-js'
import type { CacheSnapshot, CacheStore } from '../cache/store.ts'
import type { CorrectionPersistence, CorrectionSnapshot, Correction } from '../corrections/store.ts'
import type { Tier } from '../domain/types.ts'

/**
 * Supabase-backed implementations of the same interfaces the local stores
 * implement, so the domain layer is untouched: signed out the app writes to
 * localStorage, signed in it writes here, and nothing else changes.
 */

interface EntityCardRow {
  entity_key: string
  kind: string
  title: string
  body: string
  sources: unknown
  tier: string
  verified_at: string
  confidence: number
}

export class SupabaseCacheStore implements CacheStore {
  readonly #db: SupabaseClient

  constructor(db: SupabaseClient) {
    this.#db = db
  }

  async load(): Promise<CacheSnapshot> {
    const { data, error } = await this.#db
      .from('entity_cards')
      .select('entity_key, kind, title, body, sources, tier, verified_at, confidence')
    if (error || !data) return {}

    const snapshot: CacheSnapshot = {}
    for (const row of data as EntityCardRow[]) {
      snapshot[`${row.entity_key}#${row.kind}`] = {
        draft: {
          title: row.title,
          body: row.body,
          sources: Array.isArray(row.sources) ? (row.sources as never[]) : [],
        },
        provenance: {
          tier: row.tier as Tier,
          sources: Array.isArray(row.sources) ? (row.sources as never[]) : [],
          verifiedAt: row.verified_at,
          confidence: row.confidence,
        },
      }
    }
    return snapshot
  }

  /**
   * A no-op by design. entity_cards has no insert or update policy: writes
   * arrive from review or the warming job under the service role, so one
   * traveller cannot poison the store every other traveller reads.
   */
  async save(): Promise<void> {}
}

interface CorrectionRow {
  id: string
  entity_key: string
  card_kind: string
  claim: string
  saw_body: string
  status: Correction['status']
  corrected_body: string | null
  submitted_at: string
}

export class SupabaseCorrections implements CorrectionPersistence {
  readonly #db: SupabaseClient
  readonly #userId: string

  constructor(db: SupabaseClient, userId: string) {
    this.#db = db
    this.#userId = userId
  }

  async load(): Promise<CorrectionSnapshot> {
    const { data, error } = await this.#db
      .from('corrections')
      .select('id, entity_key, card_kind, claim, saw_body, status, corrected_body, submitted_at')
    if (error || !data) return {}

    const snapshot: CorrectionSnapshot = {}
    for (const row of data as CorrectionRow[]) {
      snapshot[row.id] = {
        id: row.id,
        entityKey: row.entity_key,
        cardKind: row.card_kind as Correction['cardKind'],
        claim: row.claim,
        sawBody: row.saw_body,
        status: row.status,
        submittedAt: row.submitted_at,
        ...(row.corrected_body ? { correctedBody: row.corrected_body } : {}),
      }
    }
    return snapshot
  }

  /**
   * Only new reports are pushed. Resolution goes through accept_correction,
   * which is a reviewer action — a traveller cannot accept their own report,
   * and that is what stops one person rewriting a shared card unilaterally.
   */
  async save(snapshot: CorrectionSnapshot): Promise<void> {
    const rows = Object.values(snapshot)
      .filter((c) => c.status === 'open')
      .map((c) => ({
        id: c.id,
        entity_key: c.entityKey,
        card_kind: c.cardKind,
        claim: c.claim,
        saw_body: c.sawBody,
        status: c.status,
        submitted_by: this.#userId,
        submitted_at: c.submittedAt,
      }))
    if (rows.length === 0) return
    await this.#db.from('corrections').upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
  }
}
