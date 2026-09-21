import type { AppClient } from './client.ts'
import type { CheckIn } from '../companion/now.ts'
import type { Trip } from '../domain/types.ts'

export interface SavedTrip {
  id: string
  title: string
  departsOn?: string
  source: 'paste' | 'wanderlog'
  sourceKey?: string
  updatedAt: string
  graph: Trip
}

interface TripRow {
  id: string
  title: string
  departs_on: string | null
  source: 'paste' | 'wanderlog'
  source_key: string | null
  updated_at: string
  graph: Trip
}

function toSaved(row: TripRow): SavedTrip {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    updatedAt: row.updated_at,
    graph: row.graph,
    ...(row.departs_on ? { departsOn: row.departs_on } : {}),
    ...(row.source_key ? { sourceKey: row.source_key } : {}),
  }
}

export class TripRepository {
  readonly #db: AppClient
  readonly #userId: string

  constructor(db: AppClient, userId: string) {
    this.#db = db
    this.#userId = userId
  }

  async list(): Promise<SavedTrip[]> {
    const { data, error } = await this.#db
      .from('trips')
      .select('id, title, departs_on, source, source_key, updated_at, graph')
      .order('updated_at', { ascending: false })
    if (error || !data) return []
    return (data as TripRow[]).map(toSaved)
  }

  async save(trip: Trip, source: 'paste' | 'wanderlog' = 'paste', sourceKey?: string): Promise<string | null> {
    const row = {
      owner: this.#userId,
      title: trip.title,
      departs_on: trip.departsOn ?? null,
      graph: trip,
      source,
      source_key: sourceKey ?? null,
    }
    // A Wanderlog trip re-synced updates in place rather than piling up copies,
    // which is what the (owner, source, source_key) unique index is for.
    const query =
      sourceKey !== undefined
        ? this.#db.from('trips').upsert(row, { onConflict: 'owner,source,source_key' })
        : this.#db.from('trips').insert(row)

    const { data, error } = await query.select('id').single()
    if (error || !data) return null
    return (data as { id: string }).id
  }

  async checkIns(tripId: string): Promise<CheckIn[]> {
    const { data, error } = await this.#db
      .from('check_ins')
      .select('place_id, at')
      .eq('trip_id', tripId)
      .order('at', { ascending: true })
    if (error || !data) return []
    return (data as Array<{ place_id: string; at: string }>).map((r) => ({
      placeId: r.place_id,
      at: r.at,
    }))
  }

  async recordCheckIn(tripId: string, placeId: string, at: string): Promise<void> {
    await this.#db
      .from('check_ins')
      .upsert({ trip_id: tripId, place_id: placeId, at, source: 'manual' }, {
        onConflict: 'trip_id,place_id',
        ignoreDuplicates: true,
      })
  }

  async removeCheckIn(tripId: string, placeId: string): Promise<void> {
    await this.#db.from('check_ins').delete().eq('trip_id', tripId).eq('place_id', placeId)
  }
}
