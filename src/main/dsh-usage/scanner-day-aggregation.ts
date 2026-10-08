import { DSH_UNKNOWN_MODEL, isPeakPricingAt } from './dsh-model-pricing'
import { estimateDshCostUsd } from './dsh-usage-cost-estimate'
import { toLocalDayKey } from './local-day-window'
import type { DshCollectedFiles } from './scanner-file-cache'
import type { DshUsageModelBreakdown, DshUsageSnapshot, DshUsageTokens } from './types'

function emptyTokens(): DshUsageTokens {
  return { cacheMiss: 0, cacheHit: 0, output: 0, cacheWrite: 0 }
}

function emptyModelBreakdown(): DshUsageModelBreakdown {
  return { requests: 0, tokens: emptyTokens(), costUsd: 0 }
}

/** Project one file-cache pass into the snapshot for the window `[fromMs, toMs)`. */
export function aggregateDshUsageSnapshot(
  collected: DshCollectedFiles,
  fromMs: number,
  toMs: number
): DshUsageSnapshot {
  const tokens = emptyTokens()
  const byModel: Record<string, DshUsageModelBreakdown> = {}
  let requests = 0
  let costUsd = 0
  let unpricedRequests = 0
  let peakRequests = 0
  let offPeakRequests = 0
  let nonUsageLines = 0
  let unparsableLines = 0
  let truncatedFiles = 0
  let firstRecordMs: number | null = null
  let lastRecordMs: number | null = null

  for (const file of collected.cached) {
    if (file.truncated) {
      truncatedFiles++
    }
    nonUsageLines += file.nonUsageLines
    unparsableLines += file.unparsableLines
    if (file.skipped) {
      continue
    }
    for (const record of file.records) {
      if (record.timeMs < fromMs || record.timeMs >= toMs) {
        continue
      }
      const peak = isPeakPricingAt(record.timeMs)
      if (peak) {
        peakRequests++
      } else {
        offPeakRequests++
      }
      const recordTokens = {
        cacheMissTokens: record.cacheMissTokens,
        cacheHitTokens: record.cacheHitTokens,
        outputTokens: record.outputTokens
      }
      const recordCost = estimateDshCostUsd(record.model, recordTokens, record.timeMs)
      if (recordCost === null) {
        unpricedRequests++
      }
      const model = record.model || DSH_UNKNOWN_MODEL
      const breakdown = byModel[model] ?? emptyModelBreakdown()
      breakdown.requests++
      breakdown.tokens.cacheMiss += record.cacheMissTokens
      breakdown.tokens.cacheHit += record.cacheHitTokens
      breakdown.tokens.output += record.outputTokens
      breakdown.tokens.cacheWrite += record.cacheWriteTokens
      breakdown.costUsd += recordCost ?? 0
      byModel[model] = breakdown

      requests++
      tokens.cacheMiss += record.cacheMissTokens
      tokens.cacheHit += record.cacheHitTokens
      tokens.output += record.outputTokens
      tokens.cacheWrite += record.cacheWriteTokens
      costUsd += recordCost ?? 0
      firstRecordMs =
        firstRecordMs === null ? record.timeMs : Math.min(firstRecordMs, record.timeMs)
      lastRecordMs = lastRecordMs === null ? record.timeMs : Math.max(lastRecordMs, record.timeMs)
    }
  }

  // Why: decoding is what a caller wants to see go to zero on a warm cache;
  // frames of reused files were decoded by an earlier scan, not this one.
  const decodedFrames = collected.decodedFrames

  return {
    day: toLocalDayKey(fromMs),
    requests,
    tokens,
    costUsd,
    byModel: sortByModelKey(byModel),
    scan: {
      files: collected.discoveredFiles,
      bytes: collected.totalBytes,
      decodedFrames,
      reusedFromCache: collected.discoveredFiles > 0 && collected.decodedFiles === 0,
      reusedFiles: collected.reusedFiles,
      decodedFiles: collected.decodedFiles,
      skippedFiles: collected.skippedFiles,
      nonUsageLines,
      unparsableLines,
      unpricedRequests,
      peakRequests,
      offPeakRequests,
      firstRecordMs,
      lastRecordMs,
      truncatedFiles,
      decoders: collected.decoders
    }
  }
}

// Why: model keys come straight from the logs, so keep the map prototype-free and
// sort it — a snapshot must serialize identically across scans.
function sortByModelKey(
  byModel: Record<string, DshUsageModelBreakdown>
): Record<string, DshUsageModelBreakdown> {
  const sorted: Record<string, DshUsageModelBreakdown> = {}
  for (const key of Object.keys(byModel).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = byModel[key]
  }
  return sorted
}
