import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The only DSH session log name we read; DSH writes one per session directory. */
export const DSH_SESSION_LOG_FILENAME = 'session.v4.jsonl.zstd'

/**
 * Resolve the DSH sessions root.
 *
 * Precedence mirrors how the DSH CLI locates its own state: an explicit path, then
 * `$DSH_SESSIONS_ROOT`, then `$DSH_HOME/sessions`, then `~/.dsh/sessions`.
 */
export function resolveDshSessionsRoot(override?: string): string {
  if (override && override.trim()) {
    return override
  }
  const fromEnv = process.env.DSH_SESSIONS_ROOT
  if (fromEnv && fromEnv.trim()) {
    return fromEnv
  }
  const home = process.env.DSH_HOME
  if (home && home.trim()) {
    return join(home, 'sessions')
  }
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * List every session log under `sessionsRoot`.
 *
 * The layout is `<root>/<project-slug>/<session-id>/session.v4.jsonl.zstd`, but the
 * walk is a plain recursive descent so a deeper or shallower layout still works.
 * Unreadable directories are skipped rather than failing the scan, and the result
 * is sorted so two scans of the same tree produce byte-identical snapshots.
 */
export async function listDshSessionFiles(sessionsRoot: string): Promise<string[]> {
  const found: string[] = []
  await collectSessionFiles(sessionsRoot, found, 0)
  return found.sort((left, right) => left.localeCompare(right))
}

/** Guards against a symlink loop turning discovery into an infinite walk. */
const MAX_DISCOVERY_DEPTH = 8

async function collectSessionFiles(dir: string, found: string[], depth: number): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    return
  }
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Why: a missing root, a permission error and a path that is not a directory
    // all mean "nothing to scan" for a usage refresh.
    return
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSessionFiles(entryPath, found, depth + 1)
    } else if (entry.isFile() && entry.name === DSH_SESSION_LOG_FILENAME) {
      found.push(entryPath)
    }
  }
}
