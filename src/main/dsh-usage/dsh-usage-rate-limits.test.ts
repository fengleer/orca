/**
 * Rate-limit and daily-window adapters, ported from the DSH usage suite's
 * `empty-root.test.ts`: they must degrade gracefully with no data and no budget.
 */

import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from './dsh-usage-test-fixtures'
import { toDailyWindow, toProviderRateLimits } from './dsh-usage-rate-limits'
import { createDshUsageScanner, localDayRange, toLocalDayKey } from './scanner'

it('adapters degrade gracefully with no data and no budget', async () => {
  const tempRoot = await makeTempDir('adapters-')
  try {
    const scanner = createDshUsageScanner({ sessionsRoot: join(tempRoot, 'missing') })
    const snapshot = await scanner.scanToday()
    const now = new Date(Date.UTC(2026, 9, 5, 12, 0, 0))

    const limits = toProviderRateLimits(snapshot, { now })
    expect(limits.provider).toBe('deepseek')
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
    expect(limits.monthly).toBeNull()
    expect(limits.status).toBe('unavailable')
    expect(limits.error).toBeTruthy()
    expect(limits.extraUsage?.enabled).toBe(false)
    expect(limits.extraUsage?.spent).toBe(0)
    expect(limits.extraUsage?.spendLimit).toBeNull()
    expect(limits.extraUsage?.spentPercent).toBeNull()
    expect(limits.updatedAt).toBe(now.getTime())

    const window = toDailyWindow(snapshot, { now })
    expect(window.usedPercent).toBe(0)
    expect(window.windowMinutes).toBe(1440)
    expect(window.resetDescription).toBe('今日 $0.00')
    // 2026-10-06T00:00 local is the next midnight after 2026-10-05T12:00 local.
    expect(window.resetsAt).toBe(localDayRange(toLocalDayKey(now.getTime())).toMs)
  } finally {
    await removeTempDir(tempRoot)
  }
})
