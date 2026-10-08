/**
 * Self-test 6 — incremental cache (ported from the DSH usage suite).
 *
 * Runs the same scan twice over a frozen tree and asserts the numbers are
 * identical while the second pass does no decompression, then proves a grown file
 * invalidates its entry.
 */

import { appendFile, readdir, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  getFrozenSessions,
  hasRealSessions,
  zstdFrameCompress
} from './dsh-usage-test-fixtures'
import { createDshUsageScanner } from './scanner'
import type { DshUsageSnapshot } from './types'

// Why: CI may have no DSH data; the skip reason is this constant.
const realSessionsAvailable = hasRealSessions()

function resultsOnly(snapshot: DshUsageSnapshot) {
  return {
    day: snapshot.day,
    requests: snapshot.requests,
    tokens: snapshot.tokens,
    costUsd: snapshot.costUsd,
    byModel: snapshot.byModel,
    files: snapshot.scan.files,
    bytes: snapshot.scan.bytes,
    truncatedFiles: snapshot.scan.truncatedFiles
  }
}

it.skipIf(!realSessionsAvailable)(
  'a second scan of unchanged files reuses the cache and matches exactly',
  async () => {
    const frozen = await getFrozenSessions()
    const scanner = createDshUsageScanner({ sessionsRoot: frozen.sessionsRoot })

    const first = await scanner.scanToday()
    expect(first.scan.reusedFromCache).toBe(false)
    expect(first.scan.decodedFiles).toBe(first.scan.files)
    expect(first.scan.decodedFrames).toBeGreaterThan(0)

    const second = await scanner.scanToday()
    expect(resultsOnly(second), 'warm scan changed the numbers').toEqual(resultsOnly(first))
    expect(second.scan.reusedFromCache).toBe(true)
    expect(second.scan.reusedFiles).toBe(second.scan.files)
    expect(second.scan.decodedFiles).toBe(0)
    expect(second.scan.decodedFrames, 'warm scan decompressed something').toBe(0)
    console.log(
      `  files=${first.scan.files} coldFrames=${first.scan.decodedFrames} ` +
        `warmFrames=${second.scan.decodedFrames} requests=${first.requests}`
    )
  }
)

it.skipIf(!realSessionsAvailable)('appending a frame invalidates only that file', async () => {
  const frozen = await getFrozenSessions()
  const scanner = createDshUsageScanner({ sessionsRoot: frozen.sessionsRoot })

  const before = await scanner.scanToday()
  const target = await listOneSessionLog(frozen.sessionsRoot)
  const timeMs = Date.now()
  const line = JSON.stringify({
    type: 'assistant/message',
    time: timeMs,
    data: {
      usage: { inputTokens: 1234, cacheReadTokens: 0, outputTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek', model: 'deepseek-flash' } }
    }
  })
  // Why: DSH appends a whole new frame, so append one here too.
  const appendedFrame = zstdFrameCompress(`${line}\n`)
  await appendFile(target, appendedFrame)

  const after = await scanner.scanToday()
  expect(after.scan.reusedFromCache).toBe(false)
  expect(after.scan.decodedFiles, 'only the appended file should be re-decoded').toBe(1)
  expect(after.scan.reusedFiles).toBe(after.scan.files - 1)
  expect(after.requests).toBe(before.requests + 1)
  expect(after.tokens.cacheMiss).toBe(before.tokens.cacheMiss + 1234)
  expect(after.costUsd).toBeGreaterThan(before.costUsd)

  // Why: put the frozen tree back so sibling assertions in this process stay valid.
  const size = (await stat(target)).size
  await truncate(target, size - appendedFrame.length)
})

it.skipIf(!realSessionsAvailable)('clearCache forces a full re-decode', async () => {
  const frozen = await getFrozenSessions()
  const scanner = createDshUsageScanner({ sessionsRoot: frozen.sessionsRoot })
  const first = await scanner.scanToday()
  await scanner.scanToday()
  scanner.clearCache()
  const afterClear = await scanner.scanToday()
  expect(afterClear.scan.reusedFromCache).toBe(false)
  expect(afterClear.scan.decodedFiles).toBe(afterClear.scan.files)
  expect(resultsOnly(afterClear)).toEqual(resultsOnly(first))
})

async function listOneSessionLog(root: string): Promise<string> {
  const projects = await readdir(root, { withFileTypes: true })
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue
    }
    const sessions = await readdir(join(root, project.name), { withFileTypes: true })
    for (const session of sessions) {
      if (!session.isDirectory()) {
        continue
      }
      const candidate = join(root, project.name, session.name, 'session.v4.jsonl.zstd')
      // Why: append to a file that already has a record today, so the day filter
      // cannot hide the new record.
      const snapshot = await stat(candidate).catch(() => null)
      if (snapshot && snapshot.size > 0) {
        return candidate
      }
    }
  }
  throw new Error('no session logs in the frozen tree')
}
