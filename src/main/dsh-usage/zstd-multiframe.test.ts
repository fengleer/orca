/**
 * Self-test 1 — concatenated-frame decoding (ported from the DSH usage suite).
 *
 * Asserts the decoder returns exactly what `zstd -dc` returns for the real
 * 429-line log, that the frame count matches `zstd -lv`, and that the boundaries
 * come from the parsed frame format rather than from `engine.bytesWritten` — which
 * Node and Bun disagree about, so trusting it is what breaks under Bun.
 */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as zlib from 'node:zlib'
import { expect, it } from 'vitest'
import {
  CANONICAL_LOG_FRAMES,
  CANONICAL_LOG_LINES,
  CANONICAL_LOG_PATH,
  getFrozenSessions,
  hasRealSessions,
  hasZstdCli,
  resolveZstdPath,
  zstdCliFrameCount,
  zstdCliLineCount,
  zstdFrameCompress
} from './dsh-usage-test-fixtures'
import { listDshSessionFiles } from './session-file-discovery'
import {
  decodeConcatenatedZstdFrames,
  isNodeZstdAvailable,
  readDshSessionFile,
  splitDecodedLines
} from './zstd-multiframe'

// Why: CI may have no DSH data, no `zstd` binary, and an old Node without the
// in-process binding; the pinned counts below stand in for the CLI cross-check.
const realLogAvailable = hasRealSessions() && hasZstdCli() && isNodeZstdAvailable()
const canonicalLogAvailable = hasRealSessions() && isNodeZstdAvailable()

type ZstdInfo = { buffer: Buffer; engine?: { bytesWritten?: number } }

/** The `{ info: true }` overload, which @types/node does not model. */
function decompressWithInfo(buffer: Buffer): ZstdInfo {
  // SAFETY: `{ info: true }` is the documented overload returning `{ buffer, engine }`;
  // both target runtimes implement it (verified on Node 26 and Bun 1.4).
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const withInfo = zlib.zstdDecompressSync as unknown as (input: Buffer, options: { info: true }) => ZstdInfo
  return withInfo(buffer, { info: true })
}

it.skipIf(!realLogAvailable)('multi-frame decoding matches the zstd CLI line and frame counts', async () => {
  const cliLines = zstdCliLineCount(CANONICAL_LOG_PATH)
  const cliFrames = zstdCliFrameCount(CANONICAL_LOG_PATH)
  // Pinned ground truth for this fixture: the file is a finished session log.
  expect(cliLines, 'fixture line count drifted').toBe(CANONICAL_LOG_LINES)
  expect(cliFrames, 'fixture frame count drifted').toBe(CANONICAL_LOG_FRAMES)

  const read = await readDshSessionFile(CANONICAL_LOG_PATH, { decoder: 'node' })
  expect(read.decoder).toBe('node')
  expect(read.lines.length, 'pure-Node decoder silently truncated the log').toBe(cliLines)
  expect(read.frames, 'pure-Node decoder walked the wrong number of frames').toBe(cliFrames)
  expect(read.truncated).toBe(false)

  const cliRead = await readDshSessionFile(CANONICAL_LOG_PATH, {
    decoder: 'zstd-cli',
    zstdPath: resolveZstdPath()
  })
  expect(cliRead.lines.length).toBe(cliLines)
  expect(cliRead.frames, 'the CLI frame count comes from the same parser').toBe(cliFrames)
})

it.skipIf(!canonicalLogAvailable)('decoding does not depend on the engine byte count', async () => {
  const buffer = await readFile(CANONICAL_LOG_PATH)
  const full = decodeConcatenatedZstdFrames(buffer)
  // Why: every frame is handed over as an exact one-frame slice, so both runtimes
  // report a byte count equal to that frame's parsed length.
  expect(full.engineBytesWrittenAgrees, 'engine.bytesWritten contradicted the parsed length').toBe(true)

  // Why: a decoder with no `{ info: true }` overload is the other runtime shape; the
  // parser alone must still find every frame.
  const withoutInfo = (slice: Buffer): Buffer => zlib.zstdDecompressSync(slice)
  const decoded = decodeConcatenatedZstdFrames(buffer, withoutInfo)
  expect(decoded.frames).toBe(CANONICAL_LOG_FRAMES)
  expect(splitDecodedLines(decoded.chunks).length).toBe(CANONICAL_LOG_LINES)
  expect(decoded.engineBytesWrittenAgrees, 'no engine means no cross-check verdict').toBeNull()
  expect(decoded.truncated).toBe(false)
  expect(decoded.bytes).toBe(buffer.length)
})

it.skipIf(!canonicalLogAvailable)('the raw one-shot zstd API is not a portable frame walker', async () => {
  const buffer = await readFile(CANONICAL_LOG_PATH)
  const info = decompressWithInfo(buffer)
  const oneShotLines = splitDecodedLines([info.buffer]).length
  const consumed = info.engine?.bytesWritten
  expect(consumed, 'both runtimes report some engine byte count').toBeTypeOf('number')

  if (oneShotLines < CANONICAL_LOG_LINES) {
    // Node: the binding stops after frame 1, and its byte count is exactly that
    // frame's length, so `offset + bytesWritten` happens to walk correctly here.
    expect(consumed).toBeLessThan(buffer.length)
  } else {
    // Bun: the binding decodes every frame, but reports the whole input as consumed,
    // so the same arithmetic would jump straight past frames 2..N.
    expect(oneShotLines).toBe(CANONICAL_LOG_LINES)
    expect(consumed).toBe(buffer.length)
  }

  const decoded = decodeConcatenatedZstdFrames(buffer)
  expect(decoded.frames).toBe(CANONICAL_LOG_FRAMES)
  expect(splitDecodedLines(decoded.chunks).length).toBeGreaterThanOrEqual(oneShotLines)
  console.log(
    `  raw zstdDecompressSync: ${oneShotLines}/${CANONICAL_LOG_LINES} line(s), ` +
      `engine.bytesWritten=${consumed} of ${buffer.length} bytes`
  )
})

it('reports an engine byte count that disagrees with the parsed frame', () => {
  const frame = zstdFrameCompress('{"type":"assistant/message"}\n')
  // Why: a runtime whose count covers more than the parsed frame (the whole input,
  // as Bun reports when handed one) must not move the boundary; only the verdict flips.
  const greedyEngine = (slice: Buffer): ZstdInfo => ({
    buffer: zlib.zstdDecompressSync(slice),
    engine: { bytesWritten: slice.length + 100 }
  })

  const decoded = decodeConcatenatedZstdFrames(Buffer.concat([frame, frame]), greedyEngine)
  expect(decoded.frames).toBe(2)
  expect(splitDecodedLines(decoded.chunks).length).toBe(2)
  expect(decoded.engineBytesWrittenAgrees).toBe(false)
  expect(decoded.truncated).toBe(false)
})

it('skippable frames are skipped and malformed input never throws', () => {
  const payload = zstdFrameCompress('{"type":"assistant/message"}\n')
  const skippable = Buffer.alloc(8)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(4, 4)

  const withSkippable = Buffer.concat([skippable, Buffer.from('pad!'), payload])
  const decoded = decodeConcatenatedZstdFrames(withSkippable)
  expect(decoded.frames).toBe(1)
  expect(splitDecodedLines(decoded.chunks).length).toBe(1)
  expect(decoded.truncated).toBe(false)
  expect(decoded.bytes).toBe(withSkippable.length)

  // A skippable magic with no room for its length field, and one whose payload
  // runs past the end of the buffer.
  const cutHeader = decodeConcatenatedZstdFrames(skippable.subarray(0, 4))
  expect(cutHeader.frames).toBe(0)
  expect(cutHeader.truncated).toBe(true)
  const cutPayload = decodeConcatenatedZstdFrames(skippable)
  expect(cutPayload.frames).toBe(0)
  expect(cutPayload.truncated).toBe(true)

  // An empty buffer is a valid, empty file.
  const empty = decodeConcatenatedZstdFrames(Buffer.alloc(0))
  expect(empty.frames).toBe(0)
  expect(empty.truncated).toBe(false)

  // Deterministic noise, including a throwing decoder, must degrade not explode.
  for (const length of [1, 3, 4, 64, 4096]) {
    const noise = Buffer.alloc(length)
    for (let index = 0; index < length; index++) {
      noise[index] = (index * 37 + length) & 0xff
    }
    expect(() => decodeConcatenatedZstdFrames(noise)).not.toThrow()
  }
  const alwaysThrows = (): never => {
    throw new Error('engine exploded')
  }
  const threw = decodeConcatenatedZstdFrames(payload, alwaysThrows)
  expect(threw.frames).toBe(0)
  expect(threw.truncated).toBe(true)
  expect(String(threw.truncationReason)).toMatch(/engine exploded/)
})

/** Bounds the corpus check so a bigger session tree costs a bounded amount more. */
const CORPUS_MAX_FILES = 64
const CORPUS_MAX_BYTES = 64 * 1024 * 1024

it.skipIf(!realLogAvailable)('every real session log decodes to the zstd CLI line count', async () => {
  const { sessionsRoot } = await getFrozenSessions()
  const selected: string[] = []
  let budget = CORPUS_MAX_BYTES
  for (const file of await listDshSessionFiles(sessionsRoot)) {
    const size = statSync(file).size
    if (size > budget || selected.length >= CORPUS_MAX_FILES) {
      break
    }
    budget -= size
    selected.push(file)
  }
  expect(selected.length, 'no session logs in the frozen corpus').toBeGreaterThan(0)

  const mismatches: string[] = []
  const truncations: string[] = []
  let frames = 0
  let lines = 0
  let bytes = 0
  for (const file of selected) {
    const read = await readDshSessionFile(file, { decoder: 'node' })
    const cliLines = zstdCliLineCount(file)
    if (read.lines.length !== cliLines) {
      mismatches.push(`${basename(file)}: decoder ${read.lines.length} vs zstd -dc ${cliLines}`)
    }
    if (read.truncated) {
      truncations.push(`${basename(file)}: ${read.truncationReason}`)
    }
    frames += read.frames
    lines += read.lines.length
    bytes += read.bytes
  }
  console.log(
    `  corpus parity: ${selected.length} files, ${frames} frames, ${lines} lines, ${bytes} compressed bytes; ` +
      `${truncations.length} truncated, ${mismatches.length} line-count mismatches`
  )
  expect(mismatches, `line counts differ from zstd -dc:\n${mismatches.join('\n')}`).toEqual([])
  // Why: `frames` counts parsed frames, so a log the parser cannot finish shows up
  // here even when its decoded prefix still matches the CLI.
  expect(truncations, `the parser could not finish these logs:\n${truncations.join('\n')}`).toEqual([])
})
