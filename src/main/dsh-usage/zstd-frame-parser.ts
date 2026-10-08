/**
 * Exact zstd frame boundaries, read from the frame format itself (RFC 8878 §3)
 * rather than from the decoder.
 *
 * Why not `engine.bytesWritten`: Node reports the compressed bytes one frame
 * consumed, Bun reports the whole input, so slice arithmetic that trusts it walks
 * off the frame boundary on Bun. Block headers already encode each frame's length,
 * and reading them needs no decompression and no runtime assumption.
 */

/** `28 B5 2F FD` on disk. */
const ZSTD_FRAME_MAGIC = 0xfd2fb528
/** `50 2A 4D 18` plus a 1-byte variant: magic, 4-byte payload size, payload. */
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f

/** Descriptor bits 7-6 (1, 2, 3) -> content-size field of 2, 4, 8 bytes. */
const FRAME_CONTENT_SIZE_BYTES = [2, 4, 8]
/** Descriptor bits 1-0 -> dictionary-ID field of 0, 1, 2, 4 bytes. */
const DICTIONARY_ID_BYTES = [0, 1, 2, 4]
/** Descriptor bit 3 is reserved and bit 4 unused: either set means these are not frame bytes. */
const FRAME_HEADER_RESERVED_BITS = 0b00011000

const BLOCK_TYPE_RLE = 1
const BLOCK_TYPE_RESERVED = 3

/** One frame located by the parser. */
export type ZstdFrameSpan = {
  offset: number
  /** Exact compressed length, the 4-byte magic included. */
  bytes: number
  /** Skippable frames carry user data and decode to nothing. */
  skippable: boolean
}

export type ZstdFrameSequence = {
  frames: ZstdFrameSpan[]
  /** Compressed bytes covered by `frames`. */
  bytes: number
  truncated: boolean
  truncationReason: string | null
}

type FrameParse = { ok: true; span: ZstdFrameSpan } | { ok: false; reason: string }

/** Parse the frame starting at `offset`; a failure reason names the exact byte. */
function parseZstdFrameAt(buffer: Buffer, offset: number): FrameParse {
  if (offset + 4 > buffer.length) {
    return { ok: false, reason: `trailing ${buffer.length - offset} byte(s) at byte ${offset} cannot hold a frame magic` }
  }
  const magic = buffer.readUInt32LE(offset)

  if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
    if (offset + 8 > buffer.length) {
      return { ok: false, reason: `truncated skippable frame header at byte ${offset}` }
    }
    const bytes = 8 + buffer.readUInt32LE(offset + 4)
    if (offset + bytes > buffer.length) {
      return { ok: false, reason: `skippable frame at byte ${offset} runs past the end of the file` }
    }
    return { ok: true, span: { offset, bytes, skippable: true } }
  }
  if (magic !== ZSTD_FRAME_MAGIC) {
    return {
      ok: false,
      reason: `no zstd frame magic at byte ${offset} (found 0x${magic.toString(16)})`
    }
  }
  if (offset + 5 > buffer.length) {
    return { ok: false, reason: `truncated frame header at byte ${offset}` }
  }

  const descriptor = buffer[offset + 4]
  if ((descriptor & FRAME_HEADER_RESERVED_BITS) !== 0) {
    return { ok: false, reason: `reserved frame header bit set at byte ${offset + 4}` }
  }
  const contentSizeFlag = (descriptor >> 6) & 0b11
  const singleSegment = (descriptor >> 5) & 0b1
  // Why: flag 0 means "1 byte" only for single-segment frames, otherwise "absent".
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : FRAME_CONTENT_SIZE_BYTES[contentSizeFlag - 1]

  // Frame_Header is the descriptor, an optional window descriptor, then the
  // optional dictionary ID and content size.
  let cursor =
    offset + 5 + (singleSegment === 1 ? 0 : 1) + DICTIONARY_ID_BYTES[descriptor & 0b11] + contentSizeBytes
  if (cursor > buffer.length) {
    return { ok: false, reason: `truncated frame header at byte ${offset}` }
  }

  for (;;) {
    if (cursor + 3 > buffer.length) {
      return { ok: false, reason: `truncated block header at byte ${cursor}` }
    }
    const blockHeader = buffer.readUIntLE(cursor, 3)
    const blockStart = cursor
    const lastBlock = (blockHeader & 0b1) === 1
    const blockType = (blockHeader >> 1) & 0b11
    const blockSize = blockHeader >> 3
    if (blockType === BLOCK_TYPE_RESERVED) {
      return { ok: false, reason: `reserved block type in the block header at byte ${blockStart}` }
    }
    // Why: raw and compressed blocks carry `blockSize` bytes, RLE carries one.
    cursor += 3 + (blockType === BLOCK_TYPE_RLE ? 1 : blockSize)
    if (cursor > buffer.length) {
      return { ok: false, reason: `block at byte ${blockStart} runs past the end of the file` }
    }
    if (lastBlock) {
      break
    }
  }

  if (((descriptor >> 2) & 0b1) === 1) {
    cursor += 4
    if (cursor > buffer.length) {
      return { ok: false, reason: `content checksum at byte ${cursor - 4} runs past the end of the file` }
    }
  }
  return { ok: true, span: { offset, bytes: cursor - offset, skippable: false } }
}

/** Walk `buffer` frame by frame; never throws, and stops honestly on corruption. */
export function parseZstdFrameSequence(buffer: Buffer): ZstdFrameSequence {
  const frames: ZstdFrameSpan[] = []
  let offset = 0
  while (offset < buffer.length) {
    const parsed = parseZstdFrameAt(buffer, offset)
    if (!parsed.ok) {
      return { frames, bytes: offset, truncated: true, truncationReason: parsed.reason }
    }
    frames.push(parsed.span)
    offset += parsed.span.bytes
  }
  return { frames, bytes: offset, truncated: false, truncationReason: null }
}
