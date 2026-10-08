import { z } from 'zod'

const Amount = z
  .string()
  .max(128)
  .regex(/^-?\d+(?:\.\d+)?$/)
const BalanceRow = z.object({
  currency: z.enum(['CNY', 'USD']),
  total_balance: Amount,
  granted_balance: Amount,
  topped_up_balance: Amount
})

export const DeepSeekBalanceResponse = z
  .object({ is_available: z.boolean(), balance_infos: z.array(BalanceRow).max(2) })
  .refine((value) => !value.is_available || value.balance_infos.length > 0)
  .refine(
    (value) =>
      new Set(value.balance_infos.map((row) => row.currency)).size === value.balance_infos.length
  )

export type DeepSeekBalance = z.infer<typeof DeepSeekBalanceResponse>

/**
 * Today's DeepSeek spend, derived locally from the DSH session ledger. DeepSeek has no
 * billing API, so the harness's own per-request usage records are the only honest source.
 */
export type DeepSeekDailySpend = {
  /** Local day the numbers cover, 'YYYY-MM-DD'. */
  dayKey: string
  requests: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  costUsd: number
  /** Operator-set daily budget in USD; null when unset, which suppresses the percentage. */
  budgetUsd: number | null
  usedPercent: number | null
  /** Next local midnight, unix ms. */
  resetsAt: number
}

/**
 * Why this module owns the formatter: `shared/currency-format.ts` landed on main after the base
 * this stack builds on, and the spend rows have to render on both. DeepSeek bills in USD here,
 * so a fixed two-decimal dollar string is the whole requirement.
 */
export function formatDeepSeekUsd(amount: number): string {
  return `$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`
}

export type DeepSeekAccountStatus = {
  supported: boolean
  configured: boolean
  ownerId: string | null
  protection: 'sealed' | null
}

export const DEEPSEEK_BALANCE_CAPABILITY = 'accounts.deepseek-balance.v1' as const

export function unsupportedDeepSeekAccount(): DeepSeekAccountStatus {
  return { supported: false, configured: false, ownerId: null, protection: null }
}

export function formatDeepSeekBalance(balance: DeepSeekBalance): string {
  return balance.balance_infos.map((row) => `${row.currency} ${row.total_balance}`).join(' · ')
}
