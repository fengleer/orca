import { DSH_UNKNOWN_MODEL } from './dsh-model-pricing'

/**
 * One billable DSH request, flattened out of an `assistant/message` record.
 *
 * `unknown` is the only invented value: everything else is copied verbatim from
 * the log so a recount against `zstd -dc` matches token for token.
 */
export type DshUsageRecord = {
  /** `record.time`, epoch ms (local-day bucketing happens in the scanner). */
  timeMs: number
  /** `data.message.source.model`, or `unknown` when the record omits it. */
  model: string
  /** `data.message.source.provider`; this machine logs both `deepseek` and `deepseek-official`. */
  provider: string | null
  /** `data.usage.inputTokens` — uncached prompt tokens. */
  cacheMissTokens: number
  /** `data.usage.cacheReadTokens` — cached prompt tokens. */
  cacheHitTokens: number
  /** `data.usage.outputTokens`. */
  outputTokens: number
  /** `data.usage.cacheWriteTokens` — always 0 on this machine; priced at 0. */
  cacheWriteTokens: number
}

function toTokenCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Parse one JSONL line into a usage record.
 *
 * Returns null for every non-usage line (session headers, tool calls, hook
 * results), for a malformed/partial trailing line, and for a usage record without
 * a readable `time` — callers count the last case separately so a schema drift is
 * visible instead of silent.
 */
export function parseDshUsageLine(line: string): DshUsageRecord | null {
  if (!line) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  return toDshUsageRecord(parsed)
}

export function toDshUsageRecord(record: unknown): DshUsageRecord | null {
  if (!record || typeof record !== 'object') {
    return null
  }
  const candidate = record as {
    time?: unknown
    data?: { usage?: unknown; message?: { source?: { provider?: unknown; model?: unknown } } }
  }
  const usage = candidate.data?.usage
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const timeMs = typeof candidate.time === 'number' ? candidate.time : Number.NaN
  if (!Number.isFinite(timeMs)) {
    return null
  }
  const buckets = usage as Record<string, unknown>
  const source = candidate.data?.message?.source
  return {
    timeMs,
    model: toNonEmptyString(source?.model) ?? DSH_UNKNOWN_MODEL,
    provider: toNonEmptyString(source?.provider),
    cacheMissTokens: toTokenCount(buckets.inputTokens),
    cacheHitTokens: toTokenCount(buckets.cacheReadTokens),
    outputTokens: toTokenCount(buckets.outputTokens),
    cacheWriteTokens: toTokenCount(buckets.cacheWriteTokens)
  }
}

export type DshLineParseResult = {
  records: DshUsageRecord[]
  /**
   * Lines that are not JSON at all. Expected to be non-zero only for the trailing
   * line of a log that was appended to while being read.
   */
  unparsableLines: number
  /** Well-formed JSONL lines that carry no usage record — the normal majority. */
  nonUsageLines: number
}

/** Parse every line of one session log; blank lines are ignored, not counted. */
export function parseDshUsageLines(lines: readonly string[]): DshLineParseResult {
  const records: DshUsageRecord[] = []
  let unparsableLines = 0
  let nonUsageLines = 0
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Why: DSH appends whole lines, but a read that races the writer can still
      // catch a half-written tail; counting it beats dropping it silently.
      unparsableLines++
      continue
    }
    const record = toDshUsageRecord(parsed)
    if (record) {
      records.push(record)
    } else {
      nonUsageLines++
    }
  }
  return { records, unparsableLines, nonUsageLines }
}
