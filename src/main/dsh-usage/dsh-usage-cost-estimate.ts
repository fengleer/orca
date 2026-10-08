import { getDshModelPricing, isPeakPricingAt } from './dsh-model-pricing'

/** Token counts to price, already split into DeepSeek's two input buckets. */
export type DshBillableTokens = {
  /** Uncached prompt tokens (`data.usage.inputTokens`). */
  cacheMissTokens: number
  /** Cached prompt tokens (`data.usage.cacheReadTokens`). */
  cacheHitTokens: number
  /** Completion tokens (`data.usage.outputTokens`). */
  outputTokens: number
}

/** Largest value `estimateDshCostUsd` can return in one call. */
const TOKENS_PER_PRICE_UNIT = 1_000_000

function priceTokens(
  rates: { cacheHit: number; cacheMiss: number; output: number },
  tokens: DshBillableTokens
): number {
  // Why: DSH's two input buckets are already disjoint (unlike Codex, where cached
  // tokens are a subset of `input_tokens`), so each bucket is charged once.
  return (
    Math.max(tokens.cacheMissTokens, 0) * rates.cacheMiss +
    Math.max(tokens.cacheHitTokens, 0) * rates.cacheHit +
    Math.max(tokens.outputTokens, 0) * rates.output
  )
}

/**
 * Cost in USD for one request, or null when the model is not in the price table.
 *
 * `atMs` is the request timestamp: DeepSeek prices per request, so a request that
 * starts off-peak and ends inside a peak window bills entirely off-peak.
 */
export function estimateDshCostUsd(
  model: string | null,
  tokens: DshBillableTokens,
  atMs: number,
  holidayKeys?: ReadonlySet<string>
): number | null {
  const pricing = getDshModelPricing(model)
  if (!pricing) {
    return null
  }
  const rates = isPeakPricingAt(atMs, holidayKeys) ? pricing.peak : pricing.offPeak
  return priceTokens(rates, tokens) / TOKENS_PER_PRICE_UNIT
}
