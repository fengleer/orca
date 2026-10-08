import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeepSeekDailySpendReader,
  resolveDeepSeekDailyBudgetUsd,
  toDeepSeekDailySpend
} from './deepseek-daily-spend'

const TOKENS_PER_BUCKET = 10_000_000
const REQUESTS = 3
const FLASH_RATES = {
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
}

/** A second implementation of the peak rule on purpose: a shared bug must not cancel out. */
function isPeakPricing(ms: number): boolean {
  const at = new Date(ms)
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5
  const hour = at.getUTCHours()
  return weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}

function expectedCostUsd(ms: number): number {
  const rates = isPeakPricing(ms) ? FLASH_RATES.peak : FLASH_RATES.offPeak
  const millions = TOKENS_PER_BUCKET / 1_000_000
  return millions * (rates.cacheHit + rates.cacheMiss + rates.output) * REQUESTS
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function buildLedger(options: { atMs: number; frames: number }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-dsh-ledger-'))
  dirs.push(root)
  const sessionDir = path.join(root, '--project--', 'session-1')
  mkdirSync(sessionDir, { recursive: true })
  const record = JSON.stringify({
    type: 'assistant/message',
    time: options.atMs,
    data: {
      usage: {
        inputTokens: TOKENS_PER_BUCKET,
        cacheReadTokens: TOKENS_PER_BUCKET,
        outputTokens: TOKENS_PER_BUCKET,
        cacheWriteTokens: 0
      },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } }
    }
  })
  const frame = zstdCompressSync(Buffer.from(`${record}\n`, 'utf8'))
  writeFileSync(
    path.join(sessionDir, 'session.v4.jsonl.zstd'),
    Buffer.concat(Array.from({ length: options.frames }, () => frame))
  )
  return root
}

describe('resolveDeepSeekDailyBudgetUsd', () => {
  it('parses a positive budget and rejects everything else', () => {
    expect(resolveDeepSeekDailyBudgetUsd({ DEEPSEEK_DAILY_BUDGET_USD: '2.5' })).toBe(2.5)
    expect(resolveDeepSeekDailyBudgetUsd({ DEEPSEEK_DAILY_BUDGET_USD: '0' })).toBeNull()
    expect(resolveDeepSeekDailyBudgetUsd({ DEEPSEEK_DAILY_BUDGET_USD: '-1' })).toBeNull()
    expect(resolveDeepSeekDailyBudgetUsd({ DEEPSEEK_DAILY_BUDGET_USD: 'lots' })).toBeNull()
    expect(resolveDeepSeekDailyBudgetUsd({})).toBeNull()
  })
})

describe('toDeepSeekDailySpend', () => {
  const snapshot = {
    day: '2026-10-08',
    requests: 7,
    tokens: { cacheHit: 300, cacheMiss: 200, output: 100, cacheWrite: 0 },
    costUsd: 0.5
  }

  it('carries the day, tokens and cost through unchanged', () => {
    const spend = toDeepSeekDailySpend(snapshot, { budgetUsd: null, nowMs: Date.now() })
    expect(spend).toMatchObject({
      dayKey: '2026-10-08',
      requests: 7,
      cacheHitTokens: 300,
      cacheMissTokens: 200,
      outputTokens: 100,
      costUsd: 0.5,
      budgetUsd: null,
      usedPercent: null
    })
  })

  it('derives the budget percentage only when a budget is configured', () => {
    const nowMs = Date.now()
    expect(toDeepSeekDailySpend(snapshot, { budgetUsd: 2, nowMs }).usedPercent).toBe(25)
    expect(toDeepSeekDailySpend(snapshot, { budgetUsd: null, nowMs }).usedPercent).toBeNull()
  })

  it('resets at the next local midnight', () => {
    const nowMs = Date.now()
    const { resetsAt } = toDeepSeekDailySpend(snapshot, { budgetUsd: null, nowMs })
    expect(resetsAt).toBeGreaterThan(nowMs)
    expect(resetsAt - nowMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    expect(new Date(resetsAt).getHours()).toBe(0)
  })
})

describe('DeepSeekDailySpendReader', () => {
  it('counts every zstd frame, not just the first', async () => {
    const nowMs = Date.now()
    const root = buildLedger({ atMs: nowMs, frames: REQUESTS })
    const spend = await new DeepSeekDailySpendReader({ sessionsRoot: root, budgetUsd: null }).read(
      nowMs
    )
    expect(spend).not.toBeNull()
    expect(spend?.requests).toBe(REQUESTS)
    expect(spend?.cacheMissTokens).toBe(TOKENS_PER_BUCKET * REQUESTS)
    expect(spend?.costUsd).toBeCloseTo(expectedCostUsd(nowMs), 9)
  })

  it('reports null instead of throwing when the root is missing', async () => {
    const spend = await new DeepSeekDailySpendReader({
      sessionsRoot: path.join(tmpdir(), 'orca-dsh-missing-root'),
      budgetUsd: null
    }).read()
    // Nothing measured on this machine is not the same as "spent nothing".
    expect(spend).toBeNull()
  })

  it('reports zero spend for a day with no requests when a ledger exists', async () => {
    const root = buildLedger({ atMs: Date.now() - 3 * 24 * 60 * 60 * 1000, frames: 1 })
    const spend = await new DeepSeekDailySpendReader({ sessionsRoot: root, budgetUsd: null }).read()
    expect(spend).toMatchObject({ requests: 0, costUsd: 0, cacheMissTokens: 0 })
  })
})
