import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

/**
 * Status-bar DeepSeek spend: the prepaid balance comes from the provider API, but today's
 * cost is computed locally from DSH session logs. These specs pin the local half, which is
 * the part that can be verified without a live key.
 *
 * The fixture log is written as THREE concatenated zstd frames on purpose: DSH appends one
 * frame per write, and a decoder that stops after the first frame silently reports a third
 * of the real cost. That failure mode is invisible without a multi-frame fixture.
 */

const TOKENS_PER_BUCKET = 10_000_000
const REQUESTS = 3
const LIVE_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''

// USD per 1M tokens, https://api-docs.deepseek.com/quick_start/pricing
const FLASH_RATES = {
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
}

/**
 * Deliberately a second implementation of the peak rule, not the app's: a shared bug in the
 * classifier would otherwise cancel itself out and the spec would still pass.
 * Peak = 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday.
 */
function isPeakPricing(ms: number): boolean {
  const at = new Date(ms)
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5
  const hour = at.getUTCHours()
  return weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}

function expectedCostUsd(ms: number): number {
  const rates = isPeakPricing(ms) ? FLASH_RATES.peak : FLASH_RATES.offPeak
  const millions = TOKENS_PER_BUCKET / 1_000_000
  const perRequest = millions * (rates.cacheHit + rates.cacheMiss + rates.output)
  return perRequest * REQUESTS
}

const LEDGER_AT_MS = Date.now()

function createSyntheticLedger(nowMs: number): { root: string; costText: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-dsh-e2e-'))
  const sessionDir = path.join(root, '--e2e-project--', 'e2e-session')
  mkdirSync(sessionDir, { recursive: true })
  const record = JSON.stringify({
    type: 'assistant/message',
    time: nowMs,
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
  writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat([frame, frame, frame]))
  return { root, costText: `$${expectedCostUsd(nowMs).toFixed(2)}` }
}

const ledger = createSyntheticLedger(LEDGER_AT_MS)
const emptyLedgerRoot = mkdtempSync(path.join(tmpdir(), 'orca-dsh-empty-'))

/**
 * Why the spec triggers a refresh: the service only auto-polls while the window is visible AND
 * focused (`shouldBackgroundPoll`), and every E2E launch is deliberately background-only. This
 * is the same store action the usage popover's refresh control calls.
 */
async function refreshUsage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (
      window as unknown as {
        __store: { getState: () => { refreshRateLimits: () => Promise<void> } }
      }
    ).__store
    await store.getState().refreshRateLimits()
  })
}

async function waitForDeepSeekChip(page: Page) {
  const chip = page.locator('[data-usage-chip="deepseek"]')
  await waitForSessionReady(page)
  await refreshUsage(page)
  await expect(chip).toBeVisible({ timeout: 60_000 })
  return chip
}

test.afterAll(() => {
  rmSync(ledger.root, { recursive: true, force: true })
  rmSync(emptyLedgerRoot, { recursive: true, force: true })
})

// Why: agent-run apps must stay in the background (repo rule); the status bar still renders.
// The Chromium switches are the Linux-CI set, needed here because this agent sandbox cannot
// initialize Chromium's own macOS sandbox or GPU process ("Failed to initialize sandbox" →
// "GPU process isn't usable. Goodbye."), which kills the app before the first window loads.
test.use({
  orcaAppExtraArgs: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu'
  ]
})

test.describe('local spend ledger', () => {
  test.use({
    orcaAppExtraEnv: {
      ORCA_BACKGROUND_LAUNCH: '1',
      DSH_SESSIONS_ROOT: ledger.root,
      DEEPSEEK_API_KEY: 'sk-e2e-invalid-key'
    }
  })

  test("shows today's cost when the balance API rejects the key", async ({ orcaPage }) => {
    const chip = await waitForDeepSeekChip(orcaPage)
    await expect(chip).toContainText(ledger.costText, { timeout: 60_000 })
    // A rejected key must surface as a failure, and must not be papered over with a balance.
    await expect(chip).toContainText('Balance unavailable')
  })
})

test.describe('empty spend ledger', () => {
  test.use({
    orcaAppExtraEnv: {
      ORCA_BACKGROUND_LAUNCH: '1',
      DSH_SESSIONS_ROOT: emptyLedgerRoot,
      DEEPSEEK_API_KEY: 'sk-e2e-invalid-key'
    }
  })

  test('reports no amount when there is neither a ledger nor a balance', async ({ orcaPage }) => {
    const chip = await waitForDeepSeekChip(orcaPage)
    await expect(chip).not.toContainText('$', { timeout: 60_000 })
  })
})

test.describe('live balance', () => {
  test.use({
    orcaAppExtraEnv: {
      ORCA_BACKGROUND_LAUNCH: '1',
      DSH_SESSIONS_ROOT: ledger.root,
      DEEPSEEK_API_KEY: LIVE_API_KEY
    }
  })

  /**
   * Live loop: compares the rendered balance against a second, independent call to the same
   * documented endpoint made from the test process.
   */
  test('renders the prepaid balance next to the local cost', async ({ orcaPage }) => {
    test.skip(!LIVE_API_KEY, 'DEEPSEEK_API_KEY not set')
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${LIVE_API_KEY}`, Accept: 'application/json' }
    })
    expect(response.ok).toBe(true)
    const payload = (await response.json()) as {
      balance_infos: { currency: string; total_balance: string }[]
    }
    const row = payload.balance_infos[0]
    expect(row).toBeTruthy()

    const chip = await waitForDeepSeekChip(orcaPage)
    await expect(chip).toContainText(`${row.currency} ${row.total_balance}`, { timeout: 60_000 })
    await expect(chip).toContainText(ledger.costText)

    const proofPath = process.env.ORCA_DEEPSEEK_STATUS_PROOF_PATH
    if (proofPath) {
      await orcaPage.screenshot({ path: proofPath })
    }
  })
})

test.describe('real DSH ledger', () => {
  const realSessionsRoot = path.join(homedir(), '.dsh', 'sessions')
  test.use({
    orcaAppExtraEnv: {
      ORCA_BACKGROUND_LAUNCH: '1',
      DSH_SESSIONS_ROOT: realSessionsRoot,
      DEEPSEEK_API_KEY: LIVE_API_KEY
    }
  })

  /**
   * The end-to-end check that matters: the app scans the same on-disk corpus an independent
   * tool does, and the two agree. Exact equality is impossible by construction — the harness
   * appends to these logs while both readers run — so the assertion bounds the drift instead.
   */
  test('agrees with the independent cost probe on the real session corpus', async ({ orcaPage }) => {
    test.skip(process.env.ORCA_E2E_DEEPSEEK_LIVE_LEDGER !== '1', 'live ledger check is opt-in')
    test.skip(!existsSync(realSessionsRoot), 'no local DSH sessions')
    const probePath =
      process.env.DSH_COST_PROBE_PATH ??
      // Playwright runs with the repo root as cwd; the probe lives in the session workspace above it.
      path.resolve(process.cwd(), '../../research/dsh-cost-probe.mjs')
    test.skip(!existsSync(probePath), `cost probe not found at ${probePath}`)

    const chip = await waitForDeepSeekChip(orcaPage)
    await expect(chip).toContainText('$', { timeout: 60_000 })
    const rendered = Number(/\$([0-9]+\.[0-9]{2})/.exec((await chip.textContent()) ?? '')?.[1])
    expect(Number.isFinite(rendered), 'chip shows no dollar amount').toBe(true)

    // Read the app's snapshot first, then the probe: the harness appends to these logs while
    // both run, so the later reading can only be equal or larger.
    const probeCostUsd = readProbeCostUsd(probePath)
    expect(probeCostUsd - rendered).toBeGreaterThanOrEqual(-0.01)
    expect(probeCostUsd - rendered).toBeLessThanOrEqual(0.05)

    const proofPath = process.env.ORCA_DEEPSEEK_LIVE_LEDGER_PROOF_PATH
    if (proofPath) {
      await orcaPage.screenshot({ path: proofPath })
    }
  })
})

function readProbeCostUsd(probePath: string): number {
  const output = execFileSync('node', [probePath, localDayKey(new Date())], { encoding: 'utf8' })
  const match = /cost ≈ \$([0-9.]+)/.exec(output)
  expect(match, `probe produced no cost line:\n${output}`).toBeTruthy()
  return Number(match?.[1])
}

function localDayKey(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
