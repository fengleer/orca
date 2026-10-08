/**
 * Shared types for the DSH (DeepSeek Harness) token-usage scanner.
 *
 * Provenance: DSH appends one JSON record per line to
 * `<sessionsRoot>/<project-slug>/<session-id>/session.v4.jsonl.zstd`. Usage-bearing
 * records are `assistant/message` records carrying `time` (epoch ms) plus
 * `data.usage.{inputTokens,cacheReadTokens,outputTokens,cacheWriteTokens}` and
 * `data.message.source.{provider,model}`.
 *
 * The scanner is pure Node: it never imports Electron, so it can be unit-tested
 * with `node file.ts` and then dropped into Orca's main process unchanged.
 */

/** Token buckets as DSH reports them, renamed to Orca's cache-miss/cache-hit vocabulary. */
export type DshUsageTokens = {
  /** `data.usage.inputTokens` — prompt tokens that missed the context cache. */
  cacheMiss: number
  /** `data.usage.cacheReadTokens` — prompt tokens served from the context cache. */
  cacheHit: number
  /** `data.usage.outputTokens` — completion tokens. */
  output: number
  /** `data.usage.cacheWriteTokens` — see `dsh-model-pricing.ts`; priced at 0 for DeepSeek. */
  cacheWrite: number
}

export type DshUsageModelBreakdown = {
  requests: number
  tokens: DshUsageTokens
  costUsd: number
}

/** Which decoder produced the lines for a file. `zstd-cli` is the documented fallback. */
export type DshZstdDecoder = 'node' | 'zstd-cli'

export type DshUsageScanStats = {
  /** Session files considered by this scan (unchanged files included). */
  files: number
  /** Compressed bytes across those files. */
  bytes: number
  /** Frames decompressed during *this* scan; 0 when every file was reused from cache. */
  decodedFrames: number
  /** True when at least one file was served from the incremental cache. */
  reusedFromCache: boolean
  /** Files served from the incremental cache without touching the disk contents. */
  reusedFiles: number
  /** Files actually decompressed during this scan. */
  decodedFiles: number
  /** Files skipped because they were unreadable or exceeded `maxFileBytes`. */
  skippedFiles: number
  /** Well-formed JSONL lines that carried no usage record (the normal majority). */
  nonUsageLines: number
  /** Lines that were not JSON — a partial trailing append, or a corrupt frame tail. */
  unparsableLines: number
  /** Usage requests whose model is absent from the price table; counted, priced at 0. */
  unpricedRequests: number
  /** Usage requests priced at the peak (UTC) rate. */
  peakRequests: number
  /** Usage requests priced at the off-peak rate. */
  offPeakRequests: number
  /** Smallest/largest record timestamp inside the requested window, null when empty. */
  firstRecordMs: number | null
  lastRecordMs: number | null
  /** Files that stopped decoding early (corrupt frame or non-frame trailing bytes). */
  truncatedFiles: number
  /** Decoders that actually produced lines in this scan, sorted; empty on a fully warm cache. */
  decoders: DshZstdDecoder[]
}

export type DshUsageSnapshot = {
  /** Local day key for `scanDay`/`scanToday`; the local day containing `fromMs` for `scanRange`. */
  day: string
  requests: number
  tokens: DshUsageTokens
  costUsd: number
  byModel: Record<string, DshUsageModelBreakdown>
  scan: DshUsageScanStats
}

export type DshUsageScannerOptions = {
  /** Defaults to `$DSH_SESSIONS_ROOT`, then `$DSH_HOME/sessions`, then `~/.dsh/sessions`. */
  sessionsRoot?: string
  /**
   * `auto` (default) uses pure-Node concatenated-frame decoding when the runtime
   * exposes it and falls back to the `zstd` CLI otherwise. `node` never spawns a
   * process. `zstd-cli` always shells out to `zstd -dc`.
   */
  decoder?: DshZstdDecoder | 'auto'
  /** Absolute `zstd` path for the CLI decoder; defaults to `$DSH_ZSTD_PATH` then `zstd`. */
  zstdPath?: string
  /** Skip compressed files larger than this (default 256 MiB) instead of risking main-process OOM. */
  maxFileBytes?: number
  /** Cap on memoized files (default 512); the least recently decoded files evict first. */
  maxCachedFiles?: number
}

export type DshUsageScanner = {
  scanDay: (dayKey: string) => Promise<DshUsageSnapshot>
  scanToday: (now?: Date) => Promise<DshUsageSnapshot>
  scanRange: (fromMs: number, toMs: number) => Promise<DshUsageSnapshot>
  /** Drop every memoized file projection; the next scan re-reads from disk. */
  clearCache: () => void
  /** Resolved sessions root, for diagnostics and for the settings UI. */
  sessionsRoot: string
}

/**
 * Structural mirror of Orca's `ProviderRateLimits` (`src/shared/rate-limit-types.ts`)
 * narrowed to the fields a local-session scanner can honestly fill.
 *
 * Why a local copy: this module must compile with only node builtins. When it lands
 * in the fork, `provider: 'deepseek'` additionally requires widening the
 * `ProviderRateLimits['provider']` union — see README "Integration into Orca".
 */
export type DshProviderRateLimits = {
  provider: 'deepseek'
  session: DshRateLimitWindow | null
  weekly: DshRateLimitWindow | null
  monthly: DshRateLimitWindow | null
  extraUsage: DshCurrencyExtraUsage | null
  updatedAt: number
  error: string | null
  status: DshProviderRateLimitStatus
  usageMetadata?: DshUsageRateLimitMetadata
}

export type DshProviderRateLimitStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'

export type DshRateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number
  /** Window duration in minutes. */
  windowMinutes: number
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null
  /** Human-readable reset description. */
  resetDescription: string | null
}

export type DshCurrencyExtraUsage = {
  enabled: boolean
  disabledReason: string | null
  resetsAt: number | null
  unit: 'currency'
  balance: number | null
  currencyCode: string
  spent: number | null
  spendLimit: number | null
  spentPercent: number | null
}

export type DshUsageRateLimitMetadata = {
  source?: 'oauth' | 'cli' | 'web' | 'live-session'
  failureKind?: string
}

export type DshDailyWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number
  resetDescription: string
}

export type DshProviderRateLimitsOptions = {
  /** Daily spend ceiling in USD. `0`/absent means "no budget configured". */
  dailyBudgetUsd?: number
  now?: Date
  /** Set when the scan itself failed; surfaces as `status: 'error'`. */
  error?: string | null
}

export type DshDailyWindowOptions = {
  dailyBudgetUsd?: number
  now?: Date
}
