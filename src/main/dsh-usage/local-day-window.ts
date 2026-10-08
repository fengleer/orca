/** Local day key (`YYYY-MM-DD`) for a timestamp. */
export function toLocalDayKey(timeMs: number): string {
  const at = new Date(timeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Half-open local-day window `[fromMs, toMs)` for a `YYYY-MM-DD` key.
 *
 * Why the Date constructor rather than `+ 86_400_000`: a local day is 23 or 25
 * hours across a DST transition, and only the calendar constructor gets that right.
 */
export function localDayRange(dayKey: string): { fromMs: number; toMs: number } {
  const match = DAY_KEY_PATTERN.exec(dayKey)
  if (!match) {
    throw new Error(`Invalid day key "${dayKey}": expected YYYY-MM-DD`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const from = new Date(year, month - 1, day, 0, 0, 0, 0)
  const to = new Date(year, month - 1, day + 1, 0, 0, 0, 0)
  if (from.getMonth() !== month - 1 || from.getDate() !== day) {
    throw new Error(`Invalid day key "${dayKey}": not a real calendar date`)
  }
  return { fromMs: from.getTime(), toMs: to.getTime() }
}
