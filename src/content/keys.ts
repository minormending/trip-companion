import type { Leg, Place } from '../domain/types.ts'

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Coordinates are rounded to roughly 100m so the same landmark entered two
 * different ways collapses to one key. This is what makes the cache and the
 * correction store compound across trips instead of per-trip.
 */
export function placeKey(place: Place): string {
  const region = place.region ?? 'xx'
  const lat = place.coords.lat.toFixed(3)
  const lon = place.coords.lon.toFixed(3)
  return `place:${region}:${slug(place.name)}:${lat},${lon}`
}

export function legKey(leg: Leg, from: Place, to: Place): string {
  const operator = leg.operator ? slug(leg.operator) : 'any'
  return `leg:${leg.mode}:${operator}:${placeKey(from)}>${placeKey(to)}`
}
