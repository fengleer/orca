/**
 * Concatenated-frame zstd reader for DSH session logs.
 *
 * DSH appends to `session.v4.jsonl.zstd` without rewriting it, so the file is a
 * *sequence* of independent zstd frames rather than one frame. Node's one-shot
 * zstd APIs stop after the first frame (silently, without throwing); Bun's decode
 * every frame but report the whole input as `engine.bytesWritten`. Neither shape
 * is portable, so frame boundaries come from `zstd-frame-parser.ts` and this
 * module only decompresses the slices the parser produced.
 *
 * `engine.bytesWritten` survives as a cross-check on those slices — it must equal
 * the parsed length, and a disagreement is reported, never acted on.
 *
 * Fallback: a runtime without `node:zlib` zstd (Electron's Node 22; the binding
 * arrived in Node 23.8) shells out to `zstd -dc` instead, see `zstd-cli-decoder.ts`.
 */

import * as zlib from 'node:zlib'
import { parseZstdFrameSequence } from './zstd-frame-parser'

/** The `{ info: true }` overload's result; @types/node models only the plain one. */
type ZstdInfoResult = { buffer: Buffer; engine?: { bytesWritten?: number } }

type ZstdDecompress = (buffer: Buffer, options?: { info: true }) => Buffer | ZstdInfoResult

export type DshFrameDecode = {
  chunks: Buffer[]
  /** Frames decoded successfully; skippable frames hold no data and are not counted. */
  frames: number
  /** Compressed bytes covered by every parsed frame, skippable frames included. */
  bytes: number
  truncated: boolean
  truncationReason: string | null
  /**
   * Verdict of the `engine.bytesWritten` cross-check: `true` when every frame the
   * runtime reported on consumed exactly its parsed length, `false` on any
   * disagreement, `null` when the runtime reports nothing. Never a boundary source.
   */
  engineBytesWrittenAgrees: boolean | null
}

function getNodeZstdDecompress(): ZstdDecompress | null {
  const candidate = (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync
  return typeof candidate === 'function' ? (candidate as ZstdDecompress) : null
}

/** True when this Node/Electron runtime can decompress zstd without a subprocess. */
export function isNodeZstdAvailable(): boolean {
  return getNodeZstdDecompress() !== null
}

/** Message text of a thrown value, for the failure reasons the decoder modules report. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Decode every zstd frame in `buffer`.
 *
 * Never throws: corrupt or unknown bytes stop the walk and are reported through
 * `truncated`/`truncationReason`, so the caller can still count the records that
 * were readable. Pass `decompress` to exercise the fallback paths in tests.
 */
export function decodeConcatenatedZstdFrames(
  buffer: Buffer,
  decompress: ZstdDecompress | null = getNodeZstdDecompress()
): DshFrameDecode {
  const walked = parseZstdFrameSequence(buffer)
  const chunks: Buffer[] = []
  const result: DshFrameDecode = {
    chunks,
    frames: 0,
    bytes: 0,
    truncated: walked.truncated,
    truncationReason: walked.truncationReason,
    engineBytesWrittenAgrees: null
  }
  if (!decompress) {
    result.truncated = buffer.length > 0
    result.truncationReason =
      'node:zlib.zstdDecompressSync is unavailable in this runtime (needs Node 23.8+)'
    return result
  }

  for (const span of walked.frames) {
    const end = span.offset + span.bytes
    if (span.skippable) {
      result.bytes = end
      continue
    }
    let decoded: Buffer
    try {
      const outcome = decompress(buffer.subarray(span.offset, end), { info: true })
      if (Buffer.isBuffer(outcome)) {
        // Why: a runtime that ignores `{ info: true }` still decodes correctly here;
        // only the cross-check below goes missing.
        decoded = outcome
      } else {
        decoded = outcome.buffer
        const written = outcome.engine?.bytesWritten
        if (written !== undefined) {
          result.engineBytesWrittenAgrees =
            (result.engineBytesWrittenAgrees ?? true) && written === span.bytes
        }
      }
    } catch (error) {
      result.truncated = true
      result.truncationReason = `frame ${result.frames + 1} at byte ${span.offset} failed to decode: ${errorMessage(error)}`
      return result
    }
    chunks.push(decoded)
    result.frames++
    result.bytes = end
  }
  return result
}
