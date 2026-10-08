import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DeepSeekDailySpend } from '../../../../shared/deepseek-balance'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { MonetaryBalanceDetails } from './MonetaryBalanceDetails'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

const spend: DeepSeekDailySpend = {
  dayKey: '2026-10-08',
  requests: 319,
  cacheHitTokens: 24_495_744,
  cacheMissTokens: 433_412,
  outputTokens: 284_185,
  costUsd: 0.33,
  budgetUsd: 2,
  usedPercent: 16.5,
  resetsAt: Date.parse('2026-10-09T00:00:00Z')
}

function snapshot(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    balance: {
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '75.75',
          granted_balance: '0.00',
          topped_up_balance: '75.75'
        }
      ]
    },
    dailySpend: spend,
    updatedAt: Date.parse('2026-10-08T06:00:00Z'),
    error: null,
    status: 'ok',
    ...overrides
  }
}

function render(p: ProviderRateLimits): string {
  // Why decode: react-dom escapes apostrophes in the static markup, which would hide the copy.
  return renderToStaticMarkup(<MonetaryBalanceDetails p={p} />).replaceAll('&#x27;', "'")
}

describe('MonetaryBalanceDetails', () => {
  it('shows the prepaid balance rows and the spend breakdown together', () => {
    const html = render(snapshot())
    expect(html).toContain('Balance')
    expect(html).toContain('CNY 75.75')
    expect(html).toContain('Granted')
    expect(html).toContain('Topped up')
    expect(html).toContain("Today's cost")
    expect(html).toContain('Requests')
    expect(html).toContain('319')
    expect(html).toContain('Cache miss tokens')
    expect(html).toContain('433,412')
    expect(html).toContain('Cache hit tokens')
    expect(html).toContain('24,495,744')
    expect(html).toContain('Output tokens')
    expect(html).toContain('284,185')
    expect(html).toContain('Daily budget')
    expect(html).toContain('(17%)')
    expect(html).toContain('Computed from local DSH session logs')
  })

  it('omits the budget row when no budget is configured', () => {
    const html = render(
      snapshot({ dailySpend: { ...spend, budgetUsd: null, usedPercent: null } })
    )
    expect(html).not.toContain('Daily budget')
    expect(html).toContain("Today's cost")
  })

  it('still reports today\u2019s spend when the balance request failed', () => {
    const html = render(snapshot({ balance: null, status: 'error', error: 'network' }))
    expect(html).toContain("Today's cost")
    // No balance to fall back on, so the failure itself has to be visible.
    expect(html).toContain('network')
  })

  it('reports no spend rows when nothing could be measured', () => {
    const withBalance = render(snapshot({ dailySpend: null }))
    expect(withBalance).not.toContain("Today's cost")
    expect(withBalance).toContain('CNY 75.75')

    // Nothing at all to show: the pending copy is the only honest line.
    const withNothing = render(snapshot({ balance: null, dailySpend: null, status: 'idle' }))
    expect(withNothing).not.toContain("Today's cost")
    expect(withNothing).toContain('Balance unavailable')
  })
})
