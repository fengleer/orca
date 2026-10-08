import { localDayRange, toLocalDayKey } from './local-day-window'
import { aggregateDshUsageSnapshot } from './scanner-day-aggregation'
import { createScannerFileCache } from './scanner-file-cache'
import { resolveDshSessionsRoot } from './session-file-discovery'
import type { DshUsageScanner, DshUsageScannerOptions, DshUsageSnapshot } from './types'

export { localDayRange, toLocalDayKey }

/**
 * Create the DSH usage scanner.
 *
 * Scans are incremental: each session log is decompressed once and then reused
 * until its size or mtime changes, so a status-bar refresh that runs every few
 * seconds pays only a stat per file.
 */
export function createDshUsageScanner(options: DshUsageScannerOptions = {}): DshUsageScanner {
  const sessionsRoot = resolveDshSessionsRoot(options.sessionsRoot)
  const fileCache = createScannerFileCache(sessionsRoot, options)

  async function scanRange(fromMs: number, toMs: number): Promise<DshUsageSnapshot> {
    const collected = await fileCache.collectFiles()
    return aggregateDshUsageSnapshot(collected, fromMs, toMs)
  }

  return {
    sessionsRoot,
    scanRange,
    scanDay: (dayKey: string) => {
      const { fromMs, toMs } = localDayRange(dayKey)
      return scanRange(fromMs, toMs)
    },
    scanToday: (now: Date = new Date()) => {
      const { fromMs, toMs } = localDayRange(toLocalDayKey(now.getTime()))
      return scanRange(fromMs, toMs)
    },
    clearCache: () => fileCache.clear()
  }
}
