/**
 * Self-test 4 — cost math (ported from the DSH usage suite's `cost-math.test.ts`).
 *
 * Part one pins the price table with hand-computed fixtures (exact to 1e-9) for
 * flash and v4-pro, peak and off-peak. Part two builds a real multi-frame log on
 * disk, so the same arithmetic is exercised end to end through the scanner.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { makeTempDir, removeTempDir, zstdFrameCompress } from './dsh-usage-test-fixtures'
import {
  DSH_MODEL_PRICING,
  getDshModelPricing,
  normalizeDshModelForPricing
} from './dsh-model-pricing'
import { estimateDshCostUsd } from './dsh-usage-cost-estimate'
import { createDshUsageScanner } from './scanner'

const USD_TOLERANCE = 1e-9

// Monday 2026-10-05: 02:00 UTC is peak, 05:00 UTC is off-peak.
const PEAK_MS = Date.UTC(2026, 9, 5, 2, 0, 0)
const OFF_PEAK_MS = Date.UTC(2026, 9, 5, 5, 0, 0)

it('price table matches the published DeepSeek rates', () => {
  expect(DSH_MODEL_PRICING['deepseek-flash']).toEqual({
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
  })
  expect(DSH_MODEL_PRICING['deepseek-v4-pro']).toEqual({
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
  })
})

it('one million tokens of each bucket prices exactly', () => {
  const million = { cacheMissTokens: 1_000_000, cacheHitTokens: 1_000_000, outputTokens: 1_000_000 }
  const cases: [string, number, number][] = [
    ['deepseek-flash', PEAK_MS, 0.3 + 0.006 + 1.2],
    ['deepseek-flash', OFF_PEAK_MS, 0.15 + 0.003 + 0.6],
    ['deepseek-v4-pro', PEAK_MS, 1.32 + 0.044 + 3.96],
    ['deepseek-v4-pro', OFF_PEAK_MS, 0.66 + 0.022 + 1.98]
  ]
  for (const [model, atMs, expected] of cases) {
    const actual = estimateDshCostUsd(model, million, atMs)
    expect(actual, `${model} @ ${new Date(atMs).toISOString()} should be priced`).not.toBeNull()
    expect(
      Math.abs(Number(actual) - expected) < USD_TOLERANCE,
      `${model} @ ${new Date(atMs).toISOString()}: expected ${expected}, got ${actual}`
    ).toBe(true)
  }
})

it('a small mixed fixture prices exactly', () => {
  // flash, off-peak: 1234 * 0.15 + 56789 * 0.003 + 4321 * 0.6, per 1M tokens.
  const flashOffPeak = estimateDshCostUsd(
    'deepseek-flash',
    { cacheMissTokens: 1234, cacheHitTokens: 56789, outputTokens: 4321 },
    OFF_PEAK_MS
  )
  expect(flashOffPeak).not.toBeNull()
  expect(Math.abs(Number(flashOffPeak) - 0.002948067) < USD_TOLERANCE, `got ${flashOffPeak}`).toBe(
    true
  )

  // v4-pro, peak: 7 * 1.32 + 11 * 0.044 + 13 * 3.96, per 1M tokens.
  const v4ProPeak = estimateDshCostUsd(
    'deepseek-v4-pro',
    { cacheMissTokens: 7, cacheHitTokens: 11, outputTokens: 13 },
    PEAK_MS
  )
  expect(v4ProPeak).not.toBeNull()
  expect(Math.abs(Number(v4ProPeak) - 0.000061204) < USD_TOLERANCE, `got ${v4ProPeak}`).toBe(true)

  // The peak multiplier is exactly 2x for every published rate.
  const offPeak = estimateDshCostUsd(
    'deepseek-v4-pro',
    { cacheMissTokens: 7, cacheHitTokens: 11, outputTokens: 13 },
    OFF_PEAK_MS
  )
  expect(offPeak).not.toBeNull()
  expect(Math.abs(Number(v4ProPeak) - Number(offPeak) * 2) < USD_TOLERANCE).toBe(true)
})

it('unknown models price to null and stay out of the totals', () => {
  expect(
    estimateDshCostUsd(
      'deepseek-nope',
      { cacheMissTokens: 1, cacheHitTokens: 1, outputTokens: 1 },
      PEAK_MS
    )
  ).toBeNull()
  expect(
    estimateDshCostUsd(null, { cacheMissTokens: 1, cacheHitTokens: 1, outputTokens: 1 }, PEAK_MS)
  ).toBeNull()
  expect(getDshModelPricing('deepseek-nope')).toBeNull()
})

it('model id normalization accepts prefixes and suffixes', () => {
  expect(normalizeDshModelForPricing('deepseek-flash')).toBe('deepseek-flash')
  expect(normalizeDshModelForPricing('  DeepSeek-Flash ')).toBe('deepseek-flash')
  expect(normalizeDshModelForPricing('deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro')
  expect(normalizeDshModelForPricing('deepseek-flash(thinking)')).toBe('deepseek-flash')
  expect(normalizeDshModelForPricing('deepseek-flash-128k')).toBe('deepseek-flash')
  expect(normalizeDshModelForPricing('')).toBeNull()
  expect(normalizeDshModelForPricing(null)).toBeNull()
})

it('a hand-built multi-frame log scans to the hand-computed cost', async () => {
  const tempRoot = await makeTempDir('synthetic-')
  try {
    const sessionDir = join(
      tempRoot,
      '--Users-fengle-synthetic--',
      'aaaa1111-2222-3333-4444-555566667777'
    )
    await mkdir(sessionDir, { recursive: true })
    const record = (
      time: number,
      model: string,
      inputTokens: number,
      cacheReadTokens: number,
      outputTokens: number,
      cacheWriteTokens = 0
    ): string =>
      JSON.stringify({
        type: 'assistant/message',
        time,
        data: {
          usage: { inputTokens, cacheReadTokens, outputTokens, cacheWriteTokens },
          message: { source: { provider: 'deepseek', model } }
        }
      })

    const lines = [
      // flash @ peak: 1000 * 0.3 + 2000 * 0.006 + 3000 * 1.2 per 1M = 0.003912
      record(PEAK_MS, 'deepseek-flash', 1000, 2000, 3000),
      // flash @ off-peak: 10 * 0.15 + 20 * 0.003 + 30 * 0.6 per 1M = 0.00001956
      record(OFF_PEAK_MS, 'deepseek-flash', 10, 20, 30),
      // v4-pro @ peak: 5 * 1.32 + 6 * 0.044 + 7 * 3.96 per 1M = 0.000034584
      record(Date.UTC(2026, 9, 5, 7, 0, 0), 'deepseek-v4-pro', 5, 6, 7),
      // unknown model @ off-peak (05:30 UTC): tokens counted, cost 0, cacheWrite surfaced.
      record(Date.UTC(2026, 9, 5, 5, 30, 0), 'deepseek-mystery', 1, 2, 3, 999)
    ]
    // Two frames, so this fixture also proves the concatenated-frame path works.
    const filePath = join(sessionDir, 'session.v4.jsonl.zstd')
    await writeFile(
      filePath,
      Buffer.concat([
        zstdFrameCompress(`${lines.slice(0, 2).join('\n')}\n`),
        zstdFrameCompress(`${lines.slice(2).join('\n')}\n`)
      ])
    )

    const scanner = createDshUsageScanner({ sessionsRoot: tempRoot })
    const snapshot = await scanner.scanDay('2026-10-05')

    const expectedCost = 0.003912 + 0.00001956 + 0.000034584
    expect(
      Math.abs(snapshot.costUsd - expectedCost) < USD_TOLERANCE,
      `expected ${expectedCost}, got ${snapshot.costUsd}`
    ).toBe(true)
    expect(snapshot.requests).toBe(4)
    expect(snapshot.scan.files).toBe(1)
    expect(snapshot.scan.decodedFrames, 'the fixture should be a two-frame file').toBe(2)
    expect(snapshot.scan.unpricedRequests).toBe(1)
    expect(snapshot.tokens).toEqual({
      cacheMiss: 1016,
      cacheHit: 2028,
      output: 3040,
      cacheWrite: 999
    })
    expect(snapshot.byModel['deepseek-flash'].requests).toBe(2)
    expect(
      Math.abs(snapshot.byModel['deepseek-flash'].costUsd - (0.003912 + 0.00001956)) <
        USD_TOLERANCE
    ).toBe(true)
    expect(snapshot.byModel['deepseek-v4-pro'].requests).toBe(1)
    expect(snapshot.byModel['deepseek-mystery'].costUsd).toBe(0)
    // 2 requests land in the 01:00–04:00 UTC window, 2 outside it.
    expect(snapshot.scan.peakRequests).toBe(2)
    expect(snapshot.scan.offPeakRequests).toBe(2)
  } finally {
    await removeTempDir(tempRoot)
  }
})
