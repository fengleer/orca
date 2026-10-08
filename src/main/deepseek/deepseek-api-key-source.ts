import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * DeepSeek API key sources beyond the sealed store, in precedence order.
 *
 * Why fallbacks exist at all: the sealed store needs OS encryption, which a dev build or a
 * locked-down host may not have.
 *
 * Why the DSH credentials file is opt-in rather than ambient: `~/.dsh/.credentials.yaml` is
 * machine state, not Orca configuration. Reading it by default would make the provider look
 * configured on every developer machine that happens to hold a key — including inside unit
 * tests, which then issue real balance requests they never asked for.
 */

export const DEEPSEEK_DSH_CREDENTIALS_ENV = 'ORCA_DEEPSEEK_DSH_CREDENTIALS'

export type DeepSeekApiKeySource = 'env' | 'dsh-credentials'

export type DeepSeekApiKeyResolution = {
  apiKey: string | null
  source: DeepSeekApiKeySource | null
}

export function readDeepSeekEnvApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.DEEPSEEK_API_KEY?.trim()
  return key ? key : null
}

// Deliberately not a YAML parser: the file holds a handful of `KEY: value` lines, and a
// real parser would be the only reason to pull a dependency into the main process.
const DSH_CREDENTIAL_KEY_LINE = /^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?\s*$/m

export function readDshCredentialApiKey(
  path: string = join(homedir(), '.dsh', '.credentials.yaml')
): string | null {
  try {
    return DSH_CREDENTIAL_KEY_LINE.exec(readFileSync(path, 'utf8'))?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

export function resolveDeepSeekFallbackApiKey(
  env: NodeJS.ProcessEnv = process.env,
  options: { dshCredentialsPath?: string } = {}
): DeepSeekApiKeyResolution {
  const fromEnv = readDeepSeekEnvApiKey(env)
  if (fromEnv) {
    return { apiKey: fromEnv, source: 'env' }
  }
  const dshPath = options.dshCredentialsPath
  const dshEnabled =
    dshPath !== undefined || env[DEEPSEEK_DSH_CREDENTIALS_ENV]?.trim() === '1'
  if (!dshEnabled) {
    return { apiKey: null, source: null }
  }
  const fromDsh = readDshCredentialApiKey(dshPath)
  return fromDsh ? { apiKey: fromDsh, source: 'dsh-credentials' } : { apiKey: null, source: null }
}
