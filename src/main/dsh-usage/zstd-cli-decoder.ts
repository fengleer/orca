/**
 * `zstd -dc` CLI decoder for DSH session logs: the fallback used when the runtime
 * has no zstd at all (Electron's Node 22, `zstdDecompressSync` was added in
 * Node 23.8).
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseZstdFrameSequence } from './zstd-frame-parser'
import { errorMessage } from './zstd-frame-walk'

const execFileAsync = promisify(execFile)
const CLI_MAX_BUFFER_BYTES = 512 * 1024 * 1024

/**
 * Outcome of one CLI read: `decoded` carries the lines, `skipped` means the file
 * was unreadable or over the size limit, `failed` means `zstd -dc` itself errored.
 */
export type ZstdCliDecodeOutcome =
  | { outcome: 'decoded'; lines: string[]; frames: number; bytes: number }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string; bytes: number }

export async function readWithZstdCli(
  filePath: string,
  zstdPath: string,
  maxFileBytes: number
): Promise<ZstdCliDecodeOutcome> {
  let compressedBytes = 0
  let frameCount = 0
  try {
    const buffer = await readFile(filePath)
    compressedBytes = buffer.length
    if (buffer.length > maxFileBytes) {
      return {
        outcome: 'skipped',
        reason: `file is ${buffer.length} bytes, over the ${maxFileBytes}-byte limit`
      }
    }
    // Why: `zstd -dc` decodes every frame but never reports how many, so count them
    // with the same parser the Node path slices with (`zstd -lv` agrees with it).
    frameCount = parseZstdFrameSequence(buffer).frames.length
  } catch (error) {
    return { outcome: 'skipped', reason: errorMessage(error) }
  }

  try {
    const { stdout } = await execFileAsync(zstdPath, ['-dc', '--quiet', filePath], {
      maxBuffer: CLI_MAX_BUFFER_BYTES,
      encoding: 'utf8'
    })
    return {
      outcome: 'decoded',
      lines: stdout.split('\n').filter((line) => line.trim().length > 0),
      frames: frameCount,
      bytes: compressedBytes
    }
  } catch (error) {
    return {
      outcome: 'failed',
      reason: `${zstdPath} -dc failed: ${errorMessage(error)}`,
      bytes: compressedBytes
    }
  }
}
