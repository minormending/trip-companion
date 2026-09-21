import { EntityCache } from './cache/entityCache.ts'
import type { CacheStore } from './cache/store.ts'
import { generateCards, type GenerationReport } from './content/generate.ts'
import { DeterministicProvider } from './content/providers/deterministic.ts'
import type { CardProvider } from './content/providers/types.ts'
import { staleCards } from './domain/graph.ts'
import type { Tier, Trip } from './domain/types.ts'
import { PhotonGeocoder, type Geocoder } from './geo/geocode.ts'
import {
  applyChoices,
  importFromText,
  type BuildReport,
  type PendingConfirmation,
  type ProgressFn,
} from './import/build.ts'
import { renderBriefing, type RenderOptions } from './render/briefing.ts'
import { fillLegs, type FillReport } from './routing/fill.ts'
import { OsrmProvider } from './routing/osrm.ts'
import { NullTransitProvider } from './routing/transit.ts'
import type { RoutingProvider } from './routing/types.ts'

export interface PipelineDeps {
  geocoder: Geocoder
  routers: RoutingProvider[]
  providers: CardProvider[]
  cache?: EntityCache
}

export interface PipelineResult {
  trip: Trip
  html: string
  reports: { build: BuildReport; fill: FillReport; content: GenerationReport }
}

export interface PipelineOptions {
  title?: string
  departsOn?: string
  now?: Date
  render?: RenderOptions
  onProgress?: ProgressFn
}

export interface ResolveResult {
  trip: Trip
  report: BuildReport
  /** Non-empty means a human should choose before anything is enriched. */
  pending: PendingConfirmation[]
}

/**
 * Stage one: parse and locate, nothing more. Stops deliberately short of
 * routing and card generation so ambiguous places can be confirmed before
 * either spends anything against the wrong coordinates.
 */
export async function resolveTrip(
  text: string,
  deps: PipelineDeps,
  opts: PipelineOptions = {},
): Promise<ResolveResult> {
  const imported = await importFromText(text, deps.geocoder, {
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.departsOn ? { departsOn: opts.departsOn } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  })
  return {
    trip: imported.trip,
    report: imported.report,
    pending: imported.report.needsConfirmation,
  }
}

/** Stage two: route the gaps, write the cards, render. */
export async function enrichTrip(
  trip: Trip,
  deps: PipelineDeps,
  build: BuildReport,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  opts.onProgress?.('Routing the gaps between stops', 0, 1)
  const filled = await fillLegs(trip, deps.routers)

  opts.onProgress?.('Writing the cards', 0, 1)
  const generated = await generateCards(filled.trip, {
    providers: deps.providers,
    ...(deps.cache ? { cache: deps.cache } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  })

  const html = renderBriefing(generated.trip, {
    refusals: generated.report.refusals,
    ...(opts.now ? { now: opts.now } : {}),
    ...opts.render,
  })

  return {
    trip: generated.trip,
    html,
    reports: { build, fill: filled.report, content: generated.report },
  }
}

/**
 * Both stages with no confirmation step, taking the geocoder's first choice.
 * Correct for the CLI and for tests; the browser splits the stages so the
 * traveller gets asked.
 */
export async function runPipeline(
  text: string,
  deps: PipelineDeps,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const resolved = await resolveTrip(text, deps, opts)
  return enrichTrip(resolved.trip, deps, resolved.report, opts)
}

export { applyChoices }

/** Live dependencies: keyless geocoding and walking routes, no paid providers. */
export async function defaultDeps(
  opts: { cacheStore?: CacheStore; contact?: string } = {},
): Promise<PipelineDeps> {
  return {
    geocoder: new PhotonGeocoder(opts.contact ? { contact: opts.contact } : {}),
    routers: [new OsrmProvider(), new NullTransitProvider()],
    providers: [new DeterministicProvider()],
    cache: await EntityCache.open(opts.cacheStore),
  }
}

/**
 * The pre-departure freshness pass. T-14 takes everything with a TTL; T-2
 * narrows to the tiers where a stale fact strands somebody, which is what
 * keeps the cost of staying fresh low.
 */
export function regenerationTargets(
  trip: Trip,
  phase: 'T-14' | 'T-2',
  now: Date = new Date(),
): ReturnType<typeof staleCards> {
  const tiers: Tier[] = phase === 'T-2' ? ['safety', 'operational'] : ['safety', 'operational', 'practical']
  return staleCards(trip, { tiers, now })
}
