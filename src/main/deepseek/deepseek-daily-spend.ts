import type { DeepSeekDailySpend } from '../../shared/deepseek-balance'
import { createDshUsageScanner, nextLocalMidnight, type DshUsageScanner } from '../dsh-usage'

/**
 * Today's DeepSeek spend, read from the DSH harness's own session logs.
 *
 * Why local: DeepSeek publishes no usage or billing API, so the prepaid balance is the
 * only remotely-readable number. Everything spent is reconstructed from the per-request
 * usage records the harness already writes, priced at each request's own peak/off-peak rate.
 */

export const DEEPSEEK_DAILY_BUDGET_ENV = 'DEEPSEEK_DAILY_BUDGET_USD'

export function resolveDeepSeekDailyBudgetUsd(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[DEEPSEEK_DAILY_BUDGET_ENV]?.trim()
  if (!raw) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function toDeepSeekDailySpend(
  snapshot: { day: string; requests: number; tokens: { cacheHit: number; cacheMiss: number; output: number }; costUsd: number },
  options: { budgetUsd: number | null; nowMs?: number }
): DeepSeekDailySpend {
  const budgetUsd = options.budgetUsd
  const nowMs = options.nowMs ?? Date.now()
  return {
    dayKey: snapshot.day,
    requests: snapshot.requests,
    cacheHitTokens: snapshot.tokens.cacheHit,
    cacheMissTokens: snapshot.tokens.cacheMiss,
    outputTokens: snapshot.tokens.output,
    costUsd: snapshot.costUsd,
    budgetUsd,
    usedPercent: budgetUsd === null ? null : (snapshot.costUsd / budgetUsd) * 100,
    resetsAt: nextLocalMidnight(nowMs)
  }
}

export class DeepSeekDailySpendReader {
  private readonly scanner: DshUsageScanner
  private readonly budgetUsd: number | null

  constructor(options: { sessionsRoot?: string; budgetUsd?: number | null } = {}) {
    this.scanner = createDshUsageScanner(
      options.sessionsRoot ? { sessionsRoot: options.sessionsRoot } : {}
    )
    this.budgetUsd = options.budgetUsd ?? resolveDeepSeekDailyBudgetUsd()
  }

  /**
   * Why it never throws: one unreadable session file must not blank out the balance the
   * same provider just fetched. A failed scan reports null and the segment falls back to
   * the balance alone.
   *
   * Why no logs means null rather than a zeroed day: with no harness ledger on this machine
   * we have measured nothing, and "$0.00 spent today" would be a claim we cannot support.
   */
  async read(nowMs: number = Date.now()): Promise<DeepSeekDailySpend | null> {
    try {
      const snapshot = await this.scanner.scanToday(new Date(nowMs))
      if (snapshot.scan.files === 0) {
        return null
      }
      return toDeepSeekDailySpend(snapshot, { budgetUsd: this.budgetUsd, nowMs })
    } catch {
      return null
    }
  }
}
