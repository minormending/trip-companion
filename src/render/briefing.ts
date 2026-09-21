import { cardsForLeg, cardsForPlace, isStale, placeById } from '../domain/graph.ts'
import {
  type Card,
  type Leg,
  type Place,
  type Source,
  type TransportMode,
  type Trip,
  TIER_PERSONALITY,
} from '../domain/types.ts'
import type { Refusal } from '../content/generate.ts'
import { guideForCard } from './guide.ts'
import { BRIEFING_CSS } from './styles.ts'

export interface RenderOptions {
  refusals?: Refusal[]
  now?: Date
  /** Adds the flag and regenerate controls. Off for the shared storybook view. */
  interactive?: boolean
  /** False strips the guide entirely, leaving the plain briefing. */
  guide?: boolean
}

const KIND_LABEL: Record<string, string> = {
  caution: 'Caution',
  how_to_pay: 'Paying',
  boarding: 'Boarding',
  orientation: 'Orientation',
  hours: 'Opening hours',
  watch_for: 'Watch for',
  phrase: 'Say it',
  history: 'Background',
  photo: 'Light and angle',
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

class Footnotes {
  #seen = new Map<string, number>()
  readonly entries: Source[] = []

  ref(source: Source): number {
    const existing = this.#seen.get(source.url)
    if (existing !== undefined) return existing
    const n = this.entries.length + 1
    this.#seen.set(source.url, n)
    this.entries.push(source)
    return n
  }
}

function renderCard(
  card: Card,
  notes: Footnotes,
  opts: RenderOptions,
  mode?: TransportMode,
  subjectName?: string,
): string {
  const tier = card.provenance.tier
  const tone = TIER_PERSONALITY[tier]
  const stale = isStale(card, opts.now)
  const parts: string[] = []

  const guide = opts.guide === false ? '' : guideForCard(tier, tone, mode)
  parts.push(
    `<div class="card-head">${guide}` +
      `<span class="card-kind">${escapeHtml(KIND_LABEL[card.kind] ?? card.kind)}</span></div>`,
  )
  // Sourced providers title their cards with the place name, which already
  // sits directly above as the stop heading. Repeating it is pure noise.
  const redundant =
    card.title === KIND_LABEL[card.kind] || (subjectName !== undefined && card.title === subjectName)
  if (card.title && !redundant) {
    parts.push(`<h3>${escapeHtml(card.title)}</h3>`)
  }
  parts.push(`<p>${escapeHtml(card.body)}</p>`)

  if (card.phrase) {
    parts.push(
      `<p lang="und"><strong>${escapeHtml(card.phrase.native)}</strong> — <em>${escapeHtml(card.phrase.respelling)}</em></p>`,
    )
  }

  // Operational claims carry their source and age in the open; colour does not
  // need it and showing it everywhere trains people to ignore it.
  if (tier === 'operational' || tier === 'safety' || stale) {
    const bits: string[] = []
    if (card.provenance.sources.length > 0) {
      const refs = card.provenance.sources.map((s) => {
        const n = notes.ref(s)
        return `<a href="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a><sup>${n}</sup>`
      })
      bits.push(refs.join(', '))
    }
    const verified = `verified ${escapeHtml(card.provenance.verifiedAt)}`
    bits.push(stale ? `<span class="stale">${verified} — may be out of date</span>` : verified)
    if (card.provenance.cached) bits.push('from the shared store')
    parts.push(`<div class="prov">${bits.join(' · ')}</div>`)
  }

  if (opts.interactive) {
    parts.push(
      `<div class="controls">` +
        `<button type="button" data-flag="${escapeHtml(card.id)}">This was wrong</button>` +
        `<button type="button" data-regen="${escapeHtml(card.id)}">Regenerate</button>` +
        `</div>`,
    )
  }

  return `<div class="card" data-tier="${tier}" data-tone="${tone}" data-card="${escapeHtml(card.id)}">${parts.join('')}</div>`
}

function renderLeg(trip: Trip, leg: Leg, notes: Footnotes, opts: RenderOptions): string {
  const bits: string[] = [`<span class="leg-mode">${escapeHtml(leg.mode)}</span>`]
  if (leg.durationMinutes !== undefined) bits.push(`${leg.durationMinutes} min`)
  if (leg.distanceMetres !== undefined) {
    bits.push(
      leg.distanceMetres >= 1000
        ? `${(leg.distanceMetres / 1000).toFixed(1)} km`
        : `${leg.distanceMetres} m`,
    )
  }
  if (leg.operator) bits.push(escapeHtml(leg.operator))
  if (leg.inferred) bits.push('<em>straight-line estimate, not routed</em>')

  const from = placeById(trip, leg.fromPlaceId)
  const to = placeById(trip, leg.toPlaceId)
  const legName = from && to ? `${from.name} to ${to.name}` : undefined
  const cards = cardsForLeg(trip, leg.id)
    .map((c) => renderCard(c, notes, opts, leg.mode, legName))
    .join('')
  return `<div class="leg">${bits.join(' · ')}</div>${cards}`
}

function renderRefusals(refusals: Refusal[], subject: string): string {
  const mine = refusals.filter((r) => r.subjectName === subject)
  if (mine.length === 0) return ''
  const items = mine
    .map(
      (r) =>
        `<strong>${escapeHtml(KIND_LABEL[r.kind] ?? r.kind)}:</strong> not confirmed — ${escapeHtml(r.reason)}. Check locally.`,
    )
    .join('<br>')
  return `<div class="gap">${items}</div>`
}

export function renderBriefing(trip: Trip, opts: RenderOptions = {}): string {
  const notes = new Footnotes()
  const refusals = opts.refusals ?? []
  const sections: string[] = []

  const byDay = new Map<number, Place[]>()
  for (const place of trip.places) {
    const day = place.dayIndex ?? 1
    const list = byDay.get(day) ?? []
    list.push(place)
    byDay.set(day, list)
  }

  const legByFrom = new Map<string, Leg>()
  for (const leg of trip.legs) legByFrom.set(leg.fromPlaceId, leg)

  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const places = byDay.get(day) ?? []
    const blocks: string[] = [`<h2>Day ${day}</h2>`]

    for (const place of places) {
      const head = place.arrive
        ? `<span class="time">${escapeHtml(place.arrive)}</span>`
        : ''
      const cards = cardsForPlace(trip, place.id)
        .map((c) => renderCard(c, notes, opts, undefined, place.name))
        .join('')
      blocks.push(
        `<div class="stop"><div class="stop-head">${head}<h3>${escapeHtml(place.name)}</h3></div>` +
          cards +
          renderRefusals(refusals, place.name) +
          `</div>`,
      )

      const leg = legByFrom.get(place.id)
      if (leg) {
        const to = placeById(trip, leg.toPlaceId)
        blocks.push(renderLeg(trip, leg, notes, opts))
        if (to) blocks.push(renderRefusals(refusals, `${place.name} to ${to.name}`))
      }
    }

    sections.push(`<section class="day">${blocks.join('')}</section>`)
  }

  const footnotes =
    notes.entries.length > 0
      ? `<div class="footnotes"><strong>Sources</strong><ol>${notes.entries
          .map((s) => `<li>${escapeHtml(s.title)} — ${escapeHtml(s.url)} (read ${escapeHtml(s.retrieved)})</li>`)
          .join('')}</ol></div>`
      : ''

  const script = opts.interactive
    ? `<script>document.addEventListener('click',function(e){var t=e.target;if(!(t instanceof HTMLElement))return;var f=t.getAttribute('data-flag');var r=t.getAttribute('data-regen');if(f){t.textContent='Flagged, thank you';t.disabled=true;fetch('/api/flag',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cardId:f})}).catch(function(){});}if(r){t.textContent='Queued';t.disabled=true;fetch('/api/regenerate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cardId:r})}).catch(function(){});}});</script>`
    : ''

  const subtitle = [
    `${trip.places.length} stops`,
    `${trip.legs.length} legs`,
    trip.departsOn ? `departs ${escapeHtml(trip.departsOn)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(trip.title)}</title>
<style>${BRIEFING_CSS}</style>
</head>
<body>
<div class="wrap">
<h1>${escapeHtml(trip.title)}</h1>
<p class="sub">${subtitle}</p>
${sections.join('')}
${footnotes}
</div>
${script}
</body>
</html>
`
}
