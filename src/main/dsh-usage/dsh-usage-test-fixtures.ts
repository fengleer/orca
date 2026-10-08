/**
 * Test fixtures for the DSH usage scanner.
 *
 * Why a frozen copy of `~/.dsh/sessions`: the machine's own DSH session is
 * appending usage records while the tests run, so a scanner pass and an
 * independent `zstd -dc` recount would otherwise read different bytes. Freezing
 * once per test process makes every comparison exact, and pointing `HOME` at the
 * frozen tree lets `research/dsh-cost-probe.mjs` read the same bytes it does.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as zlib from 'node:zlib'

/** Directory holding the module under test. */
export const MODULE_ROOT = import.meta.dirname
/** Repo checkout root (`fork/orca`). */
export const REPO_ROOT = resolve(MODULE_ROOT, '..', '..', '..')
export const REAL_SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** The multi-frame file the suite pins as ground truth: 429 lines / 127 frames. */
export const CANONICAL_LOG_PATH = join(
  REAL_SESSIONS_ROOT,
  '--Users-fengle-camsnap--',
  '629c8782-2764-4d82-8f6a-1c909dc3dcea',
  'session.v4.jsonl.zstd'
)

/**
 * Why pinned: only the `zstd -dc` cross-check in `zstd-multiframe.test.ts` spawns
 * the CLI, so every other assertion compares against these frozen counts.
 */
export const CANONICAL_LOG_LINES = 429
export const CANONICAL_LOG_FRAMES = 127

const VENDORED_PROBE_PATH = join(REPO_ROOT, 'research', 'dsh-cost-probe.mjs')

/**
 * The independently written reference probe, `research/dsh-cost-probe.mjs`.
 *
 * Why the candidates: the probe is not part of this repo, so accept an explicit
 * `$DSH_COST_PROBE_PATH` first, then a vendored `research/` copy, then the
 * porting workspace two levels above the checkout. The cross-check test skips
 * when none of them exists (CI has no workspace).
 */
export const COST_PROBE_PATH = resolveCostProbePath()

function resolveCostProbePath(): string {
  const candidates = [
    process.env.DSH_COST_PROBE_PATH,
    VENDORED_PROBE_PATH,
    resolve(REPO_ROOT, '..', '..', 'research', 'dsh-cost-probe.mjs')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate)) ?? VENDORED_PROBE_PATH
}

/** Absolute `zstd` path: PATH is not guaranteed under a test runner. */
export function resolveZstdPath(): string {
  if (process.env.DSH_ZSTD_PATH) {
    return process.env.DSH_ZSTD_PATH
  }
  const homebrew = '/opt/homebrew/bin/zstd'
  return existsSync(homebrew) ? homebrew : 'zstd'
}

function countSessionLogs(root: string): number {
  let count = 0
  const visit = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        visit(join(dir, entry.name))
      } else if (entry.name === 'session.v4.jsonl.zstd') {
        count++
      }
    }
  }
  visit(root)
  return count
}

let realSessionsAvailable: boolean | null = null

/** True when this machine has a `~/.dsh/sessions` tree holding at least one session log. */
export function hasRealSessions(): boolean {
  realSessionsAvailable ??= existsSync(REAL_SESSIONS_ROOT) && countSessionLogs(REAL_SESSIONS_ROOT) > 0
  return realSessionsAvailable
}

let zstdCliAvailable: boolean | null = null

/** True when the external `zstd` binary the CLI cross-checks shell out to is runnable. */
export function hasZstdCli(): boolean {
  if (zstdCliAvailable === null) {
    try {
      execFileSync(resolveZstdPath(), ['--version'], { stdio: 'ignore' })
      zstdCliAvailable = true
    } catch {
      zstdCliAvailable = false
    }
  }
  return zstdCliAvailable
}

type FrozenSessions = {
  /** Root passed to `createDshUsageScanner`. */
  sessionsRoot: string
  /** `HOME` for subprocesses that hardcode `~/.dsh/sessions`. */
  home: string
}

let frozen: FrozenSessions | null = null
let frozenBase: string | null = null
let cleanupRegistered = false

/** Why `os.tmpdir()`: a killed test run must not leave `frozen-*` copies inside the repo tree. */
async function tempBase(): Promise<string> {
  const base = join(tmpdir(), 'dsh-usage-tests')
  await mkdir(base, { recursive: true })
  return base
}

/** Copy the real session tree once per process and reuse it for every test. */
export async function getFrozenSessions(): Promise<FrozenSessions> {
  if (frozen) {
    return frozen
  }
  const base = await mkdtemp(join(await tempBase(), 'frozen-'))
  const home = join(base, 'home')
  const sessionsRoot = join(home, '.dsh', 'sessions')
  await cp(REAL_SESSIONS_ROOT, sessionsRoot, { recursive: true })
  frozen = { sessionsRoot, home }
  frozenBase = base
  if (!cleanupRegistered) {
    cleanupRegistered = true
    process.once('exit', () => {
      if (frozenBase) {
        rmSync(frozenBase, { recursive: true, force: true })
      }
    })
  }
  return frozen
}

/** A fresh empty directory for the missing/empty-root cases. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(await tempBase(), prefix))
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Local day key (`YYYY-MM-DD`) — deliberately re-implemented, not imported. */
export function localDayKey(timeMs: number): string {
  const at = new Date(timeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Whole-file `zstd -dc`, the CLI reference the decoder cross-check is made against. */
export function zstdCliDecode(filePath: string): string {
  return execFileSync(resolveZstdPath(), ['-dc', '--quiet', filePath], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8'
  })
}

export function zstdCliLineCount(filePath: string): number {
  return zstdCliDecode(filePath)
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

/** Frame count as reported by `zstd -lv`, parsed from its summary block. */
export function zstdCliFrameCount(filePath: string): number {
  const listing = execFileSync(resolveZstdPath(), ['-lv', filePath], { encoding: 'utf8' })
  const match = listing.match(/# Zstandard Frames:\s*(\d+)/)
  if (!match) {
    throw new Error(`could not read a frame count from zstd -lv for ${filePath}`)
  }
  return Number(match[1])
}

/** Compress one chunk of text into a standalone zstd frame, through Node's own binding. */
export function zstdFrameCompress(text: string): Buffer {
  return zlib.zstdCompressSync(text)
}
