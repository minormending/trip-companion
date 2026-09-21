import type { Card, Place, Source } from '../domain/types.ts'
import { bestFacadeWindow, compassName, daylight, goldenHours, solarPosition } from './sun.ts'

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
  const evening = golden[golden.length - 1]
  if (evening && golden.length > 0) {
    const r = range(evening.start, evening.end, place)
    approximate ||= r.approximate
    lines.push(`Low warm light ${r.text}.`)
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
