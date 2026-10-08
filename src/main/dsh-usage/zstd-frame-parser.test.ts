/**
 * Byte-level tests for the frame parser.
 *
 * Why hand-built frames: every frame in the real DSH corpus shares one header shape
 * (`fcs=0, single=0, chk=1, dict=0`), so dictionary IDs, single-segment content
 * sizes, RLE blocks and reserved block types are only reachable through synthetic
 * bytes — and a parser that guesses would pass on the corpus alone.
 */

import * as zlib from 'node:zlib'
import { expect, it } from 'vitest'
import { parseZstdFrameSequence } from './zstd-frame-parser'

type BlockSpec = { type?: number; size: number; payload?: Buffer }

/** Hand-build a frame so header fields the corpus never uses can be exercised. */
function buildFrame(
  options: {
    singleSegment?: boolean
    fcsFlag?: number
    dictionaryIdBytes?: number
    checksum?: boolean
    blocks?: BlockSpec[]
  } = {}
): Buffer {
  const singleSegment = options.singleSegment ?? true
  const fcsFlag = options.fcsFlag ?? 0
  const blocks = options.blocks ?? [{ size: 0 }]
  const dictionaryIdBytes = options.dictionaryIdBytes ?? 0
  // Descriptor bits 1-0 code the dictionary-ID field size as 0/1/2/4 bytes.
  const dictionaryIdFlag = [0, 1, 2, 0, 3][dictionaryIdBytes]
  const descriptor =
    (fcsFlag << 6) |
    ((singleSegment ? 1 : 0) << 5) |
    ((options.checksum ? 1 : 0) << 2) |
    dictionaryIdFlag
  const contentSizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  // Why the annotation: `Buffer.alloc` returns a non-shared buffer, the collected
  // payloads are plain `Buffer`s, and `parts` must accept both.
  const parts: Buffer[] = [
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, descriptor]),
    singleSegment ? Buffer.alloc(0) : Buffer.from([0x00]),
    Buffer.alloc(dictionaryIdBytes),
    Buffer.alloc(contentSizeBytes)
  ]
  blocks.forEach((block, index) => {
    const type = block.type ?? 0
    const header = Buffer.alloc(3)
    header.writeUIntLE((block.size << 3) | (type << 1) | (index === blocks.length - 1 ? 1 : 0), 0, 3)
    parts.push(header, block.payload ?? Buffer.alloc(type === 1 ? 1 : block.size))
  })
  if (options.checksum) {
    parts.push(Buffer.alloc(4))
  }
  return Buffer.concat(parts)
}

function skippableFrame(payloadBytes: number, magicVariant = 0): Buffer {
  const frame = Buffer.alloc(8 + payloadBytes)
  frame.writeUInt32LE(0x184d2a50 + magicVariant, 0)
  frame.writeUInt32LE(payloadBytes, 4)
  return frame
}

it('measures real frames of every content-size encoding exactly', () => {
  // Why these sizes: the encoder switches content-size field at 256 bytes (2-byte
  // form encoding size-256) and again at 65792 (4-byte form).
  const expectedFlags = [0, 1, 2]
  const sizes = [10, 300, 70000]
  sizes.forEach((size, index) => {
    const frame = zlib.zstdCompressSync(Buffer.alloc(size, 0x61))
    expect((frame[4] >> 6) & 0b11, `content-size flag for ${size} bytes`).toBe(expectedFlags[index])
    const parsed = parseZstdFrameSequence(frame)
    expect(parsed.truncated).toBe(false)
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].bytes, `parsed length for ${size} bytes`).toBe(frame.length)
    expect(parsed.bytes).toBe(frame.length)
  })
})

it('accounts for every optional frame header field', () => {
  for (const singleSegment of [true, false]) {
    for (const fcsFlag of [0, 1, 2, 3]) {
      for (const dictionaryIdBytes of [0, 1, 2, 4]) {
        for (const checksum of [false, true]) {
          const label = `single=${singleSegment} fcs=${fcsFlag} dict=${dictionaryIdBytes} checksum=${checksum}`
          const frame = buildFrame({ singleSegment, fcsFlag, dictionaryIdBytes, checksum, blocks: [{ size: 3 }] })
          const parsed = parseZstdFrameSequence(frame)
          expect(parsed.truncated, label).toBe(false)
          expect(parsed.frames[0].bytes, label).toBe(frame.length)
          // A header length off by any field would stop short of the last byte.
          expect(parsed.bytes, label).toBe(frame.length)
        }
      }
    }
  }
})

it('walks concatenated frames and skippable frames without scanning for magic', () => {
  const first = buildFrame({ blocks: [{ size: 2 }] })
  const skip = skippableFrame(4, 0x0f)
  const second = buildFrame({ checksum: true, blocks: [{ size: 5 }, { size: 1 }] })
  const combined = Buffer.concat([first, skip, second])

  const parsed = parseZstdFrameSequence(combined)
  expect(parsed.truncated).toBe(false)
  expect(
    parsed.frames.map((frame) => ({ offset: frame.offset, bytes: frame.bytes, skippable: frame.skippable }))
  ).toEqual([
    { offset: 0, bytes: first.length, skippable: false },
    { offset: first.length, bytes: skip.length, skippable: true },
    { offset: first.length + skip.length, bytes: second.length, skippable: false }
  ])
  expect(parsed.bytes).toBe(combined.length)
})

it('does not mistake a magic inside a block payload for a frame boundary', () => {
  // Why: this is the bug the parser replaces — scanning for magics finds the
  // 0x28B52FFD bytes inside compressed data and invents extra frames.
  const payload = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(32, 0x5a)])
  const first = buildFrame({ blocks: [{ size: payload.length, payload }] })
  const second = buildFrame({ blocks: [{ size: 1 }] })

  const parsed = parseZstdFrameSequence(Buffer.concat([first, second]))
  expect(parsed.frames).toHaveLength(2)
  expect(parsed.frames[0].bytes).toBe(first.length)
  expect(parsed.frames[1].offset).toBe(first.length)
})

it('reads an RLE block as one payload byte regardless of its declared size', () => {
  const frame = buildFrame({ blocks: [{ type: 1, size: 4096 }] })
  // Why: the declared size is the decompressed size; a parser that read that many
  // payload bytes would run past the end of this frame.
  expect(frame.length).toBeLessThan(4096)

  const parsed = parseZstdFrameSequence(frame)
  expect(parsed.truncated).toBe(false)
  expect(parsed.frames[0].bytes).toBe(frame.length)
})

it('stops honestly on corruption and names the offending byte', () => {
  const reserved = parseZstdFrameSequence(buildFrame({ blocks: [{ type: 3, size: 4 }] }))
  expect(reserved.frames).toEqual([])
  expect(reserved.truncated).toBe(true)
  expect(reserved.truncationReason).toMatch(/reserved block type/)
  // Descriptor + 1-byte content size put the first block header at byte 6.
  expect(reserved.truncationReason).toContain('byte 6')

  const truncatedPayload = buildFrame({ blocks: [{ size: 8 }] }).subarray(0, 6 + 3 + 4)
  const payloadParse = parseZstdFrameSequence(truncatedPayload)
  expect(payloadParse.truncated).toBe(true)
  expect(payloadParse.truncationReason).toContain('block at byte 6 runs past the end of the file')

  const withChecksum = buildFrame({ checksum: true, blocks: [{ size: 1 }] })
  expect(parseZstdFrameSequence(withChecksum).truncated).toBe(false)
  const cutChecksum = parseZstdFrameSequence(withChecksum.subarray(0, -1))
  expect(cutChecksum.truncated).toBe(true)
  expect(cutChecksum.truncationReason).toContain('content checksum')

  const shortHeader = parseZstdFrameSequence(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  expect(shortHeader.truncated).toBe(true)
  expect(shortHeader.truncationReason).toContain('truncated frame header')

  const trailing = parseZstdFrameSequence(Buffer.concat([buildFrame(), Buffer.from([0x01, 0x02])]))
  expect(trailing.truncated).toBe(true)
  expect(trailing.truncationReason).toContain('trailing 2 byte(s) at byte 9')

  const garbage = parseZstdFrameSequence(Buffer.from('this is not zstd\n'))
  expect(garbage.frames).toEqual([])
  expect(garbage.truncated).toBe(true)
  expect(garbage.truncationReason).toContain('no zstd frame magic')

  const reservedBit = parseZstdFrameSequence(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0b0000_1000]))
  expect(reservedBit.truncationReason).toContain('reserved frame header bit')

  const cutSkipHeader = parseZstdFrameSequence(skippableFrame(4).subarray(0, 4))
  expect(cutSkipHeader.truncationReason).toContain('truncated skippable frame header')
  const cutSkipPayload = parseZstdFrameSequence(skippableFrame(4).subarray(0, 8))
  expect(cutSkipPayload.truncationReason).toContain('skippable frame at byte 0 runs past the end')
})

it('treats an empty buffer as an empty file', () => {
  expect(parseZstdFrameSequence(Buffer.alloc(0))).toEqual({
    frames: [],
    bytes: 0,
    truncated: false,
    truncationReason: null
  })
})
