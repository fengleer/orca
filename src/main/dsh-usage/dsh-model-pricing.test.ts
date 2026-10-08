/**
 * Peak / off-peak classification boundaries (UTC, weekdays only).
 *
 * Ported from the DSH usage suite's `peak-boundaries.test.ts`.
 * 2026-10-05 is a Monday, 2026-10-10 a Saturday, 2026-10-11 a Sunday.
 */

import { expect, it } from 'vitest'
import { DSH_PEAK_WINDOWS_UTC, isPeakPricingAt } from './dsh-model-pricing'

const MONDAY = { year: 2026, month: 9, day: 5 }
const SATURDAY = { year: 2026, month: 9, day: 10 }
const SUNDAY = { year: 2026, month: 9, day: 11 }

function utcMs(day: { year: number; month: number; day: number }, hour: number, minute = 0): number {
  return Date.UTC(day.year, day.month, day.day, hour, minute, 0, 0)
}

it('peak windows are the documented UTC hours', () => {
  expect(DSH_PEAK_WINDOWS_UTC.map((window) => [window.startHourUtc, window.endHourUtc])).toEqual([
    [1, 4],
    [6, 10]
  ])
})

it('weekday boundaries flip exactly at the window edges', () => {
  const cases: [number, number, boolean][] = [
    [0, 59, false],
    [1, 0, true],
    [3, 59, true],
    [4, 0, false],
    [5, 59, false],
    [6, 0, true],
    [9, 59, true],
    [10, 0, false]
  ]
  for (const [hour, minute, expected] of cases) {
    const at = utcMs(MONDAY, hour, minute)
    expect(
      isPeakPricingAt(at),
      `Monday ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC should be ${expected ? 'peak' : 'off-peak'}`
    ).toBe(expected)
  }
})

it('weekends are off-peak inside the weekday windows', () => {
  for (const day of [SATURDAY, SUNDAY]) {
    for (const hour of [1, 2, 6, 7, 9]) {
      expect(isPeakPricingAt(utcMs(day, hour)), `${day.day} @ ${hour}:00 UTC`).toBe(false)
    }
  }
})

it('weekday hours outside the windows stay off-peak', () => {
  for (const hour of [0, 4, 5, 10, 12, 23]) {
    expect(isPeakPricingAt(utcMs(MONDAY, hour)), `Monday @ ${hour}:00 UTC`).toBe(false)
  }
})

it('an injected holiday calendar downgrades a peak weekday to off-peak', () => {
  const peakMonday = utcMs(MONDAY, 2)
  expect(isPeakPricingAt(peakMonday)).toBe(true)
  expect(isPeakPricingAt(peakMonday, new Set(['2026-10-05']))).toBe(false)
  // A holiday key for another day must not leak into this one.
  expect(isPeakPricingAt(peakMonday, new Set(['2026-10-06']))).toBe(true)
})

it('a non-finite timestamp classifies as off-peak instead of throwing', () => {
  expect(isPeakPricingAt(Number.NaN)).toBe(false)
  expect(isPeakPricingAt(Number.POSITIVE_INFINITY)).toBe(false)
})
