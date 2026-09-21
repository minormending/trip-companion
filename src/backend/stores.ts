import type { AppClient } from './client.ts'
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
  readonly #db: AppClient

  constructor(db: AppClient) {
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
  readonly #db: AppClient

  constructor(db: AppClient) {
    this.#db = db
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
   * Reports go through report_card(), not a table insert: there is no insert
   * grant on corrections at all. The function rate limits per account and per
   * address, refuses suspended accounts, and collapses a repeat report from the
   * same person on the same card — without which one account reporting twice
   * reaches the two-report suppression threshold on its own.
   *
   * Resolution is a moderator action through accept_correction(), so a
   * traveller cannot accept their own report.
   */
  async save(snapshot: CorrectionSnapshot): Promise<void> {
    for (const correction of Object.values(snapshot)) {
      if (correction.status !== 'open') continue
      const { error } = await this.#db.rpc('report_card', {
        p_id: correction.id,
        p_entity_key: correction.entityKey,
        p_card_kind: correction.cardKind,
        p_claim: correction.claim,
        p_saw_body: correction.sawBody,
      })
      // A rejected report is the rate limiter or a suspension doing its job.
      // It must not take the rest of the batch down with it.
      if (error) console.warn(`report not accepted: ${error.message}`)
    }
  }
}
