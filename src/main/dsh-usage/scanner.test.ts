/**
 * Scanner self-tests, ported from the DSH usage suite.
 *
 * Part one (self-test 2) checks today's totals against a second, deliberately
 * simpler recount. The recount shares no code with the scanner: it walks the tree
 * itself, decodes with the module's reader (that decoder is cross-checked against
 * `zstd -dc` in `zstd-multiframe.test.ts`), parses with `JSON.parse` and sums by
 * hand. Both read the same frozen copy of `~/.dsh/sessions` so the comparison is
 * exact rather than racy.
 *
 * Part two (self-test 5) covers robustness: a missing root, an empty root, an
 * unreadable file, a file that is not zstd at all and a partial trailing line must
 * all produce a snapshot (zeroed where there is nothing to count) instead of
 * throwing.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  getFrozenSessions,
  hasRealSessions,
  localDayKey,
  makeTempDir,
  removeTempDir,
  zstdFrameCompress
} from './dsh-usage-test-fixtures'
import { createDshUsageScanner, localDayRange } from './scanner'
import { readDshSessionFile } from './zstd-multiframe'

// Why: CI may have no DSH data; the skip reason is this constant.
const realSessionsAvailable = hasRealSessions()

function walkSessionLogs(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.name === 'session.v4.jsonl.zstd') {
        found.push(path)
      }
    }
  }
  visit(root)
  return found.sort()
}

type IndependentTotals = {
  files: number
  requests: number
  cacheMiss: number
  cacheHit: number
  output: number
  cacheWrite: number
}

/** The plainest possible recount: decode, parse, filter by local day, sum. */
async function recountToday(root: string, dayKey: string): Promise<IndependentTotals> {
  const files = walkSessionLogs(root)
  const totals: IndependentTotals = {
    files: files.length,
    requests: 0,
    cacheMiss: 0,
    cacheHit: 0,
    output: 0,
    cacheWrite: 0
  }
  for (const file of files) {
    const read = await readDshSessionFile(file, { decoder: 'node' })
    for (const line of read.lines) {
      if (!line.trim()) {
        continue
      }
      let record: {
        time?: unknown
        data?: { usage?: Record<string, unknown> }
      }
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const usage = record.data?.usage
      if (!usage || typeof record.time !== 'number') {
        continue
      }
      if (localDayKey(record.time) !== dayKey) {
        continue
      }
      totals.requests++
      totals.cacheMiss += Number(usage.inputTokens) || 0
      totals.cacheHit += Number(usage.cacheReadTokens) || 0
      totals.output += Number(usage.outputTokens) || 0
      totals.cacheWrite += Number(usage.cacheWriteTokens) || 0
    }
  }
  return totals
}

it.skipIf(!realSessionsAvailable)(
  "today's requests and token sums match an independent recount",
  async () => {
    const frozen = await getFrozenSessions()
    const dayKey = localDayKey(Date.now())
    const expected = await recountToday(frozen.sessionsRoot, dayKey)

    const snapshot = await createDshUsageScanner({ sessionsRoot: frozen.sessionsRoot }).scanToday()

    expect(snapshot.day).toBe(dayKey)
    expect(snapshot.scan.files, 'file discovery disagreed').toBe(expected.files)
    expect(snapshot.requests, 'request count disagreed').toBe(expected.requests)
    expect(
      snapshot.tokens,
      'token sums disagreed'
    ).toEqual({
      cacheMiss: expected.cacheMiss,
      cacheHit: expected.cacheHit,
      output: expected.output,
      cacheWrite: expected.cacheWrite
    })
    console.log(
      `  ${dayKey}: requests=${snapshot.requests} cacheMiss=${snapshot.tokens.cacheMiss} ` +
        `cacheHit=${snapshot.tokens.cacheHit} output=${snapshot.tokens.output} ` +
        `cacheWrite=${snapshot.tokens.cacheWrite} files=${snapshot.scan.files}`
    )
  }
)

it('a missing sessions root yields a zeroed snapshot', async () => {
  const tempRoot = await makeTempDir('missing-root-')
  try {
    const scanner = createDshUsageScanner({ sessionsRoot: join(tempRoot, 'nope', 'deeper') })
    const snapshot = await scanner.scanToday()
    expect(snapshot.requests).toBe(0)
    expect(snapshot.tokens).toEqual({ cacheMiss: 0, cacheHit: 0, output: 0, cacheWrite: 0 })
    expect(snapshot.costUsd).toBe(0)
    expect(snapshot.byModel).toEqual({})
    expect(snapshot.scan.files).toBe(0)
    expect(snapshot.scan.bytes).toBe(0)
    expect(snapshot.scan.decodedFrames).toBe(0)
    expect(snapshot.scan.reusedFromCache).toBe(false)
    expect(snapshot.scan.firstRecordMs).toBeNull()
    expect(snapshot.scan.lastRecordMs).toBeNull()
  } finally {
    await removeTempDir(tempRoot)
  }
})

it('an empty sessions root yields a zeroed snapshot', async () => {
  const tempRoot = await makeTempDir('empty-root-')
  try {
    const snapshot = await createDshUsageScanner({ sessionsRoot: tempRoot }).scanDay('2026-10-05')
    expect(snapshot.day).toBe('2026-10-05')
    expect(snapshot.requests).toBe(0)
    expect(snapshot.costUsd).toBe(0)
    expect(snapshot.scan.files).toBe(0)
  } finally {
    await removeTempDir(tempRoot)
  }
})

it('unreadable, non-zstd and partially written logs never throw', async () => {
  const tempRoot = await makeTempDir('corrupt-')
  try {
    const goodDir = join(tempRoot, 'proj-a', 'session-good')
    const garbageDir = join(tempRoot, 'proj-b', 'session-garbage')
    const lockedDir = join(tempRoot, 'proj-c', 'session-locked')
    const partialDir = join(tempRoot, 'proj-d', 'session-partial')
    await Promise.all([
      mkdir(goodDir, { recursive: true }),
      mkdir(garbageDir, { recursive: true }),
      mkdir(lockedDir, { recursive: true }),
      mkdir(partialDir, { recursive: true })
    ])

    const timeMs = Date.UTC(2026, 9, 5, 2, 0, 0)
    const usageLine = JSON.stringify({
      type: 'assistant/message',
      time: timeMs,
      data: {
        usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 30, cacheWriteTokens: 0 },
        message: { source: { provider: 'deepseek', model: 'deepseek-flash' } }
      }
    })
    // A complete line plus a half-written tail, in two frames.
    await writeFile(
      join(goodDir, 'session.v4.jsonl.zstd'),
      Buffer.concat([
        zstdFrameCompress(`${usageLine}\n`),
        zstdFrameCompress('{"type":"tool/call","ti')
      ])
    )
    // Not zstd at all.
    await writeFile(join(garbageDir, 'session.v4.jsonl.zstd'), Buffer.from('this is not zstd\n'))
    // A double-framed file whose second frame is corrupt.
    const corruptFrame = Buffer.from(zstdFrameCompress(`${usageLine}\n`))
    corruptFrame[corruptFrame.length - 1] ^= 0xff
    await writeFile(
      join(partialDir, 'session.v4.jsonl.zstd'),
      Buffer.concat([zstdFrameCompress(`${usageLine}\n`), corruptFrame])
    )
    const lockedPath = join(lockedDir, 'session.v4.jsonl.zstd')
    await writeFile(lockedPath, zstdFrameCompress(`${usageLine}\n`))
    await chmod(lockedPath, 0o000)

    const scanner = createDshUsageScanner({ sessionsRoot: tempRoot })
    const snapshot = await scanner.scanDay('2026-10-05')

    expect(snapshot.scan.files, 'every discovered file should still be counted').toBe(4)
    // The good file contributes its one request, and so does the valid first frame
    // of the double-framed file whose second frame is corrupt. The half-written
    // tail in the good file contributes nothing.
    expect(snapshot.requests).toBe(2)
    expect(snapshot.tokens).toEqual({ cacheMiss: 20, cacheHit: 40, output: 60, cacheWrite: 0 })
    expect(
      snapshot.scan.truncatedFiles,
      'non-zstd and corrupt frames should be reported'
    ).toBeGreaterThanOrEqual(2)
    expect(snapshot.scan.unparsableLines, 'the half-written tail should be counted').toBe(1)
    expect(snapshot.scan.skippedFiles, 'the chmod 000 file should be skipped').toBeGreaterThanOrEqual(1)
    expect(snapshot.scan.reusedFromCache).toBe(false)
    // Every failure above is recorded, none of it is fatal.
    await chmod(lockedPath, 0o600)
  } finally {
    await removeTempDir(tempRoot)
  }
})

it('an invalid day key is a loud programming error, unlike I/O failures', () => {
  expect(() => localDayRange('2026-13-01')).toThrow(/Invalid day key/)
  expect(() => localDayRange('2026-02-30')).toThrow(/not a real calendar date/)
  expect(() => localDayRange('today')).toThrow(/Invalid day key/)
})
