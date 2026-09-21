import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bearingDelta,
  bestFacadeWindow,
  compassName,
  daylight,
  facadeLitWindow,
  goldenHours,
  solarPosition,
} from '../src/content/sun.ts'

const LONDON = { lat: 51.5074, lon: -0.1278 }
const SYDNEY = { lat: -33.8688, lon: 151.2093 }

function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16)
}

test('solstice noon elevation matches the theoretical maximum', () => {
  // 90 - latitude + axial tilt
  const expected = 90 - LONDON.lat + 23.44
  const pos = solarPosition(new Date('2026-06-21T12:02:00Z'), LONDON)
  assert.ok(Math.abs(pos.elevation - expected) < 0.2, `got ${pos.elevation}, expected ~${expected}`)
})

test('northern hemisphere solar noon puts the sun due south', () => {
  const pos = solarPosition(new Date('2026-06-21T12:02:00Z'), LONDON)
  assert.ok(Math.abs(pos.azimuth - 180) < 1, `azimuth ${pos.azimuth}`)
  assert.equal(compassName(pos.azimuth), 'south')
})

test('southern hemisphere solar noon puts the sun due north', () => {
  const pos = solarPosition(new Date('2026-12-21T01:50:00Z'), SYDNEY)
  assert.ok(pos.azimuth < 10 || pos.azimuth > 350, `azimuth ${pos.azimuth}`)
  assert.ok(Math.abs(pos.elevation - (90 + SYDNEY.lat + 23.44)) < 0.3)
})

test('daylight matches published London sunrise and sunset within two minutes', () => {
  const window = daylight(new Date('2026-06-21T00:00:00Z'), LONDON)
  assert.ok(window)
  // Published for 21 June 2026: 04:43 and 21:21 BST, i.e. 03:43 and 20:21 UTC.
  const minutesFrom = (d: Date, hh: number, mm: number) =>
    Math.abs((d.getUTCHours() * 60 + d.getUTCMinutes()) - (hh * 60 + mm))
  assert.ok(minutesFrom(window.start, 3, 43) <= 2, `sunrise ${hhmm(window.start)}`)
  assert.ok(minutesFrom(window.end, 20, 21) <= 2, `sunset ${hhmm(window.end)}`)
})

test('golden hours come back in local order, morning then evening', () => {
  // A UTC-day scan of a UTC+9 location returns tonight's window and tomorrow's
  // morning, in that order. Anchoring to solar midnight is what fixes it.
  const tokyo = { lat: 35.6595, lon: 139.7004 }
  const windows = goldenHours(new Date('2026-11-03T00:00:00Z'), tokyo)
  assert.equal(windows.length, 2)
  assert.ok(windows[0]!.start < windows[1]!.start)

  const local = (d: Date) =>
    Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }).format(d))
  assert.ok(local(windows[0]!.start) < 9, 'first window is the morning')
  assert.ok(local(windows[1]!.start) > 13, 'second window is the evening')
})

test('the sun is below the horizon at local midnight', () => {
  assert.ok(solarPosition(new Date('2026-06-21T00:00:00Z'), LONDON).elevation < 0)
})

test('golden hours bracket sunrise and sunset', () => {
  const windows = goldenHours(new Date('2026-06-21T00:00:00Z'), LONDON)
  assert.equal(windows.length, 2)
  const day = daylight(new Date('2026-06-21T00:00:00Z'), LONDON)
  assert.ok(day)
  assert.ok(windows[0]!.start < day.start, 'morning window opens before sunrise')
  assert.ok(windows[1]!.end > day.end, 'evening window closes after sunset')
})

test('a west-facing facade is lit in the afternoon, not the morning', () => {
  const window = facadeLitWindow(new Date('2026-06-21T00:00:00Z'), LONDON, 270)
  assert.ok(window)
  const midday = new Date('2026-06-21T12:00:00Z')
  assert.ok(window.end > midday, 'lit window extends into the afternoon')
  assert.ok(solarPosition(window.start, LONDON).azimuth > 150, 'not lit at dawn')
})

test('an east-facing facade is lit in the morning', () => {
  const window = facadeLitWindow(new Date('2026-06-21T00:00:00Z'), LONDON, 90)
  assert.ok(window)
  assert.ok(window.start < new Date('2026-06-21T09:00:00Z'))
})

test('bearingDelta wraps around north', () => {
  assert.equal(bearingDelta(10, 350), 20)
  assert.equal(bearingDelta(350, 10), 20)
  assert.equal(bearingDelta(0, 180), 180)
})

test('compassName covers the sixteen points', () => {
  assert.equal(compassName(0), 'north')
  assert.equal(compassName(45), 'northeast')
  assert.equal(compassName(225), 'southwest')
  assert.equal(compassName(359), 'north')
})

test('best facade window falls inside the lit window', () => {
  const date = new Date('2026-06-21T00:00:00Z')
  const lit = facadeLitWindow(date, LONDON, 270, { minElevation: 0 })
  const best = bestFacadeWindow(date, LONDON, 270)
  assert.ok(lit && best)
  assert.ok(best.start >= lit.start && best.end <= lit.end)
})

test('polar night yields no daylight rather than throwing', () => {
  const longyearbyen = { lat: 78.22, lon: 15.63 }
  assert.equal(daylight(new Date('2026-12-21T00:00:00Z'), longyearbyen), undefined)
})
