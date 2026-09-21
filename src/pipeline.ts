import { EntityCache } from './cache/entityCache.ts'
import { generateCards, type GenerationReport } from './content/generate.ts'
import { DeterministicProvider } from './content/providers/deterministic.ts'
import type { CardProvider } from './content/providers/types.ts'
import { staleCards } from './domain/graph.ts'
import type { Tier, Trip } from './domain/types.ts'
import { PhotonGeocoder, type Geocoder } from './geo/geocode.ts'
import { importFromText, type BuildReport } from './import/build.ts'
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
}

export async function runPipeline(
  text: string,
  deps: PipelineDeps,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const imported = await importFromText(text, deps.geocoder, {
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.departsOn ? { departsOn: opts.departsOn } : {}),
  })

  const filled = await fillLegs(imported.trip, deps.routers)

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
    reports: { build: imported.report, fill: filled.report, content: generated.report },
  }
}

/** Live dependencies: keyless geocoding and walking routes, no paid providers. */
export async function defaultDeps(opts: { cachePath?: string; contact?: string } = {}): Promise<PipelineDeps> {
  return {
    geocoder: new PhotonGeocoder(opts.contact ? { contact: opts.contact } : {}),
    routers: [new OsrmProvider(), new NullTransitProvider()],
    providers: [new DeterministicProvider()],
    cache: await EntityCache.open(opts.cachePath),
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
