/**
 * DSH (DeepSeek Harness) token usage + cost, computed from local session logs.
 *
 * Public surface for Orca's main process:
 *
 *   const scanner = createDshUsageScanner()
 *   const snapshot = await scanner.scanToday()
 *   const limits = toProviderRateLimits(snapshot, { dailyBudgetUsd: 2 })
 *
 * Nothing here touches Electron or the network: the module reads
 * `~/.dsh/sessions/**\/session.v4.jsonl.zstd`, decompresses every zstd frame
 * (`zstd-multiframe.ts`), prices each request at its own peak/off-peak rate and
 * returns an immutable snapshot.
 */

export {
  createDshUsageScanner,
  localDayRange,
  toLocalDayKey
} from './scanner'

export {
  DSH_MODEL_PRICING,
  DSH_PEAK_WINDOWS_UTC,
  DSH_UNKNOWN_MODEL,
  getDshModelPricing,
  isPeakPricingAt,
  normalizeDshModelForPricing,
  toUtcDayKey
} from './dsh-model-pricing'

export { estimateDshCostUsd } from './dsh-usage-cost-estimate'
export type { DshBillableTokens } from './dsh-usage-cost-estimate'

export {
  DSH_NO_BUDGET_USED_PERCENT,
  nextLocalMidnight,
  toDailyWindow,
  toProviderRateLimits
} from './dsh-usage-rate-limits'

export {
  DSH_SESSION_LOG_FILENAME,
  listDshSessionFiles,
  resolveDshSessionsRoot
} from './session-file-discovery'

export { parseDshUsageLine, parseDshUsageLines } from './session-record-parser'
export type { DshLineParseResult, DshUsageRecord } from './session-record-parser'

export {
  decodeConcatenatedZstdFrames,
  isNodeZstdAvailable,
  readDshSessionFile,
  splitDecodedLines
} from './zstd-multiframe'
export type { DshFrameDecode, DshSessionFileRead } from './zstd-multiframe'

export type { DshModelPricing, DshTokenRates } from './dsh-model-pricing'

export type {
  DshCurrencyExtraUsage,
  DshDailyWindow,
  DshDailyWindowOptions,
  DshProviderRateLimitStatus,
  DshProviderRateLimits,
  DshProviderRateLimitsOptions,
  DshRateLimitWindow,
  DshUsageModelBreakdown,
  DshUsageScanStats,
  DshUsageScanner,
  DshUsageScannerOptions,
  DshUsageSnapshot,
  DshUsageTokens,
  DshZstdDecoder
} from './types'
