/**
 * DeepSeek API price table and peak/off-peak classification.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing (USD per 1M tokens).
 * DeepSeek bills input tokens at two rates — cache hit and cache miss — and there
 * is no separate cache-write rate: the first write of a prefix is simply a miss.
 * `cacheWriteTokens` is therefore reported by the scanner but priced at 0, which
 * also keeps the module in exact parity with `research/dsh-cost-probe.mjs`.
 *
 * Known gap (out of scope, deliberately): DeepSeek discounts Chinese public
 * holidays to the off-peak rate, and the holiday calendar is not encoded here.
 * `isPeakPricingAt` accepts an optional set of holiday keys so a caller can close
 * the gap without editing this module.
 */

/** USD per 1M tokens for one pricing tier. */
export type DshTokenRates = {
  /** Cached input tokens. */
  cacheHit: number
  /** Uncached input tokens. */
  cacheMiss: number
  /** Completion tokens. */
  output: number
}

export type DshModelPricing = {
  /** Applies outside the peak windows. */
  offPeak: DshTokenRates
  /** Applies inside the peak windows (roughly double off-peak). */
  peak: DshTokenRates
}

export const DSH_MODEL_PRICING: Record<string, DshModelPricing> = {
  'deepseek-flash': {
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
  }
}

/** Model id used for records with no `data.message.source.model`. */
export const DSH_UNKNOWN_MODEL = 'unknown'

type DshPeakWindow = { startHourUtc: number; endHourUtc: number }

/**
 * Peak windows in UTC, Monday–Friday. Everything else bills off-peak.
 * 01:00–04:00 and 06:00–10:00 UTC are 09:00–12:00 and 14:00–18:00 China time.
 */
export const DSH_PEAK_WINDOWS_UTC: readonly DshPeakWindow[] = [
  { startHourUtc: 1, endHourUtc: 4 },
  { startHourUtc: 6, endHourUtc: 10 }
]

/**
 * True when `timeMs` bills at the peak rate.
 *
 * `holidayKeys` holds UTC day keys (`YYYY-MM-DD`) that DeepSeek treats as
 * off-peak regardless of the weekday; the module ships no calendar of its own.
 */
export function isPeakPricingAt(
  timeMs: number,
  holidayKeys?: ReadonlySet<string>
): boolean {
  if (!Number.isFinite(timeMs)) {
    return false
  }
  const at = new Date(timeMs)
  const weekday = at.getUTCDay()
  // Why: 0 = Sunday, 6 = Saturday; DeepSeek's peak windows are weekdays only.
  if (weekday < 1 || weekday > 5) {
    return false
  }
  if (holidayKeys && holidayKeys.has(toUtcDayKey(timeMs))) {
    return false
  }
  const hour = at.getUTCHours()
  return DSH_PEAK_WINDOWS_UTC.some(
    (window) => hour >= window.startHourUtc && hour < window.endHourUtc
  )
}

/** UTC day key (`YYYY-MM-DD`) for a timestamp. */
export function toUtcDayKey(timeMs: number): string {
  const at = new Date(timeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

export function getDshModelPricing(model: string | null): DshModelPricing | null {
  const normalized = normalizeDshModelForPricing(model)
  return normalized ? (DSH_MODEL_PRICING[normalized] ?? null) : null
}

/**
 * Map a logged model id onto a price-table key.
 *
 * Why: DSH logs the bare model id today, but provider-prefixed ids and
 * reasoning-tier suffixes show up in sibling scanners, so strip them the same way
 * `codex-model-pricing.ts` does before giving up and returning null.
 */
export function normalizeDshModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  let normalized = model.toLowerCase().trim()
  const parenthesized = normalized.match(/^(.*)\(([^()]*)\)$/)
  if (parenthesized && /^[a-z0-9 ._-]+$/.test(parenthesized[2])) {
    normalized = parenthesized[1].trim()
  }
  // Why: strip a `provider/` prefix (`deepseek/deepseek-flash`).
  const slash = normalized.lastIndexOf('/')
  if (slash !== -1) {
    normalized = normalized.slice(slash + 1)
  }
  if (DSH_MODEL_PRICING[normalized]) {
    return normalized
  }
  // Why: some clients append a context/reasoning suffix (`deepseek-flash-128k`).
  const known = Object.keys(DSH_MODEL_PRICING).find((key) => normalized.startsWith(`${key}-`))
  return known ?? null
}
