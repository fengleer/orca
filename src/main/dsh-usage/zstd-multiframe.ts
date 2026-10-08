import { readFile } from 'node:fs/promises'
import type { DshZstdDecoder } from './types'
import { readWithZstdCli } from './zstd-cli-decoder'
import {
  decodeConcatenatedZstdFrames,
  errorMessage,
  isNodeZstdAvailable
} from './zstd-frame-walk'

export { decodeConcatenatedZstdFrames, isNodeZstdAvailable } from './zstd-frame-walk'
export type { DshFrameDecode } from './zstd-frame-walk'

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024

export type DshSessionFileRead = {
  lines: string[]
  frames: number
  /** Compressed bytes read from disk. */
  bytes: number
  decoder: DshZstdDecoder
  truncated: boolean
  truncationReason: string | null
  /** True when the file could not be read at all; `lines` is empty. */
  skipped: boolean
  skipReason: string | null
}

export type DshSessionFileReadOptions = {
  decoder?: DshZstdDecoder | 'auto'
  zstdPath?: string
  maxFileBytes?: number
}

/** Split decoded frame text into lines, tolerating a partial trailing line. */
export function splitDecodedLines(chunks: readonly Buffer[]): string[] {
  if (chunks.length === 0) {
    return []
  }
  const text = Buffer.concat(chunks).toString('utf8')
  // Why: a partial trailing record (the writer was interrupted mid-append) simply
  // fails JSON.parse downstream, so no special casing is needed here.
  return text.split('\n').filter((line) => line.trim().length > 0)
}

function resolveDecoder(requested: DshZstdDecoder | 'auto' | undefined): DshZstdDecoder {
  if (requested === 'node' || requested === 'zstd-cli') {
    return requested
  }
  return isNodeZstdAvailable() ? 'node' : 'zstd-cli'
}

function resolveZstdPath(zstdPath: string | undefined): string {
  return zstdPath ?? process.env.DSH_ZSTD_PATH ?? 'zstd'
}

/**
 * Read one DSH session log into JSON lines.
 *
 * Never throws: unreadable files, oversized files and corrupt frames are reported
 * through `skipped`/`truncated` so a single bad log cannot fail a whole scan.
 */
export async function readDshSessionFile(
  filePath: string,
  options: DshSessionFileReadOptions = {}
): Promise<DshSessionFileRead> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const decoder = resolveDecoder(options.decoder)

  if (decoder === 'zstd-cli') {
    const cli = await readWithZstdCli(filePath, resolveZstdPath(options.zstdPath), maxFileBytes)
    if (cli.outcome === 'skipped') {
      return skippedRead('zstd-cli', cli.reason)
    }
    if (cli.outcome === 'failed') {
      return {
        lines: [],
        frames: 0,
        bytes: cli.bytes,
        decoder: 'zstd-cli',
        truncated: true,
        truncationReason: cli.reason,
        skipped: false,
        skipReason: null
      }
    }
    return {
      lines: cli.lines,
      frames: cli.frames,
      bytes: cli.bytes,
      decoder: 'zstd-cli',
      truncated: false,
      truncationReason: null,
      skipped: false,
      skipReason: null
    }
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    return skippedRead('node', errorMessage(error))
  }
  if (buffer.length > maxFileBytes) {
    return skippedRead('node', `file is ${buffer.length} bytes, over the ${maxFileBytes}-byte limit`)
  }

  const decoded = decodeConcatenatedZstdFrames(buffer)
  if (decoded.frames === 0 && decoded.truncated) {
    // Why: the bytes do not begin with a zstd frame at all, so `zstd -dc` is the
    // documented escape hatch for a file the in-process parser cannot read.
    return {
      lines: [],
      frames: 0,
      bytes: buffer.length,
      decoder: 'node',
      truncated: true,
      truncationReason: decoded.truncationReason,
      skipped: false,
      skipReason: null
    }
  }
  return {
    lines: splitDecodedLines(decoded.chunks),
    frames: decoded.frames,
    bytes: buffer.length,
    decoder: 'node',
    truncated: decoded.truncated,
    truncationReason: decoded.truncationReason,
    skipped: false,
    skipReason: null
  }
}

function skippedRead(decoder: DshZstdDecoder, reason: string): DshSessionFileRead {
  return {
    lines: [],
    frames: 0,
    bytes: 0,
    decoder,
    truncated: false,
    truncationReason: null,
    skipped: true,
    skipReason: reason
  }
}
