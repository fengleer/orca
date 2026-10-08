/**
 * Adapters that turn a `DshUsageSnapshot` into the two shapes Orca's status bar
 * already understands: a `ProviderRateLimits` entry and a 24-hour window.
 *
 * Both functions are pure and synchronous — a scan is the only expensive part, so
 * a renderer refresh can re-derive the display from a cached snapshot.
 */

import { toLocalDayKey, localDayRange } from './scanner'
import type {
  DshCurrencyExtraUsage,
  DshDailyWindow,
  DshDailyWindowOptions,
  DshProviderRateLimits,
  DshProviderRateLimitsOptions,
  DshUsageSnapshot
} from './types'

/**
 * Sentinel `usedPercent` reported when no daily budget is configured.
 *
 * Why 0 and not 100: Orca's status-bar meters are "how much of the allowance is
 * gone", and with no allowance there is nothing to be gone. The exact spend is
 * still exposed through `extraUsage.spent` and `resetDescription`, so the caller
 * can always show "$0.12 spent today" without inventing a denominator.
 */
export const DSH_NO_BUDGET_USED_PERCENT = 0

function toSpentPercent(spentUsd: number, budgetUsd: number): number {
  return (spentUsd / budgetUsd) * 100
}

function resolveBudget(dailyBudgetUsd: number | undefined): number | null {
  return typeof dailyBudgetUsd === 'number' && Number.isFinite(dailyBudgetUsd) && dailyBudgetUsd > 0
    ? dailyBudgetUsd
    : null
}

/** Unix ms of the next local midnight after `fromMs`. */
export function nextLocalMidnight(fromMs: number): number {
  const { toMs } = localDayRange(toLocalDayKey(fromMs))
  return toMs
}

/**
 * One day of DSH spend, shaped like Orca's `ProviderRateLimits`.
 *
 * `session`, `weekly` and `monthly` stay null: DeepSeek bills per token with no
 * rolling quota windows, so only `extraUsage` carries real numbers.
 */
export function toProviderRateLimits(
  snapshot: DshUsageSnapshot,
  options: DshProviderRateLimitsOptions = {}
): DshProviderRateLimits {
  const now = options.now ?? new Date()
  const budgetUsd = resolveBudget(options.dailyBudgetUsd)
  const spentUsd = snapshot.costUsd
  const resetsAt = nextLocalMidnight(now.getTime())
  const hasLogs = snapshot.scan.files > 0

  const extraUsage: DshCurrencyExtraUsage = {
    enabled: budgetUsd !== null,
    disabledReason: budgetUsd === null ? 'No daily DeepSeek budget configured' : null,
    resetsAt,
    unit: 'currency',
    // Why: DeepSeek exposes no balance on this machine (no prepaid-balance API
    // call is made here), so balance stays null while spend is a real measurement.
    balance: null,
    currencyCode: 'USD',
    spent: spentUsd,
    spendLimit: budgetUsd,
    spentPercent: budgetUsd === null ? null : toSpentPercent(spentUsd, budgetUsd)
  }

  const error = options.error ?? (hasLogs ? null : 'No DSH session logs found')
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    monthly: null,
    extraUsage,
    updatedAt: now.getTime(),
    error,
    status: options.error ? 'error' : hasLogs ? 'ok' : 'unavailable',
    // Why: 'cli' is the honest provenance — the numbers were computed from the
    // DSH CLI's own on-disk session logs, not from an authenticated HTTP poll.
    usageMetadata: { source: 'cli' }
  }
}

/**
 * The 24-hour spend window Orca's status bar renders.
 *
 * `resetDescription` always carries the real cost text, including when
 * `usedPercent` falls back to `DSH_NO_BUDGET_USED_PERCENT`.
 */
export function toDailyWindow(
  snapshot: DshUsageSnapshot,
  options: DshDailyWindowOptions = {}
): DshDailyWindow {
  const now = options.now ?? new Date()
  const budgetUsd = resolveBudget(options.dailyBudgetUsd)
  return {
    usedPercent:
      budgetUsd === null ? DSH_NO_BUDGET_USED_PERCENT : toSpentPercent(snapshot.costUsd, budgetUsd),
    windowMinutes: 1440,
    resetsAt: nextLocalMidnight(now.getTime()),
    resetDescription: `今日 $${snapshot.costUsd.toFixed(2)}`
  }
}
