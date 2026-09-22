import type { Card, Place, Source } from '../domain/types.ts'
import { bestFacadeWindow, compassName, daylight, goldenHours, solarPosition, type LightWindow } from './sun.ts'

const NOAA_SOURCE: Source = {
  url: 'https://gml.noaa.gov/grad/solcalc/calcdetails.html',
  title: 'NOAA Solar Calculator, calculation details',
  retrieved: '2026-09-20',
}

export interface LocalTime {
  text: string
  approximate: boolean
}

/**
 * Without an IANA zone the only option is estimating from longitude, which is
 * wrong by an hour or more across Spain, China and most of Argentina. The
 * estimate is still useful, so it is shown and labelled rather than hidden.
 */
export function formatLocal(at: Date, place: Place): LocalTime {
  if (place.timezone) {
    try {
      const text = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: place.timezone,
      }).format(at)
      return { text, approximate: false }
    } catch {
      /* fall through to the longitude estimate */
    }
  }
  const offsetHours = Math.round(place.coords.lon / 15)
  const shifted = new Date(at.getTime() + offsetHours * 3_600_000)
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  return { text: `${hh}:${mm}`, approximate: true }
}

function range(a: Date, b: Date, place: Place): { text: string; approximate: boolean } {
  const start = formatLocal(a, place)
  const end = formatLocal(b, place)
  return {
    text: `${start.text}–${end.text}`,
    approximate: start.approximate || end.approximate,
  }
}

function midpoint(window: { start: Date; end: Date }): number {
  return (window.start.getTime() + window.end.getTime()) / 2
}

function describeGap(minutes: number): string {
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return `${hours} hours`
}

/**
 * When the traveller is actually standing there, as an instant.
 *
 * `arrive` is a local wall-clock time with no date, which is only meaningful
 * against the place's own zone. Without a zone the longitude estimate that
 * formatLocal already falls back to is used in reverse, so the comparison
 * stays in the same frame as the times being printed.
 */
export function arrivalOn(onDate: Date, place: Place): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(place.arrive ?? '')
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined

  const midnightUtc = Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate())
  const offsetMs = zoneOffsetMs(onDate, place)
  return new Date(midnightUtc + (hours * 60 + minutes) * 60_000 - offsetMs)
}

/** The place's offset from UTC on that date, from its zone or its longitude. */
function zoneOffsetMs(at: Date, place: Place): number {
  if (place.timezone) {
    try {
      // Reading the zone's own answer avoids shipping a DST table: the
      // difference between the wall clock there and the wall clock in UTC is
      // the offset, whatever the rules that produced it.
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: place.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(at)
      const hh = Number(parts.find((p) => p.type === 'hour')?.value)
      const mm = Number(parts.find((p) => p.type === 'minute')?.value)
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        const local = hh * 60 + mm
        const utc = at.getUTCHours() * 60 + at.getUTCMinutes()
        let delta = local - utc
        // Crossing midnight either way shows up as a near-full-day jump.
        if (delta > 720) delta -= 1440
        if (delta < -720) delta += 1440
        return delta * 60_000
      }
    } catch {
      /* fall through to the longitude estimate */
    }
  }
  return Math.round(place.coords.lon / 15) * 3_600_000
}

/** The golden hour they are most likely to care about: the nearest one. */
export function nearestWindow(
  windows: LightWindow[],
  arrival: Date | undefined,
): LightWindow | undefined {
  if (windows.length === 0) return undefined
  // With no time of day recorded, the evening window is the better guess:
  // it is the one people plan around.
  if (!arrival) return windows[windows.length - 1]

  let best = windows[0] as LightWindow
  for (const window of windows) {
    const inside = arrival >= window.start && arrival <= window.end
    if (inside) return window
    if (Math.abs(arrival.getTime() - midpoint(window)) < Math.abs(arrival.getTime() - midpoint(best))) {
      best = window
    }
  }
  return best
}

/**
 * Correct by construction. No model is involved, so this card cannot be
 * wrong in the way a generated one can — only imprecise, and only about the
 * timezone, which it says.
 */
export function photoCard(place: Place, onDate: Date): Card | null {
  const day = daylight(onDate, place.coords)
  if (!day) return null

  const lines: string[] = []
  let approximate = false

  if (place.facadeBearing !== undefined) {
    const window = bestFacadeWindow(onDate, place.coords, place.facadeBearing)
    if (window) {
      const r = range(window.start, window.end, place)
      approximate ||= r.approximate
      const mid = new Date((window.start.getTime() + window.end.getTime()) / 2)
      const sun = solarPosition(mid, place.coords)
      lines.push(
        `The ${compassName(place.facadeBearing)}-facing front is lit ${r.text}; stand to the ${compassName(sun.azimuth)} with the sun behind you.`,
      )
    } else {
      lines.push(
        `The ${compassName(place.facadeBearing)}-facing front stays in shadow all day at this time of year.`,
      )
    }
  }

  const golden = goldenHours(onDate, place.coords)
  const arrival = arrivalOn(onDate, place)
  const chosen = nearestWindow(golden, arrival)

  if (chosen) {
    const r = range(chosen.start, chosen.end, place)
    approximate ||= r.approximate

    if (!arrival) {
      lines.push(`Low warm light ${r.text}.`)
    } else if (arrival >= chosen.start && arrival <= chosen.end) {
      lines.push(`Low warm light ${r.text}, which is when you arrive.`)
    } else {
      // Naming the gap is the useful part. "Low warm light 17:32-18:32" on a
      // card for a 07:45 bakery reads as advice and is not: it is nine hours
      // after they have gone.
      const minutes = Math.round(Math.abs(arrival.getTime() - midpoint(chosen)) / 60_000)
      const when = arrival < chosen.start ? 'after you arrive' : 'before you arrive'
      lines.push(`Low warm light ${r.text}, about ${describeGap(minutes)} ${when}.`)
    }
  }

  if (lines.length === 0) return null

  const dayRange = range(day.start, day.end, place)
  approximate ||= dayRange.approximate

  const body = approximate
    ? `${lines.join(' ')} Times estimated from longitude; no timezone on file for this place.`
    : lines.join(' ')

  return {
    id: `card:photo:${place.id}`,
    attachesTo: { kind: 'place', placeId: place.id },
    kind: 'photo',
    title: 'Light and angle',
    body,
    provenance: {
      tier: 'colour',
      sources: [NOAA_SOURCE],
      verifiedAt: new Date().toISOString().slice(0, 10),
      confidence: approximate ? 0.7 : 0.95,
    },
  }
}
