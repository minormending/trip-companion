import type { Coordinates } from '../domain/types.ts'

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export interface SolarPosition {
  /** Degrees above the horizon. Negative when the sun is down. */
  elevation: number
  /** Degrees clockwise from true north. */
  azimuth: number
}

export interface LightWindow {
  start: Date
  end: Date
}

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5
}

/**
 * NOAA solar position. Accurate to well under a degree for photography
 * purposes, and entirely deterministic — this card kind never goes near a model.
 */
export function solarPosition(date: Date, coords: Coordinates): SolarPosition {
  const jd = julianDay(date)
  const t = (jd - 2451545) / 36525

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)

  const centre =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289

  const trueLong = meanLong + centre
  const omega = 125.04 - 1934.136 * t
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD)

  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD)

  const declination =
    Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD)) * DEG

  const y = Math.tan((obliq / 2) * RAD) ** 2
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLong * RAD) -
      2 * eccent * Math.sin(meanAnom * RAD) +
      4 * eccent * y * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * y * y * Math.sin(4 * meanLong * RAD) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD))

  const minutesUtc =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60
  const trueSolarMinutes = (minutesUtc + eqTime + 4 * coords.lon + 1440) % 1440
  const hourAngle = trueSolarMinutes / 4 < 0 ? trueSolarMinutes / 4 + 180 : trueSolarMinutes / 4 - 180

  const latRad = coords.lat * RAD
  const decRad = declination * RAD
  const haRad = hourAngle * RAD

  const cosZenith =
    Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad)
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) * DEG
  const elevation = 90 - zenith

  let azimuth: number
  const denom = Math.cos(latRad) * Math.sin(zenith * RAD)
  if (Math.abs(denom) > 1e-9) {
    const cosAz =
      (Math.sin(latRad) * Math.cos(zenith * RAD) - Math.sin(decRad)) / denom
    const clamped = Math.min(1, Math.max(-1, cosAz))
    azimuth = Math.acos(clamped) * DEG
    azimuth = hourAngle > 0 ? (azimuth + 180) % 360 : (540 - azimuth) % 360
  } else {
    azimuth = coords.lat > 0 ? 180 : 0
  }

  return { elevation, azimuth }
}

/** Smallest absolute difference between two compass bearings, 0..180. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return d > 180 ? 360 - d : d
}

const COMPASS = [
  'north', 'north-northeast', 'northeast', 'east-northeast',
  'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest',
] as const

export function compassName(bearing: number): string {
  const idx = Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16
  return COMPASS[idx] ?? 'north'
}

/**
 * Samples a *solar* day, not a UTC calendar day. Sampling 00:00-24:00 UTC for a
 * UTC+9 location returns that evening's golden hour followed by the next
 * morning's, so "the last window of the day" is tomorrow. Anchoring to local
 * solar midnight, which follows from longitude alone, orders them correctly
 * without needing to know the timezone.
 */
function sampleDay(date: Date, coords: Coordinates, stepMinutes: number) {
  const solarOffsetMs = (coords.lon / 15) * 3_600_000
  const start =
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0) -
    solarOffsetMs
  const out: Array<{ at: Date; pos: SolarPosition }> = []
  for (let m = 0; m <= 1440; m += stepMinutes) {
    const at = new Date(start + m * 60_000)
    out.push({ at, pos: solarPosition(at, coords) })
  }
  return out
}

function contiguousWindows(
  samples: Array<{ at: Date; pos: SolarPosition }>,
  predicate: (pos: SolarPosition) => boolean,
): LightWindow[] {
  const windows: LightWindow[] = []
  let open: Date | null = null
  let last: Date | null = null
  for (const s of samples) {
    if (predicate(s.pos)) {
      if (open === null) open = s.at
      last = s.at
    } else if (open !== null && last !== null) {
      windows.push({ start: open, end: last })
      open = null
      last = null
    }
  }
  if (open !== null && last !== null) windows.push({ start: open, end: last })
  return windows
}

/** Sun low and warm. Scanned rather than solved, so polar days degrade to empty. */
export function goldenHours(date: Date, coords: Coordinates): LightWindow[] {
  return contiguousWindows(
    sampleDay(date, coords, 5),
    (p) => p.elevation >= -4 && p.elevation <= 6,
  )
}

/** Standard refraction-corrected horizon, so times match published sunrise tables. */
const HORIZON_DEG = -0.833

export function daylight(date: Date, coords: Coordinates): LightWindow | undefined {
  const windows = contiguousWindows(
    sampleDay(date, coords, 1),
    (p) => p.elevation > HORIZON_DEG,
  )
  return windows.sort(
    (a, b) => b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime()),
  )[0]
}

/**
 * When the sun is actually on the face you want to photograph. A facade in
 * shadow is the single most common wasted trip to a landmark.
 */
export function facadeLitWindow(
  date: Date,
  coords: Coordinates,
  facadeBearing: number,
  opts: { toleranceDeg?: number; minElevation?: number } = {},
): LightWindow | undefined {
  const tolerance = opts.toleranceDeg ?? 75
  const minElevation = opts.minElevation ?? 3
  const windows = contiguousWindows(
    sampleDay(date, coords, 5),
    (p) => p.elevation >= minElevation && bearingDelta(p.azimuth, facadeBearing) <= tolerance,
  )
  return windows.sort(
    (a, b) => b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime()),
  )[0]
}

/** Intersection of "the face is lit" and "the light is good". */
export function bestFacadeWindow(
  date: Date,
  coords: Coordinates,
  facadeBearing: number,
): LightWindow | undefined {
  const lit = facadeLitWindow(date, coords, facadeBearing, { minElevation: 0 })
  if (!lit) return undefined
  for (const golden of goldenHours(date, coords)) {
    const start = Math.max(lit.start.getTime(), golden.start.getTime())
    const end = Math.min(lit.end.getTime(), golden.end.getTime())
    if (end > start) return { start: new Date(start), end: new Date(end) }
  }
  return lit
}
