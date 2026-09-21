import type { TransportMode } from '../domain/types.ts'

export interface ParsedPlace {
  type: 'place'
  name: string
  /** Local clock time as written, normalised to HH:MM. */
  time?: string
}

export interface ParsedTransport {
  type: 'transport'
  mode: TransportMode
  note: string
  durationMinutes?: number
}

export type ParsedEntry = ParsedPlace | ParsedTransport

export interface ParsedDay {
  index: number
  label?: string
  entries: ParsedEntry[]
}

export interface ParsedItinerary {
  title?: string
  days: ParsedDay[]
}

const DAY_HEADER = /^(?:day\s*(\d+)\b|d(\d+)\b)\s*[:.–—-]*\s*(.*)$/i
const DATE_HEADER =
  /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*,?\s+.*$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b.*$/i
const LIST_PREFIX = /^\s*(?:[-*•‣◦⁃]|\d{1,2}[.)])\s+/
const TIME_PREFIX =
  /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–—:|]|\s)\s*(?=\S)/i
const TRAILING_NOISE =
  /\s*(?:[·|•]\s*)?(?:\d[\d.,]*\s*(?:★|stars?|\/5).*|\(\s*[\d,]+\s*(?:reviews?)?\s*\)\s*.*|•\s*\$+.*)$/i
const URL = /https?:\/\/\S+/gi
const DURATION = /(\d{1,3})\s*(?:min|mins|minutes)\b|(\d{1,2})\s*(?:hr|hrs|hours?)\b/i

const MODE_WORDS: Array<[RegExp, TransportMode]> = [
  [/\b(?:walk|walking|on foot|stroll)\b/i, 'walk'],
  [/\b(?:metro|subway|underground|tube|u-bahn|mrt)\b/i, 'metro'],
  [/\b(?:train|rail|jr\b|shinkansen|amtrak|eurostar|s-bahn)\b/i, 'rail'],
  [/\b(?:bus|coach)\b/i, 'bus'],
  [/\b(?:ferry|boat|vaporetto)\b/i, 'ferry'],
  [/\b(?:flight|fly|plane|airport transfer)\b/i, 'flight'],
  [/\b(?:taxi|cab|uber|lyft|grab|rideshare)\b/i, 'taxi'],
  [/\b(?:drive|driving|car|rental car)\b/i, 'drive'],
  [/\b(?:transit|public transport)\b/i, 'transit'],
  // Lowest priority: "take the <name> Line" is transit, but the parser cannot
  // tell rail from metro out of a line name, so it does not pretend to.
  [/\bline\b/i, 'transit'],
]

const SKIP_LINES =
  /^(?:add (?:a )?place|add to trip|notes?|itinerary|overview|reservations?|budget|checklist|todo|expenses?|\d+\s*(?:places?|stops?)|show more|see all|untitled)\b/i

function stripNoise(line: string): string {
  return line
    .replace(URL, '')
    .replace(TRAILING_NOISE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function detectMode(text: string): TransportMode | undefined {
  for (const [re, mode] of MODE_WORDS) if (re.test(text)) return mode
  return undefined
}

function parseDuration(text: string): number | undefined {
  const m = DURATION.exec(text)
  if (!m) return undefined
  if (m[1]) return Number(m[1])
  if (m[2]) return Number(m[2]) * 60
  return undefined
}

function normaliseTime(hour: string, minute: string | undefined, meridiem: string | undefined): string {
  let h = Number(hour)
  const mm = minute ?? '00'
  if (meridiem) {
    const lower = meridiem.toLowerCase()
    if (lower === 'pm' && h < 12) h += 12
    if (lower === 'am' && h === 12) h = 0
  }
  return `${String(h).padStart(2, '0')}:${mm}`
}

/**
 * A transport line describes how you get somewhere; a place line is somewhere
 * you go. The difference matters because transport lines suppress routing —
 * the traveller already said how they are travelling.
 */
function classify(text: string): ParsedEntry | null {
  const mode = detectMode(text)
  const looksLikeTransport =
    mode !== undefined &&
    /^(?:walk|take|catch|ride|board|fly|drive|bus|train|metro|subway|ferry|taxi|transfer)\b/i.test(text)

  if (looksLikeTransport && mode) {
    const duration = parseDuration(text)
    return duration === undefined
      ? { type: 'transport', mode, note: text }
      : { type: 'transport', mode, note: text, durationMinutes: duration }
  }

  const timeMatch = TIME_PREFIX.exec(text)
  if (timeMatch?.[1]) {
    const rest = text.slice(timeMatch[0].length).trim()
    if (rest.length >= 2) {
      return { type: 'place', name: rest, time: normaliseTime(timeMatch[1], timeMatch[2], timeMatch[3]) }
    }
  }
  return { type: 'place', name: text }
}

export function parseItinerary(input: string): ParsedItinerary {
  const lines = input.split(/\r?\n/)
  const days: ParsedDay[] = []
  let current: ParsedDay | undefined
  let title: string | undefined
  let seenContent = false

  const ensureDay = (): ParsedDay => {
    if (!current) {
      current = { index: days.length + 1, entries: [] }
      days.push(current)
    }
    return current
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    const headerMatch = DAY_HEADER.exec(trimmed)
    if (headerMatch) {
      const n = Number(headerMatch[1] ?? headerMatch[2])
      const label = (headerMatch[3] ?? '').trim()
      current = { index: Number.isFinite(n) ? n : days.length + 1, entries: [] }
      if (label) current.label = label
      days.push(current)
      seenContent = true
      continue
    }

    if (!seenContent && DATE_HEADER.test(trimmed) && !LIST_PREFIX.test(trimmed)) {
      current = { index: days.length + 1, label: trimmed, entries: [] }
      days.push(current)
      seenContent = true
      continue
    }

    const hadPrefix = LIST_PREFIX.test(trimmed)
    const body = stripNoise(trimmed.replace(LIST_PREFIX, ''))
    if (!body) continue

    if (!hadPrefix && !seenContent && !TIME_PREFIX.test(body) && days.length === 0 && !title) {
      title = body
      continue
    }
    if (SKIP_LINES.test(body)) continue
    if (body.length < 2) continue

    const entry = classify(body)
    if (entry) {
      ensureDay().entries.push(entry)
      seenContent = true
    }
  }

  const result: ParsedItinerary = { days: days.filter((d) => d.entries.length > 0) }
  if (title) result.title = title
  return result
}

/** Flattened place names in itinerary order, which is what geocoding consumes. */
export function placeNames(parsed: ParsedItinerary): string[] {
  const names: string[] = []
  for (const day of parsed.days) {
    for (const entry of day.entries) if (entry.type === 'place') names.push(entry.name)
  }
  return names
}
