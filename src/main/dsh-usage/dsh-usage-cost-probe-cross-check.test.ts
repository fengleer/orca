/**
 * Self-test 7 — cross-check against `research/dsh-cost-probe.mjs`
 * (ported from the DSH usage suite's `cross-check-probe.test.ts`).
 *
 * The probe is the pre-existing, independently written reference (zstd CLI +
 * hand-rolled peak classifier). It hardcodes `~/.dsh/sessions`, so it runs against
 * the frozen tree through `HOME` and therefore reads exactly the bytes the scanner
 * reads — no race with the live session that is appending records right now.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  COST_PROBE_PATH,
  getFrozenSessions,
  hasRealSessions,
  hasZstdCli,
  localDayKey
} from './dsh-usage-test-fixtures'
import { createDshUsageScanner } from './scanner'

// Why skipIf: needs real DSH data, the probe script (it lives outside this repo,
// see the fixture path resolution) and the `zstd` binary the probe itself spawns.
const probeAvailable = hasRealSessions() && existsSync(COST_PROBE_PATH) && hasZstdCli()

type ProbeTotals = {
  requests: number
  cacheMiss: number
  cacheHit: number
  output: number
  costUsd: number
}

function runCostProbe(dayKey: string, home: string): ProbeTotals {
  const output = execFileSync(process.execPath, [COST_PROBE_PATH, dayKey], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const totals = /reqs=(\d+)\s+miss=(\d+)\s+hit=(\d+)\s+out=(\d+)/.exec(output)
  const cost = /cost ≈ \$([0-9.]+)/.exec(output)
  expect(totals, `unexpected probe output:\n${output}`).toBeTruthy()
  expect(cost, `unexpected probe output:\n${output}`).toBeTruthy()
  return {
    requests: Number(totals?.[1]),
    cacheMiss: Number(totals?.[2]),
    cacheHit: Number(totals?.[3]),
    output: Number(totals?.[4]),
    costUsd: Number(cost?.[1])
  }
}

it.skipIf(!probeAvailable)('scanToday matches the independent zstd-CLI cost probe', async () => {
  const frozen = await getFrozenSessions()
  const dayKey = localDayKey(Date.now())

  // Why: the probe defaults to the *UTC* day, which is the wrong local day for
  // eight hours of every CST day, so pin its argument to the local day key.
  const probe = runCostProbe(dayKey, frozen.home)
  expect(probe.requests, 'probe found no records — did the HOME override work?').toBeGreaterThan(0)

  const snapshot = await createDshUsageScanner({ sessionsRoot: frozen.sessionsRoot }).scanToday()
  const numbersMatch =
    snapshot.requests === probe.requests &&
    snapshot.tokens.cacheMiss === probe.cacheMiss &&
    snapshot.tokens.cacheHit === probe.cacheHit &&
    snapshot.tokens.output === probe.output
  expect(
    numbersMatch,
    `scanner ${JSON.stringify({
      requests: snapshot.requests,
      cacheMiss: snapshot.tokens.cacheMiss,
      cacheHit: snapshot.tokens.cacheHit,
      output: snapshot.tokens.output,
      costUsd: snapshot.costUsd
    })} !== probe ${JSON.stringify(probe)}`
  ).toBe(true)

  // The probe prints 4 decimals, so compare at its precision and assert that the
  // unrounded values agree far more tightly than that.
  expect(
    snapshot.costUsd.toFixed(4),
    'cost disagreed at the probe’s printed precision'
  ).toBe(probe.costUsd.toFixed(4))
  expect(
    Math.abs(snapshot.costUsd - probe.costUsd) < 5e-5,
    `cost differed by ${Math.abs(snapshot.costUsd - probe.costUsd)}`
  ).toBe(true)

  console.log(
    `  ${dayKey}  scanner: requests=${snapshot.requests} cacheMiss=${snapshot.tokens.cacheMiss} ` +
      `cacheHit=${snapshot.tokens.cacheHit} output=${snapshot.tokens.output} costUsd=${snapshot.costUsd}`
  )
  console.log(
    `  ${dayKey}  probe:   requests=${probe.requests} cacheMiss=${probe.cacheMiss} ` +
      `cacheHit=${probe.cacheHit} output=${probe.output} costUsd=${probe.costUsd}`
  )
})
