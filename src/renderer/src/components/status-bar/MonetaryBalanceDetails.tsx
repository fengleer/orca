import type { DeepSeekDailySpend } from '../../../../shared/deepseek-balance'
import { formatDeepSeekUsd } from '../../../../shared/deepseek-balance'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { getProviderUsageErrorMessage } from './usage-error-copy'

function DeepSeekSpendDetails({ spend }: { spend: DeepSeekDailySpend }): React.JSX.Element {
  const rows: { label: string; value: string }[] = [
    {
      label: translate('deepseek.spend.cost', "Today's cost"),
      value: formatDeepSeekUsd(spend.costUsd)
    },
    { label: translate('deepseek.spend.requests', 'Requests'), value: String(spend.requests) },
    {
      label: translate('deepseek.spend.cacheMiss', 'Cache miss tokens'),
      value: spend.cacheMissTokens.toLocaleString()
    },
    {
      label: translate('deepseek.spend.cacheHit', 'Cache hit tokens'),
      value: spend.cacheHitTokens.toLocaleString()
    },
    {
      label: translate('deepseek.spend.output', 'Output tokens'),
      value: spend.outputTokens.toLocaleString()
    }
  ]
  if (spend.budgetUsd !== null && spend.usedPercent !== null) {
    rows.push({
      label: translate('deepseek.spend.budget', 'Daily budget'),
      value: `${formatDeepSeekUsd(spend.costUsd)} / ${formatDeepSeekUsd(spend.budgetUsd)} (${Math.round(spend.usedPercent)}%)`
    })
  }
  return (
    <div className="space-y-1 border-t pt-2">
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={
            index === 0 ? 'flex justify-between gap-4 font-medium' : 'flex justify-between gap-4 text-muted-foreground'
          }
        >
          <span>{row.label}</span>
          <span className="tabular-nums">{row.value}</span>
        </div>
      ))}
      <p className="text-muted-foreground">
        {translate(
          'deepseek.spend.source',
          'Computed from local DSH session logs; DeepSeek has no usage API.'
        )}
      </p>
    </div>
  )
}

export function MonetaryBalanceDetails({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  return (
    <div className="space-y-2 text-xs" role="status" aria-live="polite">
      {p.balance?.balance_infos.map((row) => (
        <div key={row.currency} className="space-y-1">
          <div className="flex justify-between gap-4 font-medium">
            <span>{translate('deepseek.balance.total', 'Balance')}</span>
            <span className="tabular-nums">
              {row.currency} {row.total_balance}
            </span>
          </div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <span>{translate('deepseek.balance.granted', 'Granted')}</span>
            <span className="tabular-nums">
              {row.currency} {row.granted_balance}
            </span>
          </div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <span>{translate('deepseek.balance.toppedUp', 'Topped up')}</span>
            <span className="tabular-nums">
              {row.currency} {row.topped_up_balance}
            </span>
          </div>
        </div>
      ))}
      {p.dailySpend ? <DeepSeekSpendDetails spend={p.dailySpend} /> : null}
      {p.balance?.is_available === false ? (
        <p className="text-muted-foreground">
          {translate(
            'deepseek.balance.insufficient',
            'DeepSeek reports insufficient balance for API calls.'
          )}
        </p>
      ) : null}
      {p.status === 'error' ? (
        <p className="text-muted-foreground">
          {p.balance
            ? translate('deepseek.balance.stale', 'Refresh failed — showing the last balance.')
            : getProviderUsageErrorMessage(p)}
        </p>
      ) : !p.balance && !p.dailySpend ? (
        <p className="text-muted-foreground">
          {translate('deepseek.balance.pending', 'Balance unavailable')}
        </p>
      ) : null}
      {p.balance && p.updatedAt ? (
        <p className="text-muted-foreground">
          {translate('deepseek.balance.updated', 'Updated {{when}}', {
            when: new Date(p.updatedAt).toLocaleString()
          })}
        </p>
      ) : null}
    </div>
  )
}
