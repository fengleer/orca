import { stat } from 'node:fs/promises'
import { listDshSessionFiles } from './session-file-discovery'
import { parseDshUsageLines, type DshUsageRecord } from './session-record-parser'
import { readDshSessionFile } from './zstd-multiframe'
import type { DshUsageScannerOptions, DshZstdDecoder } from './types'

const FILE_SCAN_BATCH_SIZE = 4

/**
 * Upper bound on memoized files.
 *
 * Why: parsed records hold every request a file ever logged, so an unbounded
 * cache would keep a multi-year corpus resident in the Electron main process.
 * Eviction only costs a re-decode on the next scan of that file.
 */
const DEFAULT_MAX_CACHED_FILES = 512

/**
 * Why setImmediate: decompressing a session log is synchronous CPU work on the
 * Electron main process, so scans yield between small batches instead of blocking
 * a whole refresh. Same reasoning as `claude-usage/scanner.ts`.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * One parsed session log.
 *
 * The cache key is `path + size + mtimeMs` (see `createScannerFileCache`), so an
 * unchanged file never reaches the decompressor twice.
 */
export type DshCachedFile = {
  path: string
  size: number
  mtimeMs: number
  frames: number
  decoder: DshZstdDecoder
  truncated: boolean
  skipped: boolean
  skipReason: string | null
  nonUsageLines: number
  unparsableLines: number
  records: DshUsageRecord[]
}

type DshFileStat = { size: number; mtimeMs: number }

/** Projection of one scan pass over the sessions root, reused files included. */
export type DshCollectedFiles = {
  cached: DshCachedFile[]
  discoveredFiles: number
  totalBytes: number
  reusedFiles: number
  decodedFiles: number
  decodedFrames: number
  decoders: DshZstdDecoder[]
  skippedFiles: number
}

export type DshScannerFileCache = {
  collectFiles: () => Promise<DshCollectedFiles>
  clear: () => void
}

export function createScannerFileCache(
  sessionsRoot: string,
  options: DshUsageScannerOptions
): DshScannerFileCache {
  const cache = new Map<string, DshCachedFile>()
  // Why: the cache key includes size+mtime, so a grown file leaves its old entry
  // behind; this index lets the next scan evict it instead of leaking memory.
  const cacheKeyByPath = new Map<string, string>()
  const maxCachedFiles = options.maxCachedFiles ?? DEFAULT_MAX_CACHED_FILES

  /**
   * Drop the oldest entries once the cache is over budget.
   *
   * Why insertion order: `Map` preserves it and `loadFile` re-inserts a file when
   * it is decoded again, so the front of the map is the least recently touched.
   */
  function evictOverflowingCacheEntries(): void {
    if (cache.size <= maxCachedFiles) {
      return
    }
    for (const key of cache.keys()) {
      if (cache.size <= maxCachedFiles) {
        break
      }
      const evicted = cache.get(key)
      cache.delete(key)
      if (evicted && cacheKeyByPath.get(evicted.path) === key) {
        cacheKeyByPath.delete(evicted.path)
      }
    }
  }

  const cacheKeyFor = (path: string, fileStat: DshFileStat): string =>
    `${path}\u0000${fileStat.size}\u0000${fileStat.mtimeMs}`

  async function statFile(path: string): Promise<DshFileStat | null> {
    try {
      const fileStat = await stat(path)
      return { size: fileStat.size, mtimeMs: fileStat.mtimeMs }
    } catch {
      // Why: a log deleted or truncated mid-scan must not fail the refresh.
      return null
    }
  }

  async function loadFile(path: string, fileStat: DshFileStat): Promise<DshCachedFile> {
    const read = await readDshSessionFile(path, {
      decoder: options.decoder,
      zstdPath: options.zstdPath,
      maxFileBytes: options.maxFileBytes
    })
    const parsed = read.skipped
      ? { records: [], nonUsageLines: 0, unparsableLines: 0 }
      : parseDshUsageLines(read.lines)
    return {
      path,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      frames: read.frames,
      decoder: read.decoder,
      truncated: read.truncated,
      skipped: read.skipped,
      skipReason: read.skipReason,
      nonUsageLines: parsed.nonUsageLines,
      unparsableLines: parsed.unparsableLines,
      records: parsed.records
    }
  }

  async function loadFiles(
    paths: string[],
    statByPath: Map<string, DshFileStat>
  ): Promise<Map<string, DshCachedFile>> {
    const loaded = new Map<string, DshCachedFile>()
    for (let index = 0; index < paths.length; index += FILE_SCAN_BATCH_SIZE) {
      const batch = paths.slice(index, index + FILE_SCAN_BATCH_SIZE)
      // Why: decompression is synchronous, so parallelism here is limited to the
      // async file read; the batch keeps memory bounded to a few logs at a time.
      const reads = await Promise.all(
        batch.map(async (path) => loadFile(path, statByPath.get(path)!))
      )
      for (const [batchIndex, cached] of reads.entries()) {
        loaded.set(batch[batchIndex], cached)
      }
      if (index + batch.length < paths.length) {
        await yieldToEventLoop()
      }
    }
    return loaded
  }

  async function collectFiles(): Promise<DshCollectedFiles> {
    const files = await listDshSessionFiles(sessionsRoot)
    const statByPath = new Map<string, DshFileStat>()
    const reused: DshCachedFile[] = []
    const pathsToLoad: string[] = []
    let totalBytes = 0
    let skippedFiles = 0

    for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
      const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
      const stats = await Promise.all(batch.map((path) => statFile(path)))
      for (const [batchIndex, fileStat] of stats.entries()) {
        const path = batch[batchIndex]
        if (!fileStat) {
          skippedFiles++
          continue
        }
        statByPath.set(path, fileStat)
        totalBytes += fileStat.size
        const key = cacheKeyFor(path, fileStat)
        const hit = cache.get(key)
        if (hit) {
          reused.push(hit)
          continue
        }
        const previousKey = cacheKeyByPath.get(path)
        if (previousKey && previousKey !== key) {
          cache.delete(previousKey)
        }
        pathsToLoad.push(path)
      }
      if (index + batch.length < files.length) {
        await yieldToEventLoop()
      }
    }

    const loaded = await loadFiles(pathsToLoad, statByPath)
    for (const [path, cached] of loaded) {
      cache.set(cacheKeyFor(path, cached), cached)
      cacheKeyByPath.set(path, cacheKeyFor(path, cached))
    }
    evictOverflowingCacheEntries()

    let decodedFrames = 0
    let unreadableFiles = 0
    const decoders = new Set<DshZstdDecoder>()
    for (const cached of loaded.values()) {
      decodedFrames += cached.frames
      decoders.add(cached.decoder)
      // Why: `stat` succeeds on a file we cannot read (mode 000, EIO), so that
      // failure only shows up here.
      if (cached.skipped) {
        unreadableFiles++
      }
    }

    return {
      cached: [...reused, ...loaded.values()],
      discoveredFiles: files.length,
      totalBytes,
      reusedFiles: reused.length,
      decodedFiles: loaded.size,
      decodedFrames,
      decoders: [...decoders].sort(),
      skippedFiles: skippedFiles + unreadableFiles
    }
  }

  return {
    collectFiles,
    clear: () => {
      cache.clear()
      cacheKeyByPath.clear()
    }
  }
}
